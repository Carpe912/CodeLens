/**
 * AST 分析器 - 从 TypeScript/JavaScript 代码中提取结构化信息
 *
 * 本模块使用 ts-morph 解析源代码并提取：
 * - 字符串常量（URL、错误码、事件名等）
 * - URL 模式及其组成部分
 * - 函数及其签名
 * - 类和接口
 * - 导入/导出关系
 */

import { Project, SourceFile, Node, SyntaxKind, ts } from 'ts-morph';
import * as path from 'path';
import { URLResolver } from './url-resolver.js';
import type {
  EntityResult,
  StringConstant,
  URLPattern,
  URLComponent,
  FunctionInfo,
  ParameterInfo,
  ClassInfo,
  PropertyInfo,
  ImportInfo,
  URLProvider,
  IndirectCallSite,
} from '../types.js';
//
// ⚠️ 下面这些类型（StringConstant / URLPattern / FunctionInfo / ClassInfo / ImportInfo …）
// 原本定义在本文件里，但**逐字段都是业务概念**、没有一个字段提到 TypeScript 语法，
// 所以上提到 `languages/types.ts` 作为语言无关的输出契约 ——
// 这就是「Java 适配器只需要产出同样结构」的接口依据。
//
// 本文件保留的只有 ts-morph 实现细节（SyntaxKind 遍历、Node 操作）。

// ============================================
// 入库闸门：字符串常量的体积上限
// ============================================

/**
 * 单个字符串常量的**字节**上限，超过则不入库。
 *
 * ============================================================
 * 为什么是「跳过」而不是「截断」
 * ============================================================
 * 硬约束来自 `idx_string_constants_unique` —— 它是 **btree** 索引
 * `(repo_id, file_id, string_value, line_start)`，而 PostgreSQL 的 btree
 * **单条索引项上限约 2704 字节**（8 KB 页扣掉页头/行指针后每页可用的 1/3），
 * 多列合计的报错阈值是 8191 字节。超限的报错长这样：
 *
 *   `index row requires 8520 bytes, maximum size is 8191`
 *
 * 而这条 INSERT 在 `storeEntities` 的**事务**里 ⇒ 一个超长字面量会让该文件的
 * `string_constants` / `functions` / `classes` **一起回滚**。
 * 2026-09-19 实测：repo 33 的 `web/open/index.js`（打包产物，内含 8 KB 数据 blob）
 * 就是这样把整份文件从实体层抹掉的。
 *
 * 截断是**更坏**的选择：被截断的常量会留下一个看起来合法的假值，
 * 之后「这个错误码是什么」会答出一段截断的乱码 —— 比查不到更危险。
 * 而这些值本身也不是「字符串常量」（是内联 base64 / 打包数据），
 * 真正的 API 路径、错误码、事件名都在几十字节量级。
 *
 * ⚠️ 判据必须是**字节**不是字符数：本仓中文注释 3 字节/字符，
 * 「2000 字符」的中文字符串是 6000 字节，照样撑爆索引。
 * 留 2000 字节余量（btree 约 2704）是为了容纳多列合计的零头。
 */
const MAX_STRING_CONSTANT_BYTES = 2_000;

/**
 * 该字符串常量是否可以安全入 `string_constants`。
 *
 * 判据见 `MAX_STRING_CONSTANT_BYTES` 的长注释。抽成函数是为了让三个抽取点
 * （变量声明 / 对象属性 / 枚举成员）用**同一句话**表达同一个约束。
 */
export function isIndexableStringConstant(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MAX_STRING_CONSTANT_BYTES;
}

/**
 * MIME 类型判据：`text/csv`、`application/json;charset=utf-8`、`image/svg+xml`。
 *
 * 这类字符串**含 `/`**，能通过「多段路径」这条粗筛，但它们绝不是接口路径。
 * 实测（repo 33，386 行 url_patterns）其中 19 行是前端的「文件类型 → MIME」映射表
 * 被当成「路径表」收了进来，全部 method 为 NULL —— 属于静默混入的噪声。
 *
 * 只匹配「主类型/子类型」这一完整形态，不会误伤 `/application/detail` 这类真实路径
 * （后者以 `/` 开头，首字符就不是字母）。
 */
const MIME_TYPE_RE = /^(text|application|image|font|audio|video|multipart|message|model|example)\/[a-z0-9.+-]+(\s*;|$)/i;

// ============================================
// AST 分析器类
// ============================================

/**
 * AST 分析器
 *
 * 使用 ts-morph 解析 TypeScript/JavaScript 代码，提取结构化信息。
 */
export class ASTAnalyzer {
  private project: Project;

  /**
   * URL 解析器（跨文件符号表）
   *
   * 单独开一个 ts-morph Project 存放**整个仓库**的源码：`analyzeFile` 是逐文件
   * 调用且分析完就 `removeSourceFile`，符号表若寄生在那个 project 上会被反复清空，
   * 跨文件常量（`API_PREFIX` 定义在 config 里、用在 service 里）就永远查不到。
   */
  private resolverProject: Project | null = null;
  private resolver: URLResolver | null = null;
  /** provider（路径表/路径构造函数）按文件分组，供逐文件分析时取用 */
  private providersByFile = new Map<string, URLProvider[]>();
  /** 跨过程落点（间接调用 / 模板句柄）按文件分组 */
  private indirectByFile = new Map<string, IndirectCallSite[]>();

