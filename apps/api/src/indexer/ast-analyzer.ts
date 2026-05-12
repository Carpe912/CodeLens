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

// ============================================
// 类型定义
// ============================================

/**
 * 字符串常量信息
 *
 * 表示代码中的字符串常量，包括变量声明、对象属性、枚举值等。
 */
export interface StringConstant {
  symbolName?: string;           // 符号名称（变量名、属性名等）
  stringValue: string;            // 字符串值
  constantType: string;           // 常量类型（url_segment、error_code 等）
  lineStart: number;              // 起始行号
  lineEnd: number;                // 结束行号
  parentObject?: string;          // 父对象名称（如果是对象属性或枚举值）
  exportType?: 'named' | 'default' | 'none';  // 导出类型
  code: string;                   // 完整代码
}

/**
 * URL 模式信息
 *
 * 表示从代码中提取的 URL 模式，包括路径参数、查询参数等。
 */
export interface URLPattern {
  pattern: string;                // 原始模式
  normalizedPattern: string;      // 规范化后的模式
  method?: string;                // HTTP 方法（GET、POST 等）
  components: URLComponent[];     // URL 组成部分
  pathParams: string[];           // 路径参数列表
  queryParams: string[];          // 查询参数列表
  definitionLine: number;         // 定义行号
  definitionCode: string;         // 定义代码
}

/**
 * URL 组成部分
 *
 * 表示 URL 的一个片段，可以是字面量、变量或参数。
 */
export interface URLComponent {
  type: 'literal' | 'variable' | 'param';  // 组件类型
  value: string;                           // 组件值
  source?: {                               // 来源信息
    file?: string;                         // 文件路径
    symbol?: string;                       // 符号名称
  };
}

/**
 * 函数信息
 *
 * 表示函数的详细信息，包括签名、参数、复杂度等。
 */
export interface FunctionInfo {
  name: string;                   // 函数名
  fullName: string;               // 完整名称（包括类名等）
  signature: string;              // 函数签名
  returnType?: string;            // 返回类型
  functionType: 'function' | 'method' | 'arrow' | 'constructor';  // 函数类型
  visibility?: 'public' | 'private' | 'protected';  // 可见性
  isAsync: boolean;               // 是否异步
  isExported: boolean;            // 是否导出
  parameters: ParameterInfo[];    // 参数列表
  cyclomaticComplexity: number;   // 圈复杂度
  linesOfCode: number;            // 代码行数
  lineStart: number;              // 起始行号
  lineEnd: number;                // 结束行号
  code: string;                   // 完整代码
}

/**
 * 参数信息
 *
 * 表示函数参数的详细信息。
 */
export interface ParameterInfo {
  name: string;                   // 参数名
  type?: string;                  // 参数类型
  isOptional: boolean;            // 是否可选
  defaultValue?: string;          // 默认值
}

/**
 * 类信息
 *
 * 表示类、接口、类型别名或枚举的详细信息。
 */
export interface ClassInfo {
  name: string;                   // 类名
  fullName: string;               // 完整名称
  classType: 'class' | 'interface' | 'type' | 'enum';  // 类型
  extendsClass?: string;          // 继承的类
  implementsInterfaces: string[]; // 实现的接口列表
  properties: PropertyInfo[];     // 属性列表
  methods: string[];              // 方法名列表
  decorators: string[];           // 装饰器列表
  lineStart: number;              // 起始行号
  lineEnd: number;                // 结束行号
  code: string;                   // 完整代码
}

/**
 * 属性信息
 *
 * 表示类属性的详细信息。
 */
export interface PropertyInfo {
  name: string;                   // 属性名
  type?: string;                  // 属性类型
  visibility?: string;            // 可见性
  isStatic: boolean;              // 是否静态
  isReadonly: boolean;            // 是否只读
}

/**
 * 导入信息
 *
 * 表示模块导入语句的详细信息。
 */
export interface ImportInfo {
  importedSymbol?: string;        // 导入的符号名
  importType: 'named' | 'default' | 'namespace' | 'side-effect';  // 导入类型
  importPath: string;             // 导入路径
  isExternal: boolean;            // 是否外部模块
  alias?: string;                 // 别名
  line: number;                   // 行号
}

/**
 * AST 分析结果
 *
 * 包含从源文件中提取的所有结构化信息。
 */
export interface ASTAnalysisResult {
  stringConstants: StringConstant[];  // 字符串常量列表
  urlPatterns: URLPattern[];          // URL 模式列表
  functions: FunctionInfo[];          // 函数列表
  classes: ClassInfo[];               // 类列表
  imports: ImportInfo[];              // 导入列表
}

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
  async analyzeFile(filePath: string, content: string): Promise<ASTAnalysisResult> {
    // 创建源文件对象（如果已存在则覆盖）
    const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });

    const result: ASTAnalysisResult = {
      stringConstants: [],
      urlPatterns: [],
      functions: [],
      classes: [],
      imports: [],
    };

    try {
      // 步骤 1: 提取导入关系（用于依赖追踪）
      result.imports = this.extractImports(sourceFile);

      // 步骤 2: 提取字符串常量
      result.stringConstants = this.extractStringConstants(sourceFile);

      // 步骤 3: 从常量中提取 URL 模式
      result.urlPatterns = this.extractURLPatterns(result.stringConstants, sourceFile);

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

    // 类型 1: 查找所有带字符串值的变量声明
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((varDecl) => {
      const initializer = varDecl.getInitializer();
      if (!initializer) return;

      // 提取字符串值
      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;

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
  private extractURLPatterns(constants: StringConstant[], sourceFile: SourceFile): URLPattern[] {
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
      const isAxiosCall = exprText.includes('axios.');
      // fetch 是原生的 HTTP API
      const isFetchCall = exprText === 'fetch' || exprText.endsWith('.fetch');

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
      const urlPattern = this.extractURLFromExpression(urlArg);

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
            const urlPattern = this.extractURLFromExpression(routeArg);

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

    return {
      name,
      fullName,
      signature: func.getText().split('\n')[0].slice(0, 200), // 只取第一行作为签名，限制长度
      returnType: func.getReturnType?.()?.getText(), // 返回类型（如果有类型注解）
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
   * 分析文件的依赖关系，提取各种类型的导入：
   * - 默认导入：import React from 'react'
   * - 命名导入：import { useState } from 'react'
   * - 命名空间导入：import * as React from 'react'
   * - 副作用导入：import './styles.css'
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

    return imports;
  }
}