  constructor() {
    // 初始化 ts-morph 项目
    this.project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.Latest,    // 使用最新的 ECMAScript 目标
        module: ts.ModuleKind.CommonJS,    // 使用 CommonJS 模块系统
        allowJs: true,                     // 允许解析 JavaScript 文件
        checkJs: false,                    // 不进行类型检查
        noEmit: true,                      // 不生成输出文件
      },
      skipAddingFilesFromTsConfig: true,   // 跳过从 tsconfig.json 加载文件
    });
  }

  /**
   * 登记整个仓库的源码，建立跨文件符号表。
   *
   * **必须在任何 `analyzeFile` 之前调用**（`EnhancedIndexer.indexFiles` 已接入）。
   * 不调用时一切退回旧行为（标识符 → `${name}` 占位符），不会报错。
   *
   * @param files - 仓库全部源码文件（路径 + 内容）
   */
  registerRepoFiles(files: Array<{ path: string; content: string }>): void {
    if (files.length === 0) return;
    this.resolverProject = new Project({
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.CommonJS, allowJs: true, checkJs: false, noEmit: true },
      skipAddingFilesFromTsConfig: true,
    });
    this.resolver = new URLResolver(this.resolverProject);
    this.resolver.registerFiles(files);

    // provider 一次性全量扫描（与逐文件分析无关），再按文件分桶
    this.providersByFile.clear();
    for (const p of this.resolver.collectProviders()) {
      const list = this.providersByFile.get(p.file);
      if (list) list.push(p);
      else this.providersByFile.set(p.file, [p]);
    }

    // 跨过程落点同样一次性全量扫描后按文件分桶。
    // 必须在整仓源码都在手时做 —— 「这个方法最终请求哪个 URL」是跨文件的判断。
    this.indirectByFile.clear();
    let indirectTotal = 0;
    for (const s of this.resolver.collectIndirectSites()) {
      const list = this.indirectByFile.get(s.file);
      if (list) list.push(s);
      else this.indirectByFile.set(s.file, [s]);
      indirectTotal++;
    }

    console.log(
      `[AST] 跨文件符号表已建立：${files.length} 个文件，` +
      `${[...this.providersByFile.values()].reduce((n, l) => n + l.length, 0)} 个路径提供点，` +
      `${indirectTotal} 个跨过程落点`
    );
  }

  /** 释放符号表（索引结束后调用，避免整仓源码常驻内存） */
  releaseRepoFiles(): void {
    this.resolver = null;
    this.resolverProject = null;
    this.providersByFile.clear();
    this.indirectByFile.clear();
  }

  /** provider 总数（自检/统计用） */
  get providerTotal(): number {
    let n = 0;
    for (const list of this.providersByFile.values()) n += list.length;
    return n;
  }

  /**
   * 分析源文件并提取所有结构化信息
   *
   * 执行流程：
   * 1. 创建源文件对象
   * 2. 提取导入关系（用于依赖追踪）
   * 3. 提取字符串常量
   * 4. 从常量中提取 URL 模式
   * 5. 提取函数信息
   * 6. 提取类信息
   * 7. 清理资源避免内存泄漏
   *
   * @param filePath - 文件路径
   * @param content - 文件内容
   * @returns AST 分析结果
   */
  /**
   * 「按路径派生」的两类产出。
   *
   * 这两项**只与 filePath 有关、与 content 无关**（都是在整仓符号表建立时一次性算好、
   * 按文件分桶的）：
   * - `indirectSites`：跨过程 URL 落点
   * - `urlPatterns`：路径**提供点**（路径表 / 返回路径的构造函数）
   *
   * 之所以单独抽出来：一个 `.vue` 文件会被拆成多个 script 块分别调用 `analyzeFile`，
   * 若每块都取一次，这两项就会**重复落库**（`url_patterns` 的不变式是「一个接口一行」）。
   * 调用方约定：多块场景**只在第 0 块取**，其余块传 `skipPathDerived`。
   */
  pathDerivedFor(filePath: string): {
    indirectSites: IndirectCallSite[];
    urlPatterns: URLPattern[];
  } {
    return {
      indirectSites: this.indirectByFile.get(filePath) ?? [],
      urlPatterns: this.buildProviderPatterns(filePath),
    };
  }

  /**
   * 分析单个源文件，产出结构化实体。
   *
   * @param filePath - 文件在仓库内的相对路径。**这是查表/求值的键**：
   *   `indirectByFile` 按它取跨过程落点，`resolveURLPattern` 以它解析相对 import，
   *   `providersByFile` 按它分桶。**不要为了绕开解析器缺陷而改它。**
   * @param content - 交给解析器的源码文本
   * @param options.tsFileName - 交给 ts-morph 建 SourceFile 的**文件名**，默认同 `filePath`。
   *   ⚠️ 与 `filePath` 分开是必要的：ts-morph 按扩展名决定文件如何进入语言服务，
   *   `.vue` 这类扩展名会让 `getReturnType()` 抛异常（见 `extractFunctionInfo` 注释），
   *   而 `filePath` 又必须保持真实 —— 换成假名会静默丢掉上面那些路径相关产出。
   * @param options.skipPathDerived - 跳过「按路径派生」的两项产出（见 `pathDerivedFor`）。
   *   多 script 块场景**只有第 0 块**应为 false。
   */
  async analyzeFile(
    filePath: string,
    content: string,
    options?: { tsFileName?: string; skipPathDerived?: boolean }
  ): Promise<EntityResult> {
    // ⚠️ 只有这里用「交给 ts-morph 的名字」；下面所有 filePath 都保持真实路径。
    const tsFileName = options?.tsFileName ?? filePath;
    const sourceFile = this.project.createSourceFile(tsFileName, content, { overwrite: true });

    const result: EntityResult = {
      stringConstants: [],
      urlPatterns: [],
      functions: [],
      classes: [],
      imports: [],
      indirectSites: options?.skipPathDerived ? [] : this.pathDerivedFor(filePath).indirectSites,
    };

    try {
      // 步骤 1: 提取导入关系（用于依赖追踪）
      result.imports = this.extractImports(sourceFile);

      // 步骤 2: 提取字符串常量
      result.stringConstants = this.extractStringConstants(sourceFile);

      // 步骤 3: 从常量中提取 URL 模式
      // 若已 registerRepoFiles，标识符/工厂函数会被解析成真实路径；
      // 否则与历史行为一致（产出 `${name}` 占位符）
      result.urlPatterns = this.extractURLPatterns(result.stringConstants, sourceFile, filePath);

      // 步骤 3b: 补上「路径构造处」本身（路径表 / 路径构造函数）
      //
      // 为什么需要：`config/apiConfig.js` 里的 `ApiPaths` 只是路径表，全文件没有
      // 一个 HTTP 调用，过去的抽取只看调用点，于是它产生 0 条记录 ——
      // 「搜 /api/v1/users/:userId/profile 找不到它定义在哪」正是这么来的。
      //
      // ⚠️ 这一项与 content 无关（按 filePath 分桶），多 script 块时必须只取一次。
      if (!options?.skipPathDerived) {
        result.urlPatterns.push(...this.pathDerivedFor(filePath).urlPatterns);
      }

      // 步骤 4: 提取函数信息
      result.functions = this.extractFunctions(sourceFile);

      // 步骤 5: 提取类信息
      result.classes = this.extractClasses(sourceFile);
    } catch (error) {
      console.error(`Error analyzing file ${filePath}:`, error);
    } finally {
      // 清理资源避免内存泄漏
      this.project.removeSourceFile(sourceFile);
    }

    return result;
  }

  /**
   * 提取所有字符串常量
   *
   * 从源文件中提取三种类型的字符串常量：
   * 1. 变量声明：const API_URL = "https://api.example.com"
   * 2. 对象属性：{ endpoint: "/api/users" }
   * 3. 枚举成员：enum Status { SUCCESS = "success" }
   *
   * 每个常量都会被自动分类（url_segment、error_code 等）。
   *
   * @param sourceFile - 源文件对象
   * @returns 字符串常量数组
   */
  private extractStringConstants(sourceFile: SourceFile): StringConstant[] {
    const constants: StringConstant[] = [];

    /** 因超过 `MAX_STRING_CONSTANT_BYTES` 而未入库的常量数（末尾汇总上报） */
    let oversizedDropped = 0;

    // 类型 1: 查找所有带字符串值的变量声明
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((varDecl) => {
      const initializer = varDecl.getInitializer();
      if (!initializer) return;

      // 提取字符串值
      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;
      if (!isIndexableStringConstant(stringValue)) {
        oversizedDropped++;
        return;
      }

      // 检查是否被导出
      const varStatement = varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      const isExported = varStatement?.isExported() || false;

      constants.push({
        symbolName: varDecl.getName(),
        stringValue,
        constantType: this.inferConstantType(stringValue),  // 自动推断类型
        lineStart: varDecl.getStartLineNumber(),
        lineEnd: varDecl.getEndLineNumber(),
        exportType: isExported ? 'named' : 'none',
        code: varDecl.getText(),
      });
    });

    // 类型 2: 查找对象字面量中的所有属性赋值
    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((propAssign) => {
      const initializer = propAssign.getInitializer();
      if (!initializer) return;

      // 提取字符串值
      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;
      if (!isIndexableStringConstant(stringValue)) {
        oversizedDropped++;
        return;
      }

      // 获取父对象信息
      const objectLiteral = propAssign.getFirstAncestorByKind(SyntaxKind.ObjectLiteralExpression);
      const parentVar = objectLiteral?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

      constants.push({
        symbolName: propAssign.getName(),
        stringValue,
        constantType: this.inferConstantType(stringValue),
        lineStart: propAssign.getStartLineNumber(),
        lineEnd: propAssign.getEndLineNumber(),
        parentObject: parentVar?.getName(),  // 记录父对象名称
        exportType: 'none',
        code: propAssign.getText(),
      });
    });

    // 类型 3: 查找枚举成员
    sourceFile.getDescendantsOfKind(SyntaxKind.EnumMember).forEach((enumMember) => {
      const initializer = enumMember.getInitializer();
      if (!initializer) return;

      // 提取字符串值
      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;
      if (!isIndexableStringConstant(stringValue)) {
        oversizedDropped++;
        return;
      }

      // 获取枚举声明信息
      const enumDecl = enumMember.getFirstAncestorByKind(SyntaxKind.EnumDeclaration);

      constants.push({
        symbolName: enumMember.getName(),
        stringValue,
        constantType: 'enum_value',  // 枚举值固定类型
        lineStart: enumMember.getStartLineNumber(),
        lineEnd: enumMember.getEndLineNumber(),
        parentObject: enumDecl?.getName(),  // 记录枚举名称
        exportType: enumDecl?.isExported() ? 'named' : 'none',
        code: enumMember.getText(),
      });
    });

    if (oversizedDropped > 0) {
      // 预期行为（打包产物里的数据 blob），但必须可见 —— 否则又是一个
      // 「文件在库里、内容莫名其妙少了一段」的无解谜题。
      console.log(
        `[ASTAnalyzer] ${sourceFile.getFilePath()}：${oversizedDropped} 个字符串常量超过 ` +
          `${MAX_STRING_CONSTANT_BYTES} 字节，未入库（btree 唯一索引单条上限约 2704 字节）`
      );
    }

    return constants;
  }

  /**
   * 从各种节点类型中提取字符串值
   *
   * 支持的节点类型：
   * - 字符串字面量：'hello' 或 "hello"
   * - 模板字面量：`hello ${world}`
   * - 标识符：引用其他常量
   *
   * @param node - AST 节点
   * @returns 字符串值，如果不是字符串则返回 null
   */
  private extractStringValue(node: Node): string | null {
    // 情况 1: 字符串字面量
    if (Node.isStringLiteral(node)) {
      return node.getLiteralValue();
    }

    // 情况 2: 不含表达式的模板字面量
    if (Node.isNoSubstitutionTemplateLiteral(node)) {
      return node.getLiteralValue();
    }

    // 情况 3: 含表达式的模板字面量（尝试提取模式）
    if (Node.isTemplateExpression(node)) {
      return this.extractTemplatePattern(node);
    }

    // 情况 4: 二元表达式（字符串拼接）
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const left = this.extractStringValue(node.getLeft());
      const right = this.extractStringValue(node.getRight());
      if (left && right) {
        return left + right;  // 拼接两个字符串
      }
      if (left) return left;
      if (right) return right;
    }

    return null;
  }

  /**
   * 从模板字面量中提取模式
   *
   * 将模板字面量转换为模式字符串，保留变量占位符。
   * 例如：`/api/${userId}/posts` → "/api/${userId}/posts"
   *
   * @param node - 模板表达式节点
   * @returns 模式字符串
   */
  private extractTemplatePattern(node: Node): string {
    if (!Node.isTemplateExpression(node)) return '';

    // 提取模板头部
    const head = node.getHead();
    let pattern = Node.isTemplateHead(head) ? head.getLiteralText() : '';

    // 遍历模板片段
    node.getTemplateSpans().forEach((span) => {
      const expr = span.getExpression();

      // 尝试解析表达式
      if (Node.isIdentifier(expr)) {
        // 保留标识符名称
        pattern += `\${${expr.getText()}}`;
      } else {
        // 复杂表达式用占位符表示
        pattern += '${...}';
      }

      // 添加字面量部分
      const literal = span.getLiteral();
      if (Node.isTemplateMiddle(literal) || Node.isTemplateTail(literal)) {
        pattern += literal.getLiteralText();
      }
    });

    return pattern;
  }

  /**
   * 推断字符串常量的类型
   *
   * 基于字符串的模式自动分类：
   * - url_segment: 以 http:// 或 / 开头
   * - error_code: E + 数字格式（如 E404）
   * - event_name: 包含冒号（如 user:login）
   * - css_class: 以 . 或 - 开头
   * - env_var: 全大写加下划线（如 API_KEY）
   * - api_path: 以 / 开头的路径（如 /api/users）
   * - string: 默认类型
   *
   * @param value - 字符串值
   * @returns 常量类型
   */
  private inferConstantType(value: string): string {
    // URL 片段
    if (value.match(/^(https?:\/\/|\/[a-z])/i)) {
      return 'url_segment';
    }

    // 错误码
    if (value.match(/^E\d+$/)) {
      return 'error_code';
    }

    // 事件名称（包含冒号）
    if (value.includes(':')) {
      return 'event_name';
    }

    // CSS 类名（以点或横线开头）
    if (value.match(/^[\.\-]/)) {
      return 'css_class';
    }

    // 环境变量（全大写加下划线）
    if (value.match(/^[A-Z_]+$/)) {
      return 'env_var';
    }

    // API 路径片段
    if (value.match(/^\/[a-z0-9\-_\/]+$/i)) {
      return 'api_path';
    }

    return 'string';
  }

  /**
   * 从字符串常量中提取 URL 模式
   *
   * 分析字符串常量，识别 URL 模式并提取其组成部分。
   * 支持识别：
   * - HTTP 请求（axios、fetch 等）
   * - 路由定义（Express、Koa 等）
   * - URL 模板字符串
   *
   * @param constants - 字符串常量数组
   * @param sourceFile - 源文件对象
   * @returns URL 模式数组
   */
  private extractURLPatterns(constants: StringConstant[], sourceFile: SourceFile, filePath = ''): URLPattern[] {
    const patterns: URLPattern[] = [];

    // 查找 axios/fetch 调用
    // 遍历所有函数调用表达式，识别 HTTP 请求调用
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
      const expr = callExpr.getExpression();
      const exprText = expr.getText();

      // 检查是否为 HTTP 调用（更严格的匹配）
      // 排除 Cypress 命令（cy.get、cy.post 等）
      // Cypress 是测试框架，其命令不是真正的 HTTP 请求
      if (exprText.startsWith('cy.')) return;

      // 检查 axios/fetch 模式
      // axios 是流行的 HTTP 客户端库
      //
      // ⚠️ `getText()` 保留**原始空白与大小写**：`axios\n    .delete(url)` 与
      // `Axios.get(url)` 都是真实调用，但前者不含 `'axios.'` 子串、后者大小写不符。
      // 规范化后再判，否则这两个真实客户端会被当成普通方法调用 —— 它们以 `${url}`
      // 形态出现的落点会被当作噪声丢掉（实测 repo 33 丢了 4 个真实 axios 落点）。
      const normalizedExpr = exprText.replace(/\s+/g, '').toLowerCase();
      const isAxiosCall = normalizedExpr.includes('axios');
      // fetch 是原生的 HTTP API
      const isFetchCall = normalizedExpr === 'fetch' || normalizedExpr.endsWith('.fetch');

      // 检查 HTTP 方法调用（必须是属性访问，而不仅仅是子字符串）
      // 识别常见的 HTTP 方法：GET、POST、PUT、DELETE、PATCH
      const httpMethods = ['get', 'post', 'put', 'delete', 'patch'];
      const isHttpMethodCall = httpMethods.some((method) => {
        // 匹配模式如：axios.get、client.post、api.delete 等
        return exprText.endsWith(`.${method}`) || exprText === method;
      });

      // 判断是否为 HTTP 调用
      const isHttpCall = isAxiosCall || isFetchCall || isHttpMethodCall;
      if (!isHttpCall) return;

      // 提取 URL 参数
      // HTTP 调用的第一个参数通常是 URL
      const args = callExpr.getArguments();
      if (args.length === 0) return;

      const urlArg = args[0];
      // `trusted` = 已由 axios / fetch 这两个**明确的 HTTP 客户端**确证。
      // 只靠 `.get/.post/.delete` 后缀判定是不够的：`this._map.delete(name)`、
      // `running.delete(context)` 同样满足后缀条件，它们会把 `${name}` 之类
      // 纯占位符灌进 url_patterns。故只有 trusted 时才容忍纯占位符形态。
      const trusted = isAxiosCall || isFetchCall;
      const urlPattern = this.resolveURLPattern(urlArg, filePath, callExpr.getStartLineNumber(), trusted);

      if (urlPattern) {
        console.log(`[AST] Extracted URL pattern: ${urlPattern.pattern} at line ${callExpr.getStartLineNumber()}`);
        patterns.push({
          pattern: urlPattern.pattern, // 原始 URL 模式
          normalizedPattern: this.normalizeURLPattern(urlPattern.pattern), // 标准化后的 URL 模式
          method: this.extractHTTPMethod(exprText), // HTTP 方法
          components: urlPattern.components, // URL 组成部分
          pathParams: urlPattern.pathParams, // 路径参数
          queryParams: urlPattern.queryParams, // 查询参数
          definitionLine: callExpr.getStartLineNumber(), // 定义所在行号
          definitionCode: callExpr.getText().slice(0, 200), // 限制长度，避免过长的代码
        });
      } else {
        console.log(`[AST] Failed to extract URL from ${exprText} at line ${callExpr.getStartLineNumber()}, arg kind: ${urlArg.getKindName()}`);
      }
    });

    // 查找路由定义（Express、Fastify 等）
    // 识别服务端路由定义，如 app.get('/users', ...)
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
      const expr = callExpr.getExpression();

      // 检查是否为属性访问表达式（如 app.get）
      if (Node.isPropertyAccessExpression(expr)) {
        const methodName = expr.getName();
        const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'all'];

        // 如果方法名是 HTTP 方法之一
        if (httpMethods.includes(methodName)) {
          const args = callExpr.getArguments();
          if (args.length >= 1) {
            const routeArg = args[0]; // 第一个参数是路由路径

            // 路由注册的第一个实参**必须是字面量路径**（`/users`、`/users/${id}`）。
            // 少了这一句，块里只按属性名匹配 `.get/.post/.delete/.all`，
            // 于是 `refs.map.get(id)`、`set.delete(id)`、`Promise.all([...])`
            // 都会被当成路由注册，以 `:id` / `${promise}` 之类形态污染 url_patterns
            // （实测 repo 33 里这类噪声占 69 行）。
            const isLiteralRoutePath =
              Node.isStringLiteral(routeArg) ||
              Node.isNoSubstitutionTemplateLiteral(routeArg) ||
              Node.isTemplateExpression(routeArg);
            if (!isLiteralRoutePath) return;

            const urlPattern = this.resolveURLPattern(routeArg, filePath, callExpr.getStartLineNumber());

            if (urlPattern) {
              patterns.push({
                pattern: urlPattern.pattern,
                normalizedPattern: this.normalizeURLPattern(urlPattern.pattern),
                method: methodName.toUpperCase(), // 转换为大写的 HTTP 方法
                components: urlPattern.components,
                pathParams: urlPattern.pathParams,
                queryParams: urlPattern.queryParams,
                definitionLine: callExpr.getStartLineNumber(),
                definitionCode: callExpr.getText().slice(0, 200),
              });
            }
          }
        }
      }
    });

    return patterns;
  }

  /**
   * 解析一个 HTTP 调用/路由注册的 URL 实参。
   *
   * 顺序：
   * 1. 跨文件符号表（URLResolver）——把 `ApiPaths.users.list()`,
   *    `` `${API_PREFIX}/users/${id}` `` 这类表达式算成真实路径；
   * 2. 退回旧实现 `extractURLFromExpression`——保证未接入符号表时行为不变。
   *
   * 最后统一过一遍 `acceptURL`：两者都不是路径就返回 null。
   * 这一道过滤很关键，旧实现会把 `ldap.get(userKey)` 这类同名方法调用也
   * 收成 `${userKey}`，在 url_patterns 里堆出一批永远匹配不上的噪声行。
   */
  private resolveURLPattern(
    node: Node,
    filePath: string,
    line: number,
    trusted = false
  ): { pattern: string; components: URLComponent[]; pathParams: string[]; queryParams: string[] } | null {
    // ① 跨文件符号表
    const resolved = this.resolver ? this.resolver.resolveCallArg(filePath, line, 0) : null;
    if (resolved && this.acceptURL(resolved, trusted)) {
      const pathParams: string[] = [];
      const components = this.splitComponents(resolved, pathParams);
      this.extractParamsFromPattern(resolved, pathParams);
      return { pattern: resolved, components, pathParams, queryParams: [] };
    }

    // ② 旧实现兜底
    const legacy = this.extractURLFromExpression(node);
    if (!legacy) return null;
    return this.acceptURL(legacy.pattern, trusted) ? legacy : null;
  }

  /** 该字符串是否值得作为 URL 模式入库 */
  private acceptURL(value: string | null | undefined, trusted = false): boolean {
    if (!value) return false;
    const s = value.trim();
    if (!s) return false;

    // MIME 类型含 `/`，却绝不是接口路径（text/csv、application/json;charset=utf-8）。
    // 放行它们会让「文件类型映射表」被当成「路径表」收进 url_patterns。
    if (MIME_TYPE_RE.test(s)) return false;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true; // 带协议
    if (s.includes('/')) return true;                     // 多段路径
    // 纯占位符（去掉了 ${...} 就什么都不剩，如 `${name}`）**只有**在调用点已确证
    // 是 HTTP 客户端调用时才保留 —— 真实项目里 `${url}` 确实存在（路径由变量传入）。
    // 对未确证的调用点一律拒绝，否则 `this._map.delete(name)`、`Promise.all(promise)`
    // 会分别以 `${name}` / `${promise}` 入库，堆成永远匹配不上的噪声行。
    if (trusted && /\$\{[^}]*\}/.test(s)) return true;
    return false;
  }

  /** 把一个已解析的字符串拆成 literal/variable 组件（与模板分支口径一致） */
  private splitComponents(value: string, pathParams: string[]): URLComponent[] {
    const out: URLComponent[] = [];
    const re = /\$\{([^}]*)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      if (m.index > last) out.push({ type: 'literal', value: value.slice(last, m.index) });
      out.push({ type: 'variable', value: m[1] });
      if (/^[A-Za-z_$][\w$]*$/.test(m[1].trim())) pathParams.push(m[1].trim());
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push({ type: 'literal', value: value.slice(last) });
    if (out.length === 0) out.push({ type: 'literal', value });
    return out;
  }

  /**
   * 把某文件的「路径提供点」转成 URL 模式行。
   *
   * 提供点 = 路径表叶子取值（`ApiPaths.users.list: () => '/api/v1/users'`）
   *        或函数 return 出来的路径（`buildApiPath()`）。
   * 这些位置没有 HTTP 调用，却正是「这个接口是这么拼出来的」的答案。
   */
  private buildProviderPatterns(filePath: string): URLPattern[] {
    const providers = this.providersByFile.get(filePath);
    if (!providers || providers.length === 0) return [];

    const out: URLPattern[] = [];
    const seen = new Set<string>();
    let mimeDropped = 0;
    for (const p of providers) {
      const normalizedPattern = this.normalizeURLPattern(p.value);
      if (!normalizedPattern) continue;
      // 路径提供点里会混进「文件类型 → MIME」映射表的取值（`text/csv`、
      // `application/json;charset=utf-8`）。它们含 `/`，形态上与路径无法区分，
      // 但语义上绝不是接口 —— 不挡这一道，整张映射表会被当成路径表入库
      // （实测 repo 33 因此多出 19 行 method 为 NULL 的假接口）。
      if (MIME_TYPE_RE.test(p.value)) {
        mimeDropped++;
        continue;
      }
      const key = `\u0000${normalizedPattern}`;
      if (seen.has(key)) continue; // 同一文件内同路径只留一条（provider 之间会重叠）
      seen.add(key);

      const pathParams: string[] = [];
      const components = this.splitComponents(p.value, pathParams);
      this.extractParamsFromPattern(p.value, pathParams);
      out.push({
        pattern: p.value,
        normalizedPattern,
        method: undefined,
        components,
        pathParams,
        queryParams: [],
        definitionLine: p.line,
        definitionCode: p.code,
      });
    }
    if (mimeDropped > 0) {
      console.log(`[URL] ${filePath}: 丢弃 ${mimeDropped} 条 MIME 形态的「路径提供点」（非接口）`);
    }
    return out;
  }

  /**
   * 从表达式中提取 URL 模式
   *
   * 递归解析各种类型的表达式，提取 URL 模式及其组成部分。
   * 支持的表达式类型：
   * - 字符串字面量：'/api/users'
   * - 模板字符串：`/api/users/${id}`
   * - 二元表达式：baseUrl + '/users'
   * - 标识符：urlVariable
   *
   * @param node - AST 节点
   * @returns URL 模式信息对象，包含模式、组件、参数等；如果无法提取则返回 null
   */
  private extractURLFromExpression(node: Node): {
    pattern: string;
    components: URLComponent[];
    pathParams: string[];
    queryParams: string[];
  } | null {
    const components: URLComponent[] = [];
    const pathParams: string[] = [];
    const queryParams: string[] = [];

    // 字符串字面量
    // 例如：'/api/users' 或 "/api/users/:id"
    if (Node.isStringLiteral(node)) {
      const value = node.getLiteralValue();
      components.push({ type: 'literal', value });
      // 从模式中提取路径参数（如 :id、{id}）
      this.extractParamsFromPattern(value, pathParams);
      return { pattern: value, components, pathParams, queryParams };
    }

    // 模板字符串
    // 例如：`/api/users/${userId}/posts/${postId}`
    if (Node.isTemplateExpression(node)) {
      let pattern = '';

      // 处理模板字符串的头部（第一个静态部分）
      const head = node.getHead();
      const headText = Node.isTemplateHead(head) ? head.getLiteralText() : '';
      pattern += headText;
      components.push({ type: 'literal', value: headText });

      // 处理模板字符串的各个片段（变量 + 静态文本）
      node.getTemplateSpans().forEach((span) => {
        // 提取变量表达式
        const expr = span.getExpression();
        const exprText = expr.getText();

        // 将变量添加到模式中
        pattern += `\${${exprText}}`;
        components.push({ type: 'variable', value: exprText });
        pathParams.push(exprText);

        // 提取变量后的静态文本
        const literal = span.getLiteral();
        let literalText = '';
        if (Node.isTemplateMiddle(literal) || Node.isTemplateTail(literal)) {
          literalText = literal.getLiteralText();
        }
        pattern += literalText;
        if (literalText) {
          components.push({ type: 'literal', value: literalText });
        }
      });

      return { pattern, components, pathParams, queryParams };
    }

    // 二元表达式（字符串拼接）
    // 例如：baseUrl + '/users' + '/' + userId
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      // 递归提取左右两侧的 URL 模式
      const left = this.extractURLFromExpression(node.getLeft());
      const right = this.extractURLFromExpression(node.getRight());

      // 合并左右两侧的结果
      if (left && right) {
        return {
          pattern: left.pattern + right.pattern,
          components: [...left.components, ...right.components],
          pathParams: [...left.pathParams, ...right.pathParams],
          queryParams: [...left.queryParams, ...right.queryParams],
        };
      }
    }

    // 标识符（变量引用）
    // 例如：const url = apiEndpoint; fetch(url)
    if (Node.isIdentifier(node)) {
      const name = node.getText();
      components.push({ type: 'variable', value: name });
      return { pattern: `\${${name}}`, components, pathParams: [name], queryParams };
    }

    return null;
  }

  /**
   * 从 URL 模式中提取路径参数
   *
   * 识别并提取 URL 模式中的路径参数，支持多种参数格式：
   * - Express 风格：/users/:id/:name
   * - 花括号风格：/users/{id}/{name}
   *
   * @param pattern - URL 模式字符串
   * @param params - 用于存储提取的参数名的数组（会被修改）
   */
  private extractParamsFromPattern(pattern: string, params: string[]): void {
    // Express 风格的参数：/users/:id
    // 匹配以冒号开头的参数名
    const expressParams = pattern.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (expressParams) {
      // 移除冒号前缀，只保留参数名
      expressParams.forEach((param) => params.push(param.slice(1)));
    }

    // 花括号风格的参数：/users/{id}
    // 常见于 OpenAPI/Swagger 规范
    const braceParams = pattern.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
    if (braceParams) {
      // 移除花括号，只保留参数名
      braceParams.forEach((param) => params.push(param.slice(1, -1)));
    }
  }

  /**
   * 标准化 URL 模式以便匹配
   *
   * 重要说明：此方法在 AST 解析期间调用，此时我们还无法访问完整的符号表。
   * 因此需要谨慎处理，避免过度标准化可能包含重要路径信息的模板变量。
   *
   * 标准化策略：
   * 1. 移除基础 URL 变量（${this.baseURL}、${baseURL} 等）
   * 2. 保留路径构造变量（${basePath}、${path} 等）作为占位符
   * 3. 将参数类变量（${id}、${userId} 等）转换为 :param 格式
   *
   * 使用场景：
   * - URL 模式去重：将相似的 URL 归一化为同一模式
   * - 路由匹配：将动态参数统一为标准格式
   * - API 文档生成：生成规范的 API 路径
   *
   * @param pattern - 原始 URL 模式
   * @returns 标准化后的 URL 模式
   *
   * @example
   * // 输入：${this.baseURL}/users/${userId}/posts/${postId}
   * // 输出：users/:userId/posts/:postId
   *
   * @example
   * // 输入：/api/products/12345/details
   * // 输出：api/products/:id/details
   */
  private normalizeURLPattern(pattern: string): string {
    let normalized = pattern;

    // 去掉协议 + 域名，只留路径。
    // 只在「域名后面确实还有路径」时才剥（`https://api.x.com/api/v1` → `/api/v1`），
    // 纯粹的 base URL 常量（`https://api.x.com`）保持原样，它本身是有价值的锚点。
    normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+(?=\/)/i, '');

    // 移除基础 URL 变量（它们不影响路径结构）
    // 这些变量通常指向域名或 API 根路径
    normalized = normalized
      .replace(/\$\{this\.baseURL\}/gi, '') // 移除 ${this.baseURL}
      .replace(/\$\{baseURL\}/gi, '') // 移除 ${baseURL}
      .replace(/\$\{this\.apiUrl\}/gi, '') // 移除 ${this.apiUrl}
      .replace(/\$\{apiUrl\}/gi, ''); // 移除 ${apiUrl}

    // 将 UUID 替换为 :id
    // UUID 格式：8-4-4-4-12 位十六进制数字
    normalized = normalized
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      // 将长十六进制字符串替换为 :id（如哈希值、令牌等）
      .replace(/\/[0-9a-f]{20,}/gi, '/:id')
      // 将数字 ID 替换为 :id（如 /users/123 -> /users/:id）
      .replace(/\/\d+/g, '/:id');

    // 智能处理模板变量：
    // - 参数类变量（id、userId、productId 等）-> :paramName
    // - 路径类变量（basePath、path、endpoint 等）-> 保留为 ${varName} 供后续扩展
    normalized = normalized.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const cleanName = varName.trim();

      // 检查是否为参数类变量（以 'id'、'Id'、'ID' 结尾，或是 slug、key、code、token）
      // 这些通常表示资源标识符
      if (/^(.*[iI]d|slug|key|code|token)$/.test(cleanName)) {
        // 转换为 Express 风格的参数
        return `:${cleanName}`;
      }

      // 检查是否为路径构造变量（包含 'path'、'endpoint'、'route'、'url' 等）
      // 这些变量可能包含完整的路径片段，需要保留供 url-derivation 模块扩展
      if (/(path|Path|endpoint|Endpoint|route|Route|url|Url|URI|uri)/.test(cleanName)) {
        // 保持原样，供后续处理
        return match;
      }

      // 对于其他变量，保持原样（将由 url-derivation 模块处理）
      return match;
    });

    // 标准化多个连续斜杠为单个斜杠
    // 例如：/api//users///123 -> /api/users/123
    normalized = normalized.replace(/\/+/g, '/');

    // 移除首尾斜杠以保持一致性
    // 这样所有路径都是相对路径格式：users/:id 而不是 /users/:id/
    normalized = normalized.replace(/^\/+|\/+$/g, '');

    return normalized;
  }

  /**
   * 从表达式文本中提取 HTTP 方法
   *
   * 分析函数调用表达式的文本，识别其中包含的 HTTP 方法。
   * 支持识别标准的 HTTP 方法：GET、POST、PUT、DELETE、PATCH
   *
   * @param text - 表达式文本（如 'axios.get'、'client.post'）
   * @returns HTTP 方法的大写形式，如果未识别则返回 undefined
   *
   * @example
   * extractHTTPMethod('axios.get') // 返回 'GET'
   * extractHTTPMethod('api.post') // 返回 'POST'
   * extractHTTPMethod('fetch') // 返回 undefined
   */
  private extractHTTPMethod(text: string): string | undefined {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    for (const method of methods) {
      // 不区分大小写地检查文本中是否包含该方法
      if (text.toLowerCase().includes(method.toLowerCase())) {
        return method;
      }
    }
    return undefined;
  }

  /**
   * 从源文件中提取所有函数
   *
   * 遍历源文件的 AST，提取各种类型的函数定义：
   * - 函数声明：function foo() {}
   * - 类方法：class A { method() {} }
   * - 构造函数：class A { constructor() {} }
   * - 箭头函数：const foo = () => {}
   *
   * @param sourceFile - 源文件对象
   * @returns 函数信息数组
   */
  private extractFunctions(sourceFile: SourceFile): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // 函数声明
    // 提取所有顶层和嵌套的函数声明
    sourceFile.getFunctions().forEach((func) => {
      functions.push(this.extractFunctionInfo(func, 'function'));
    });

    // 类中的方法声明
    // 遍历所有类，提取其中的方法和构造函数
    sourceFile.getClasses().forEach((cls) => {
      // 提取类的普通方法
      cls.getMethods().forEach((method) => {
        functions.push(this.extractFunctionInfo(method, 'method'));
      });

      // 提取类的构造函数
      cls.getConstructors().forEach((ctor) => {
        functions.push(this.extractFunctionInfo(ctor, 'constructor'));
      });
    });

    // 赋值给变量的箭头函数
    // 例如：const handleClick = () => {}
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((varDecl) => {
      const initializer = varDecl.getInitializer();
      // 检查初始化器是否为箭头函数
      if (initializer && Node.isArrowFunction(initializer)) {
        const name = varDecl.getName();
        functions.push({
          name,
          fullName: name,
          signature: varDecl.getText(), // 完整的变量声明作为签名
          functionType: 'arrow',
          visibility: 'public', // 箭头函数默认为 public
          isAsync: initializer.isAsync(), // 检查是否为 async 函数
          isExported: varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement)?.isExported() || false,
          parameters: this.extractParameters(initializer),
          cyclomaticComplexity: this.calculateComplexity(initializer), // 计算圈复杂度
          linesOfCode: initializer.getEndLineNumber() - initializer.getStartLineNumber() + 1,
          lineStart: initializer.getStartLineNumber(),
          lineEnd: initializer.getEndLineNumber(),
          code: initializer.getText(),
        });
      }
    });

    return functions;
  }

  /**
   * 提取函数信息
   *
   * 从函数 AST 节点中提取详细信息，包括：
   * - 函数名称和完整名称（包含类名）
   * - 函数签名和返回类型
   * - 可见性、异步标志、导出标志
   * - 参数列表
   * - 圈复杂度和代码行数
   *
   * @param func - 函数 AST 节点
   * @param functionType - 函数类型（function/method/arrow/constructor）
   * @returns 函数信息对象
   */
  private extractFunctionInfo(
    func: any,
    functionType: 'function' | 'method' | 'arrow' | 'constructor'
  ): FunctionInfo {
    const name = func.getName?.() || 'anonymous';
    const parent = func.getParent();
    // 如果函数是类的成员，获取类名
    const className = Node.isClassDeclaration(parent) ? parent.getName() : undefined;
    // 构造完整名称：ClassName.methodName 或 functionName
    const fullName = className ? `${className}.${name}` : name;

    // ⚠️ `getReturnType()` 会**抛异常**，不只是返回 undefined。
    //
    // 实测（2026-09-19）：ts-morph 在源文件名带 `.vue` 这类它不认识的扩展名时，
    // `getReturnType()` → `getSignature()` → `TypeChecker.getSignatureFromNode()` 会抛
    // `TypeError: Cannot read properties of undefined (reading 'escapedName')`。
    //
    // 原来这里写的是 `func.getReturnType?.()?.getText()` —— 那个 `?.` **只防「方法不存在」，
    // 防不住「方法抛出」**，给了「已经防御过」的错觉。而本函数被 `extractFunctions()`
    // 的 `forEach` 调用、外层又被 `analyzeFile()` 的大 try/catch 包着 ⇒
    // **一个节点解析失败 = 该文件 `result.functions` 从未被赋值 = 整个文件的函数全部丢失**，
    // 且只留下一行 console.error（静默丢数据）。
    //
    // 返回类型本来就是**可选**字段，降级成 undefined 即可，不值得毁掉整个文件。
    let returnType: string | undefined;
    try {
      returnType = func.getReturnType?.()?.getText();
    } catch {
      returnType = undefined;
    }

    return {
      name,
      fullName,
      signature: func.getText().split('\n')[0].slice(0, 200), // 只取第一行作为签名，限制长度
      returnType, // 返回类型（如果有类型注解；解析失败时为 undefined）
      functionType,
      visibility: func.getScope?.() || 'public', // 可见性：public/private/protected
      isAsync: func.isAsync?.() || false, // 是否为异步函数
      isExported: func.isExported?.() || false, // 是否被导出
      parameters: this.extractParameters(func), // 提取参数列表
      cyclomaticComplexity: this.calculateComplexity(func), // 计算圈复杂度（代码复杂度指标）
      linesOfCode: func.getEndLineNumber() - func.getStartLineNumber() + 1, // 代码行数
      lineStart: func.getStartLineNumber(),
      lineEnd: func.getEndLineNumber(),
      code: func.getText(), // 完整的函数代码
    };
  }

  /**
   * 从函数中提取参数信息
   *
   * 提取函数的所有参数，包括：
   * - 参数名称
   * - 参数类型
   * - 是否可选
   * - 默认值
   *
   * @param func - 函数 AST 节点
   * @returns 参数信息数组
   */
  private extractParameters(func: any): ParameterInfo[] {
    const params: ParameterInfo[] = [];

    func.getParameters?.().forEach((param: any) => {
      params.push({
        name: param.getName(), // 参数名
        type: param.getType().getText(), // 参数类型
        isOptional: param.isOptional(), // 是否为可选参数（带 ? 的参数）
        defaultValue: param.getInitializer()?.getText(), // 默认值（如果有）
      });
    });

    return params;
  }

  /**
   * 计算圈复杂度
   *
   * 圈复杂度（Cyclomatic Complexity）是衡量代码复杂度的重要指标。
   * 它表示程序中线性独立路径的数量，值越高表示代码越复杂。
   *
   * 计算规则：
   * - 基础复杂度为 1
   * - 每个决策点（if、case、循环等）+1
   * - 每个逻辑运算符（&&、||）+1
   *
   * 复杂度等级：
   * - 1-10：简单，易于理解和测试
   * - 11-20：中等复杂，需要注意
   * - 21-50：复杂，建议重构
   * - 50+：极其复杂，强烈建议重构
   *
   * @param node - AST 节点
   * @returns 圈复杂度值
   */
  private calculateComplexity(node: Node): number {
    let complexity = 1; // 基础复杂度

    // 遍历所有子节点
    node.forEachDescendant((child) => {
      const kind = child.getKind();

      // 决策点：每个决策点增加一条独立路径
      if (
        kind === SyntaxKind.IfStatement || // if 语句
        kind === SyntaxKind.ConditionalExpression || // 三元运算符 ? :
        kind === SyntaxKind.CaseClause || // switch 的 case 分支
        kind === SyntaxKind.ForStatement || // for 循环
        kind === SyntaxKind.ForInStatement || // for...in 循环
        kind === SyntaxKind.ForOfStatement || // for...of 循环
        kind === SyntaxKind.WhileStatement || // while 循环
        kind === SyntaxKind.DoStatement || // do...while 循环
        kind === SyntaxKind.CatchClause // try...catch 的 catch 块
      ) {
        complexity++;
      }

      // 逻辑运算符：每个逻辑运算符增加一条路径
      if (kind === SyntaxKind.AmpersandAmpersandToken || // && 运算符
          kind === SyntaxKind.BarBarToken) { // || 运算符
        complexity++;
      }
    });

    return complexity;
  }

  /**
   * 从源文件中提取所有类
   *
   * 遍历源文件的 AST，提取各种类型的类定义：
   * - 类声明：class Foo {}
   * - 接口声明：interface Bar {}
   * - 类型别名：type Baz = {}
   * - 枚举声明：enum Status {}
   *
   * @param sourceFile - 源文件对象
   * @returns 类信息数组
   */
  private extractClasses(sourceFile: SourceFile): ClassInfo[] {
    const classes: ClassInfo[] = [];

    // 类声明
    // 提取所有类定义及其成员
    sourceFile.getClasses().forEach((cls) => {
      classes.push({
        name: cls.getName() || 'anonymous',
        fullName: cls.getName() || 'anonymous',
        classType: 'class',
        extendsClass: cls.getExtends()?.getText(), // 继承的父类
        implementsInterfaces: cls.getImplements().map((i) => i.getText()), // 实现的接口列表
        properties: cls.getProperties().map((prop) => ({
          name: prop.getName(),
          type: prop.getType().getText(),
          visibility: prop.getScope(), // public/private/protected
          isStatic: prop.isStatic(), // 是否为静态属性
          isReadonly: prop.isReadonly(), // 是否为只读属性
        })),
        methods: cls.getMethods().map((m) => m.getName()), // 方法名列表
        decorators: cls.getDecorators().map((d) => d.getName()), // 装饰器列表（如 @Component）
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        code: cls.getText(),
      });
    });

    // 接口声明
    // TypeScript 接口定义
    sourceFile.getInterfaces().forEach((iface) => {
      classes.push({
        name: iface.getName(),
        fullName: iface.getName(),
        classType: 'interface',
        extendsClass: undefined, // 接口不使用 extends（使用 extends 但语义不同）
        implementsInterfaces: iface.getExtends().map((e) => e.getText()), // 接口可以继承其他接口
        properties: iface.getProperties().map((prop) => ({
          name: prop.getName(),
          type: prop.getType().getText(),
          visibility: 'public', // 接口成员默认为 public
          isStatic: false,
          isReadonly: false,
        })),
        methods: iface.getMethods().map((m) => m.getName()),
        decorators: [], // 接口不支持装饰器
        lineStart: iface.getStartLineNumber(),
        lineEnd: iface.getEndLineNumber(),
        code: iface.getText(),
      });
    });

    // 类型别名
    // TypeScript 类型定义：type User = { name: string }
    sourceFile.getTypeAliases().forEach((typeAlias) => {
      classes.push({
        name: typeAlias.getName(),
        fullName: typeAlias.getName(),
        classType: 'type',
        extendsClass: undefined,
        implementsInterfaces: [],
        properties: [], // 类型别名的属性需要更复杂的解析
        methods: [],
        decorators: [],
        lineStart: typeAlias.getStartLineNumber(),
        lineEnd: typeAlias.getEndLineNumber(),
        code: typeAlias.getText(),
      });
    });

    // 枚举
    // TypeScript 枚举定义：enum Status { Active, Inactive }
    sourceFile.getEnums().forEach((enumDecl) => {
      classes.push({
        name: enumDecl.getName(),
        fullName: enumDecl.getName(),
        classType: 'enum',
        extendsClass: undefined,
        implementsInterfaces: [],
        properties: enumDecl.getMembers().map((member) => ({
          name: member.getName(),
          type: 'string | number', // 枚举成员可以是字符串或数字
          visibility: 'public', // 枚举成员都是 public
          isStatic: true, // 枚举成员都是静态的
          isReadonly: true, // 枚举成员都是只读的
        })),
        methods: [],
        decorators: [],
        lineStart: enumDecl.getStartLineNumber(),
        lineEnd: enumDecl.getEndLineNumber(),
        code: enumDecl.getText(),
      });
    });

    return classes;
  }

  /**
   * 从源文件中提取所有导入语句
   *
   * 分析文件的依赖关系，提取各种类型的导入。
   *
   * 【ESM】`import` 声明（原实现只有这一路）：
   * - 默认导入：import React from 'react'
   * - 命名导入：import { useState } from 'react'
   * - 命名空间导入：import * as React from 'react'
   * - 副作用导入：import './styles.css'
   *
   * 【CJS】`require()` 调用（后补，见下方注释）：
   * - const x = require('axios')
   * - const { A, B } = require('./config')
   *
   * @param sourceFile - 源文件对象
   * @returns 导入信息数组
   */
  private extractImports(sourceFile: SourceFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    // 遍历所有 import 声明
    sourceFile.getImportDeclarations().forEach((importDecl) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      // 判断是否为外部模块（npm 包）还是本地模块
      // 外部模块不以 . 或 / 开头
      const isExternal = !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');

      // 默认导入
      // 例如：import React from 'react'
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        imports.push({
          importedSymbol: defaultImport.getText(), // 导入的符号名
          importType: 'default',
          importPath: moduleSpecifier, // 模块路径
          isExternal, // 是否为外部模块
          line: importDecl.getStartLineNumber(),
        });
      }

      // 命名空间导入
      // 例如：import * as React from 'react'
      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) {
        imports.push({
          importedSymbol: namespaceImport.getText(),
          importType: 'namespace',
          importPath: moduleSpecifier,
          isExternal,
          line: importDecl.getStartLineNumber(),
        });
      }

      // 命名导入
      // 例如：import { useState, useEffect } from 'react'
      const namedImports = importDecl.getNamedImports();
      namedImports.forEach((namedImport) => {
        imports.push({
          importedSymbol: namedImport.getName(), // 导入的符号名
          importType: 'named',
          importPath: moduleSpecifier,
          isExternal,
          alias: namedImport.getAliasNode()?.getText(), // 别名（如 import { foo as bar }）
          line: importDecl.getStartLineNumber(),
        });
      });

      // 副作用导入
      // 例如：import './styles.css' 或 import 'polyfill'
      // 这种导入不引入任何符号，只执行模块的副作用
      if (!defaultImport && !namespaceImport && namedImports.length === 0) {
        imports.push({
          importType: 'side-effect',
          importPath: moduleSpecifier,
          isExternal,
          line: importDecl.getStartLineNumber(),
        });
      }
    });

    // ==================================================================
    // CommonJS：require('...')
    // ==================================================================
    // 【为什么必须补这一段】
    // 此前只处理 `getImportDeclarations()`，也就是纯 ESM。对于 CommonJS 仓库
    // （本项目自带的 test-repo 就是），提取到的 imports 恒为空数组，于是一路传导：
    //
    //   imports=[] → import_relations 0 行 → file_dependencies 0 行
    //              → 「改动这个文件会波及谁」永远返回 0 条
    //
    // 危险的地方在于它**不报错**：调用方看到的是「这个文件没有依赖任何人」，
    // 而不是「依赖数据没抽出来」。同一个坑在 file_dependencies 上也踩过一次
    // （见 relationship-builder 里关于「触发器从未被写出来」的注释）。
    //
    // 覆盖的写法与映射：
    //   const x          = require('axios')        → default  （x）
    //   const { A, B }   = require('./config')     → named    （A、B）
    //   const { A: alias } = require('./config')   → named A，alias=alias
    //   require('./polyfill')                      → side-effect
    //   const y          = require('./a').foo      → default（路径仍取 './a'）
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
      const callee = call.getExpression();
      // 只认名为 require 的普通标识符调用。
      // 这一条同时把动态 `import('...')` 排除掉了 —— 它的 callee 是 ImportKeyword，
      // 不是 Identifier，所以 isIdentifier 直接为 false。
      if (!Node.isIdentifier(callee) || callee.getText() !== 'require') return;

      const args = call.getArguments();
      if (args.length !== 1) return;
      const argNode = args[0];
      // 只处理静态字符串字面量；require(变量) 无法在索引期解析，跳过
      if (!Node.isStringLiteral(argNode)) return;

      const moduleSpecifier = argNode.getLiteralValue();
      const isExternal = !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');
      const line = call.getStartLineNumber();

      // 向上找到承载这个 require 的「语句级」节点：
      // require() 外面可能裹着属性访问（require('./a').foo）或直接调用（require('./a')()），
      // 所以不能只看 call.getParent() 一层。
      let cursor: Node = call;
      for (let hop = 0; hop < 4; hop++) {
        const parent = cursor.getParent();
        if (!parent) break;
        cursor = parent;
        if (Node.isVariableDeclaration(cursor) || Node.isExpressionStatement(cursor)) break;
      }

      if (Node.isVariableDeclaration(cursor)) {
        const nameNode = cursor.getNameNode();

        // const x = require('axios')
        if (Node.isIdentifier(nameNode)) {
          imports.push({
            importedSymbol: nameNode.getText(),
            importType: 'default',
            importPath: moduleSpecifier,
            isExternal,
            line,
          });
          return;
        }

        // const { A, B: alias } = require('./config')
        if (Node.isObjectBindingPattern(nameNode)) {
          nameNode.getElements().forEach((el) => {
            const propertyName = el.getPropertyNameNode();
            imports.push({
              // 无重命名时，解构出的名字就是被导入的符号名
              importedSymbol: propertyName ? propertyName.getText() : el.getNameNode().getText(),
              importType: 'named',
              importPath: moduleSpecifier,
              isExternal,
              alias: propertyName ? el.getNameNode().getText() : undefined,
              line,
            });
          });
          return;
        }
      }

      // 其余形态（数组解构、裸 require('./polyfill') 等）：
      // 符号名未知，但**文件级依赖是确定的**，所以仍记一条 side-effect，
      // 保证 file_dependencies 这条边不丢。
      imports.push({
        importType: 'side-effect',
        importPath: moduleSpecifier,
        isExternal,
        line,
      });
    });

    return imports;
  }
}
