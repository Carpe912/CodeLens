/**
 * URL 表达式解析器（常量折叠）
 *
 * ============================================
 * 为什么需要它
 * ============================================
 * 原 AST 分析器只做「单表达式」解析：遇到标识符（变量名）就直接产出 `${变量名}`。
 * 于是 `const path = ApiPaths.users.list(); client.get(path)` 在库里只剩 `${path}` ——
 * **没有任何路径信息**，用 URL 永远搜不到这个调用点。
 *
 * 实测（test-repo，78 条 pattern）：31 条（40%）是这种无信息的纯占位符；
 * `config/apiConfig.js` 这类「对象字面量 + 箭头函数」的路径工厂更是**一条记录都没有**。
 * 这是「接口搜不全」的主要成因（14/20 个未命中项，即 70%）。
 *
 * ============================================
 * 为什么不直接用 ts-morph 的符号解析
 * ============================================
 * 因为目标仓库大量使用 CommonJS（`const { X } = require('../config')`）。
 * `require()` 的返回类型是 `any`，ts-morph 的类型检查器**无法把解构出来的
 * `API_PREFIX` 关联到那个模块的导出**，`getDefinitions()` 直接返回空。
 * 所以这里自建符号表：按名字登记声明并分文件存放，跨文件只走 import/require。
 *
 * ============================================
 * ⚠️ 作用域必须按文件 + 按函数隔离
 * ============================================
 * 第一版把「按名字查声明」做成了全局表，于是方法参数 `path` 会命中**别的文件**里
 * 的 `const path = ...`，把 `apiFactory.js` 八个互不相同的调用点全解析成同一个 URL
 * （跨文件同名局部变量的串味）。**假阳性比漏解析更糟**，所以现在：
 * - 局部变量只在「使用点所在的函数链」里找；
 * - 文件顶层声明只在**本文件**找；
 * - 跨文件一律经 import/require 映射到目标文件再查。
 *
 * ============================================
 * 支持的写法（覆盖真实项目的路径构造）
 * ============================================
 * 字符串/无插值模板 → 模板表达式 → 二元 `+` → 标识符（局部 / 本文件顶层 / 导入）
 * → 对象属性链 `RESOURCES.USERS`、`ApiPaths.users.list` → 函数内联（含默认参数、
 * `return`、局部 const、`if`、三元）→ 类方法与 `this.` → `.replace()`、`.join()`
 *
 * 解析不出时**一律退回原行为**（产出 `${name}` / `${this.x}`），不猜测、不制造错误 URL。
 */

import { Node, SourceFile, SyntaxKind, Project } from 'ts-morph';
import type { URLProvider, IndirectCallSite } from '../types.js';

// ============================================
// 类型
// ============================================

/** 可内联的函数 */
export interface FnInfo {
  params: Array<{ name: string; defaultValue: Node | null }>;
  body: Node | null;
  bodyIsExpression: boolean;
  file: string;
  /** 所属类名或对象变量名 */
  owner?: string;
}

interface Decl {
  kind: 'var' | 'fn' | 'object' | 'class';
  file: string;
  node: Node;
}

interface ImportBinding {
  file: string;
  localName: string;
  modulePath: string;
  remoteName: string;
}

interface Ctx {
  file: string;
  /** 内联函数时形参 → 实参 的绑定 */
  locals: Map<string, string | Node>;
  /** 当前使用点：局部变量查找从它往上爬函数链 */
  useNode: Node;
  /** 当前方法所属类名（解析 `this.x`） */
  thisClass?: string;
  /** 跨声明的跳转次数（防循环，如 `const a=b; const b=a`） */
  hops?: { n: number };
}

/** 控制流信号：命中 return */
class ReturnSignal {
  constructor(public value: string | null) {}
}

// URLProvider / IndirectCallSite 已上提到 languages/types.ts。
//
// 判定依据：它们逐字段都是**语言无关**的输出契约（file / line / code / value / kind），
// 没有一个字段提到 TypeScript 语法 —— 将来的 Java 适配器要产出完全相同的结构
// （Java 侧的 provider = 注解里写死的路径字面量）。
//
// 这里只做转出，保住既有的 `from './url-resolver.js'` import 路径。
export type { URLProvider, IndirectCallSite };

/**
 * 递归深度上限。
 *
 * ⚠️ 不要调小：嵌套常量很吃深度。实测 `complexProductApi.js` 的
 * `buildApiPath(RESOURCES.PRODUCTS)` 链路是
 * 模板(0) → 调用(1) → 内联(4) → 函数体(5) → 三元(6) → 局部变量(9)
 * → `API_PREFIX`(11) → `BASE_PATH`(14) → 字面量(15)，
 * 3 层常量嵌套就吃掉 14 层。设成 14 会把 `API_PREFIX` 里的
 * `${BASE_PATH}/${API_VERSION}` 解析失败，跑出 `${BASE_PATH}/...` 这种半成品。
 * 真正的死循环由 `hops` 兜底，深度只作兜底保护。
 */
const MAX_DEPTH = 64;

/** 跨声明跳转上限（`const a = b` 这类链路） */
const MAX_HOPS = 200;

function isFunctionLike(n: Node): boolean {
  return (
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n) ||
    Node.isGetAccessorDeclaration(n) ||
    Node.isConstructorDeclaration(n)
  );
}

/** 从某节点往上找最近的函数（含自身） */
function nearestFunction(n: Node): Node | null {
  let cur: Node | undefined = n;
  while (cur) {
    if (isFunctionLike(cur)) return cur;
    cur = cur.getParent();
  }
  return null;
}

/** 取属性链最左边的标识符：`ApiPaths.users` → `ApiPaths` */
function leftmostIdentifier(node: Node): string {
  let cur: Node = node;
  while (Node.isPropertyAccessExpression(cur)) cur = cur.getExpression();
  return cur.getText();
}

// ============================================
// 解析器
// ============================================

export class URLResolver {
  /** 文件顶层声明：file → name → Decl */
  private topDecls = new Map<string, Map<string, Decl>>();
  /** 文件内对象属性：`Obj.a.b` → Decl（按文件隔离） */
  private fileProps = new Map<string, Map<string, Decl>>();
  /** 文件内对象方法/箭头函数属性：`Obj.m` → FnInfo */
  private fileObjMethods = new Map<string, Map<string, FnInfo>>();
  /** 类方法：`Class.m` → 候选（优先同文件） */
  private classMethods = new Map<string, FnInfo[]>();
  /** 类声明：Class → 候选 */
  private classes = new Map<string, Decl[]>();
  /** 类字段：`Class.field` → 初始化表达式 */
  private classFields = new Map<string, Node | null>();
  /** `new X()` 归属：`file\0var` → Class，以及 `Class.field` → Class */
  private instanceOf = new Map<string, string>();
  /** 工厂函数名 → 它 new 出来的类（惰性建表，见 `ensureFactoryIndex`） */
  private factoryClass = new Map<string, string>();
  /** `ensureFactoryIndex` 是否已建过表 */
  private factoryBuilt = false;
  /** 方法名 → 全部同名方法（仅当**全局唯一**时才敢按名字内联） */
  private methodsByName = new Map<string, FnInfo[]>();
  /** import / require 映射：`file\0local` → binding */
  private imports = new Map<string, ImportBinding>();
  private files = new Set<string>();
  private sources = new Map<string, SourceFile>();

  constructor(private project: Project) {}

  // ------------------------------------------
  // 建表
  // ------------------------------------------

  /**
   * 登记整个仓库的源码。必须先于任何解析调用执行：
   * 跨文件常量（`API_PREFIX`）只有在所有文件都建过表之后才查得到。
   */
  registerFiles(files: Array<{ path: string; content: string }>): void {
    // 源文件表变了，工厂索引必须作废重建（否则换仓库后会命中上一个仓库的工厂）
    this.factoryBuilt = false;
    this.factoryClass.clear();

    for (const f of files) this.files.add(f.path);

    // ⚠️⚠️ 逐文件 try/catch 不是防「小概率异常」，是防「一个坏文件把整仓清零」。
    //
    // 这个循环外面**没有**任何 try/catch —— 异常会一路穿过 `registerRepoFiles`、
    // `RepoScope.begin`，最后在 `EnhancedIndexer.indexFiles` 里终止整个增强索引。
    // 而且它在**第一步**就抛，此时实体/关系表还是空的。
    //
    // 2026-09-19 实测：repo 33（真实工程 1308 个文件）因为 4 个 `.vue` 里
    // `<template>` 的 `@import="x"` 与 `<style>` 的 `.x-import {`
    // 被 TS 错误恢复当成 import 声明（非字符串字面量 → `getModuleSpecifierValue()` 抛），
    // 让 1308 个文件的实体层**全部**为空：files 1051、functions 0、url_patterns 0、
    // url_usages 0、call_graph 0，仓库状态 `failed`。
    //
    // 原则：**单个文件解析失败 ⇒ 只降级这一个文件，并明确记账；不许静默，也不许连坐。**
    const failed: Array<{ path: string; message: string }> = [];

    for (const f of files) {
      try {
        const sf = this.project.createSourceFile(f.path, f.content, { overwrite: true });
        this.sources.set(f.path, sf);
        this.indexFile(sf, f.path);
      } catch (error) {
        // 从 sources 里摘掉，后面的 `indexInstances` 与逐文件查询会自然跳过它
        this.sources.delete(f.path);
        failed.push({ path: f.path, message: (error as Error)?.message ?? String(error) });
      }
    }

    // 第二遍：`new X()` 需要类声明已全部就位
    for (const f of files) {
      const sf = this.sources.get(f.path);
      if (!sf) continue;
      try {
        this.indexInstances(sf, f.path);
      } catch (error) {
        this.sources.delete(f.path);
        failed.push({ path: f.path, message: (error as Error)?.message ?? String(error) });
      }
    }

    if (failed.length > 0) {
      console.log(
        `[URLResolver] ${failed.length}/${files.length} 个文件未能进入跨文件符号表（仅这些文件降级，其余照常）：`
      );
      for (const item of failed) {
        console.log(`[URLResolver]   跳过 ${item.path} —— ${item.message}`);
      }
    }

    // 第三遍：建「方法名 → 候选」索引，供唯一名兜底内联使用
    for (const list of this.classMethods.values()) {
      for (const fn of list) this.pushByName(this.nameOfMethod(fn, this.classMethods), fn);
    }
    for (const m of this.fileObjMethods.values()) {
      for (const [key, fn] of m) this.pushByName(key.split('.').pop() ?? key, fn);
    }
  }

  /** 从 `Class.method` 的注册键里取方法名 */
  private nameOfMethod(fn: FnInfo, _src: Map<string, FnInfo[]>): string {
    // owner 是类名或对象变量名，方法名从 body 的父节点取更可靠
    const parent = fn.body?.getParent();
    const nameNode = (parent as any)?.getNameNode?.() ?? (parent as any)?.getName?.();
    const text = typeof nameNode === 'string' ? nameNode : nameNode?.getText?.();
    return text ?? 'anonymous';
  }

  private pushByName(name: string, fn: FnInfo): void {
    const list = this.methodsByName.get(name);
    if (list) list.push(fn);
    else this.methodsByName.set(name, [fn]);
  }

  /**
   * 唯一名兜底：`this.factory.resourceWithId(...)` 这类「持有者类型未知」的调用，
   * 只要方法名在整个仓库里唯一，就按名字内联。
   *
   * 这是刻意的启发式：`resourceWithId`、`nestedResource`、`fromTemplate` 这种名字
   * 基本不会撞车；一旦有同名候选就**放弃**，宁可漏解析也不猜错。
   */
  private uniqueMethod(name: string): FnInfo | null {
    const list = this.methodsByName.get(name);
    return list && list.length === 1 ? list[0] : null;
  }

  private indexFile(sf: SourceFile, file: string): void {
    const top = new Map<string, Decl>();
    const props = new Map<string, Decl>();
    const objMethods = new Map<string, FnInfo>();
    this.topDecls.set(file, top);
    this.fileProps.set(file, props);
    this.fileObjMethods.set(file, objMethods);

    const addTop = (name: string, d: Decl) => {
      if (!top.has(name)) top.set(name, d);
    };

    // 变量声明
    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = vd.getName();
      const init = vd.getInitializer();
      if (!name || !init) continue;

      // require / import 解构
      const modPath = this.modulePathOf(init);
      if (modPath) {
        this.imports.set(this.impKey(file, name), {
          file, localName: name, modulePath: modPath, remoteName: name,
        });
        continue;
      }

      const isObj = Node.isObjectLiteralExpression(init);
      const decl: Decl = { kind: isObj ? 'object' : 'var', file, node: init };
      addTop(name, decl);
      if (isObj) this.indexObjectLiterals(init, name, file, props, objMethods);
    }

    // `const { A, B } = require('mod')`
    for (const bpe of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
      const parent = bpe.getParent();
      if (!Node.isObjectBindingPattern(parent)) continue;
      const decl = parent.getParent();
      if (!Node.isVariableDeclaration(decl)) continue;
      const init = decl.getInitializer();
      if (!init) continue;
      const modPath = this.modulePathOf(init);
      if (!modPath) continue;
      const localName = bpe.getName();
      const remoteName = bpe.getPropertyNameNode()?.getText() ?? localName;
      this.imports.set(this.impKey(file, localName), {
        file, localName, modulePath: modPath, remoteName,
      });
    }

    // ESM import
    for (const imp of sf.getImportDeclarations()) {
      const mod = imp.getModuleSpecifierValue();
      for (const named of imp.getNamedImports()) {
        const localName = named.getAliasNode()?.getText() ?? named.getName();
        this.imports.set(this.impKey(file, localName), {
          file, localName, modulePath: mod, remoteName: named.getName(),
        });
      }
      const def = imp.getDefaultImport();
      if (def) {
        this.imports.set(this.impKey(file, def.getText()), {
          file, localName: def.getText(), modulePath: mod, remoteName: 'default',
        });
      }
    }

    // 函数声明
    for (const fd of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      const name = fd.getName();
      if (!name) continue;
      addTop(name, { kind: 'fn', file, node: fd });
    }

    // 类：方法 + 字段
    for (const cls of sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
      const clsName = cls.getName();
      if (!clsName) continue;
      this.classes.set(clsName, this.classes.get(clsName) ?? []);
      this.classes.get(clsName)!.push({ kind: 'class', file, node: cls });
      addTop(clsName, { kind: 'class', file, node: cls });

      for (const m of cls.getMethods()) {
        const info: FnInfo = {
          params: m.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
          body: m.getBody() ?? null,
          bodyIsExpression: false,
          file,
          owner: clsName,
        };
        const key = `${clsName}.${m.getName()}`;
        this.classMethods.set(key, this.classMethods.get(key) ?? []);
        this.classMethods.get(key)!.push(info);
      }

      // 字段声明 `apiVersion = 'v1';`
      for (const p of cls.getProperties()) {
        this.classFields.set(`${clsName}.${p.getName()}`, p.getInitializer() ?? null);
      }
      // 构造函数里的 `this.x = <expr>`
      const ctor = cls.getConstructors()[0];
      if (ctor) {
        const ctorParams = ctor.getParameters();
        const ctorBody = ctor.getBody();
        const ctorStmts = ctorBody && Node.isBlock(ctorBody) ? ctorBody.getStatements() : [];
        for (const stmt of ctorStmts) {
          if (!Node.isExpressionStatement(stmt)) continue;
          const e = stmt.getExpression();
          if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
            const left = e.getLeft();
            if (Node.isPropertyAccessExpression(left) && Node.isThisExpression(left.getExpression())) {
              let rhs: Node = e.getRight();
              // `this.apiVersion = apiVersion` 且形参有默认值 → 用默认值
              // （否则整个 `/api/:version/...` 会因为拿不到实参而解析不出来）
              if (Node.isIdentifier(rhs)) {
                const p = ctorParams.find((x) => x.getName() === rhs.getText());
                const def = p?.getInitializer();
                if (def) rhs = def;
              }
              this.classFields.set(`${clsName}.${left.getName()}`, rhs);
            }
          }
        }
      }
    }
  }

  /** 登记对象字面量（含嵌套），并登记其中的箭头函数/简写方法 */
  private indexObjectLiterals(
    obj: Node,
    prefix: string,
    file: string,
    props: Map<string, Decl>,
    objMethods: Map<string, FnInfo>,
    depth = 0
  ): void {
    if (!Node.isObjectLiteralExpression(obj) || depth > 5) return;

    for (const prop of obj.getProperties()) {
      // SpreadAssignment 没有 getName()，跳过
      const nameNode = (prop as any).getNameNode?.();
      const key = String(nameNode?.getText?.() ?? (prop as any).getName?.() ?? '')
        .replace(/^['"]|['"]$/g, '');
      if (!key) continue;
      const full = `${prefix}.${key}`;

      if (Node.isPropertyAssignment(prop)) {
        const init = prop.getInitializer();
        if (!init) continue;

        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          const body = init.getBody();
          objMethods.set(full, {
            params: init.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
            body: Node.isArrowFunction(init) && !Node.isBlock(body) ? body : (Node.isBlock(body) ? body : null),
            bodyIsExpression: Node.isArrowFunction(init) && !Node.isBlock(body),
            file,
            owner: prefix,
          });
          continue;
        }

        props.set(full, { kind: 'var', file, node: init });
        if (Node.isObjectLiteralExpression(init)) {
          this.indexObjectLiterals(init, full, file, props, objMethods, depth + 1);
        }
      }

      if (Node.isMethodDeclaration(prop)) {
        objMethods.set(full, {
          params: prop.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
          body: prop.getBody() ?? null,
          bodyIsExpression: false,
          file,
          owner: prefix,
        });
      }
    }
  }

  /** 第二遍：`const f = new Foo()` → 记住 f 归属 Foo */
  private indexInstances(sf: SourceFile, file: string): void {
    for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const name = vd.getName();
      const init = vd.getInitializer();
      if (!name || !init || !Node.isNewExpression(init)) continue;
      const cls = init.getExpression().getText();
      this.instanceOf.set(this.impKey(file, name), cls);
    }
  }

  // ------------------------------------------
  // 对外接口
  // ------------------------------------------

  /** 解析某行上 HTTP 调用/路由注册的 URL 实参；解析不出返回 null */
  resolveCallArg(filePath: string, line: number, argIndex = 0): string | null {
    const sf = this.sources.get(filePath);
    if (!sf) return null;

    const calls = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getStartLineNumber() === line)
      .sort((a, b) => a.getStart() - b.getStart());
    if (calls.length === 0) return null;

    let fallback: string | null = null;
    for (const call of calls) {
      const args = call.getArguments();
      if (args.length <= argIndex) continue;
      const resolved = this.evalString(args[argIndex], {
        file: filePath,
        locals: new Map(),
        useNode: args[argIndex],
        hops: { n: 0 },
      }, 0);
      if (!resolved) continue;
      if (URLResolver.looksLikePath(resolved)) return resolved;
      fallback = fallback ?? resolved;
    }
    return fallback;
  }

  /** 解析任意表达式的文本值（供 provider 扫描使用） */
  resolveNode(node: Node, filePath: string): string | null {
    return this.evalString(node, { file: filePath, locals: new Map(), useNode: node, hops: { n: 0 } }, 0);
  }

  /** 该字符串看起来像 URL / 路径吗 */
  static looksLikePath(value: string): boolean {
    const v = value.trim();
    if (/^https?:\/\//i.test(v)) return true;
    if (/^\$\{this\.[A-Za-z]+\}\//.test(v)) return true; // 基地址 + 路径
    if (/^\/[A-Za-z0-9]/.test(v)) return true;
    if (/^[a-z0-9\-_]+\/[a-z0-9\-_:]/i.test(v)) return true;
    return false;
  }

  /** 仍然含无法解析的片段？ */
  static hasUnresolved(value: string): boolean {
    return /\$\{[^}]*\}/.test(value);
  }

  // ------------------------------------------
  // 求值
  // ------------------------------------------

  private evalString(node: Node | undefined | null, ctx: Ctx, depth: number): string | null {
    if (!node || depth > MAX_DEPTH) return null;

    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
      return Node.isStringLiteral(node) ? node.getLiteralValue() : node.getLiteralText();
    }

    if (Node.isTemplateExpression(node)) {
      let out = node.getHead().getLiteralText();
      for (const span of node.getTemplateSpans()) {
        const expr = span.getExpression();
        const val = this.evalString(expr, { ...ctx, useNode: expr }, depth + 1);
        out += val !== null ? val : `\${${expr.getText()}}`;
        out += span.getLiteral().getLiteralText();
      }
      return out;
    }

    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const l = this.evalString(node.getLeft(), { ...ctx, useNode: node.getLeft() }, depth + 1);
      const r = this.evalString(node.getRight(), { ...ctx, useNode: node.getRight() }, depth + 1);
      if (l === null || r === null) return null;
      return l + r;
    }

    if (Node.isIdentifier(node)) {
      return this.evalIdentifier(node.getText(), ctx, depth + 1);
    }

    if (Node.isPropertyAccessExpression(node)) {
      const v = this.evalProperty(node.getExpression(), node.getName(), ctx, depth + 1);
      // 解析不出时保留占位符（如 `${this.baseURL}`），不要丢信息
      return v !== null ? v : `\${${node.getText()}}`;
    }

    if (Node.isParenthesizedExpression(node)) {
      return this.evalString(node.getExpression(), { ...ctx, useNode: node.getExpression() }, depth + 1);
    }

    if (Node.isConditionalExpression(node)) {
      const t = this.truthiness(node.getCondition(), ctx, depth + 1);
      if (t === true) return this.evalString(node.getWhenTrue(), { ...ctx, useNode: node.getWhenTrue() }, depth + 1);
      if (t === false) return this.evalString(node.getWhenFalse(), { ...ctx, useNode: node.getWhenFalse() }, depth + 1);
      return null;
    }

    if (Node.isCallExpression(node)) {
      return this.evalCall(node, ctx, depth + 1);
    }

    return null;
  }

  /**
   * 标识符求值：内联绑定 → 局部作用域链 → 本文件顶层 → 导入目标。
   *
   * ⚠️ 绝不查「别的文件的同名局部变量」。局部变量只在它所属的函数链里可见。
   */
  private evalIdentifier(name: string, ctx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH) return null;

    // 1. 内联函数时绑定的形参
    const local = ctx.locals.get(name);
    if (local !== undefined) {
      if (typeof local === 'string') return local;
      if (!this.hop(ctx)) return null;
      return this.evalString(local, { ...ctx, useNode: local }, depth + 1);
    }

    // 2. 局部作用域链：从使用点往上，每遇到一个函数就找它的形参与局部变量
    let cur: Node | undefined = ctx.useNode;
    while (cur) {
      if (isFunctionLike(cur)) {
        // 形参：运行期才知值 → 保留占位符（不要猜）
        const params = (cur as any).getParameters?.() ?? [];
        if (params.some((p: any) => p.getName?.() === name)) return `\${${name}}`;

        // 该函数自己声明的局部变量（排除更深层嵌套函数里的同名变量）
        for (const vd of cur.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          if (nearestFunction(vd) !== cur) continue;
          if (vd.getName() !== name) continue;
          const init = vd.getInitializer();
          if (!init) return null; // 声明了但没初始化（如 `let endpoint;`）
          return this.evalString(init, { ...ctx, useNode: init }, depth + 1);
        }

        // 赋值形式（switch 里 `endpoint = ...`）无法唯一定值 → 放弃
        for (const be of cur.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
          if (be.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
          if (be.getLeft().getText() === name && nearestFunction(be) === cur) return null;
        }
      }
      cur = cur.getParent();
    }

    // 3. 本文件顶层声明
    const top = this.topDecls.get(ctx.file)?.get(name);
    if (top) {
      if (top.kind === 'class') return null;
      if (!this.hop(ctx)) return null;
      return this.evalString(top.node, { file: top.file, locals: new Map(), useNode: top.node, hops: ctx.hops }, depth + 1);
    }

    // 4. 导入目标
    const imp = this.imports.get(this.impKey(ctx.file, name));
    if (imp) return this.resolveImported(imp, ctx, depth + 1);

    return null;
  }

  /** 跨文件取导入的值 */
  private resolveImported(imp: ImportBinding, ctx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH || !this.hop(ctx)) return null;
    const target = this.resolveModule(imp.file, imp.modulePath);
    if (!target) return null;

    const top = this.topDecls.get(target)?.get(imp.remoteName);
    if (top && top.kind !== 'class') {
      return this.evalString(top.node, { file: target, locals: new Map(), useNode: top.node, hops: ctx.hops }, depth + 1);
    }

    // 目标文件里「导出对象」的成员（`module.exports = { RESOURCES }` 之类）
    const sf = this.sources.get(target);
    if (sf) {
      for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = vd.getInitializer();
        if (!init || !Node.isObjectLiteralExpression(init)) continue;
        for (const p of init.getProperties()) {
          if (Node.isPropertyAssignment(p) && p.getName().replace(/^['"]|['"]$/g, '') === imp.remoteName) {
            const v = p.getInitializer();
            if (v) return this.evalString(v, { file: target, locals: new Map(), useNode: v, hops: ctx.hops }, depth + 1);
          }
        }
      }
    }
    return null;
  }

  /**
   * 属性访问求值。
   * 关键：先确定「这个对象属于哪个文件」，再去那个文件里查属性/方法 ——
   * 否则同名对象会在文件之间串味。
   */
  private evalProperty(objNode: Node, name: string, ctx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH) return null;

    // this.x → 类字段 / 类方法
    if (Node.isThisExpression(objNode)) {
      if (!ctx.thisClass) return null;
      const method = this.lookupClassMethod(ctx.thisClass, name, ctx.file);
      if (method) return this.inline(method, [], { ...ctx, thisClass: method.owner }, depth + 1);
      const fieldKey = `${ctx.thisClass}.${name}`;
      if (this.classFields.has(fieldKey)) {
        const init = this.classFields.get(fieldKey);
        if (!init) return null;
        return this.evalString(init, { file: this.fileOfClass(ctx.thisClass, ctx.file), locals: new Map(), useNode: init }, depth + 1);
      }
      return null;
    }

    const objText = objNode.getText();
    const dotted = `${objText}.${name}`;

    // 该对象归属哪个文件？要看**属性链最左边的标识符**
    // （`ApiPaths.users` 的归属由 `ApiPaths` 决定，用整串去查表必然查不到）
    const ownerFile = this.ownerFileOf(leftmostIdentifier(objNode), ctx);

    // 对象属性（`ApiPaths.users.list`）
    if (ownerFile) {
      const p = this.fileProps.get(ownerFile)?.get(dotted);
      if (p) {
        return this.evalString(p.node, { file: ownerFile, locals: new Map(), useNode: p.node }, depth + 1);
      }
      const om = this.fileObjMethods.get(ownerFile)?.get(dotted);
      if (om) return this.inline(om, [], { ...ctx, thisClass: om.owner }, depth + 1);
    }

    // 本文件兜底（嵌套前缀不在顶层时）
    const p2 = this.fileProps.get(ctx.file)?.get(dotted);
    if (p2) {
      return this.evalString(p2.node, { file: ctx.file, locals: new Map(), useNode: p2.node }, depth + 1);
    }
    const om2 = this.fileObjMethods.get(ctx.file)?.get(dotted);
    if (om2) return this.inline(om2, [], { ...ctx, thisClass: om2.owner }, depth + 1);

    // 实例方法：`apiFactory.resourceWithId(...)`（apiFactory = new ApiPathFactory()）
    if (Node.isIdentifier(objNode)) {
      const cls = this.classNameOf(objNode.getText(), ctx);
      if (cls) {
        const m = this.lookupClassMethod(cls, name, ctx.file);
        if (m) return this.inline(m, [], { ...ctx, thisClass: cls }, depth + 1);
      }
    }

    // 兜底：持有者类型未知（如 `this.factory.xxx`），但方法名全仓唯一 → 按名字内联
    const uniq = this.uniqueMethod(name);
    if (uniq) return this.inline(uniq, [], { ...ctx, thisClass: uniq.owner }, depth + 1);

    return null;
  }

  /** 该（可能是导入的）变量所属文件 */
  private ownerFileOf(rootText: string, ctx: Ctx): string | null {
    // 本文件顶层
    if (this.topDecls.get(ctx.file)?.has(rootText)) return ctx.file;
    // 导入
    const imp = this.imports.get(this.impKey(ctx.file, rootText));
    if (imp) return this.resolveModule(imp.file, imp.modulePath);
    // 内联绑定里的对象字面量
    const bound = ctx.locals.get(rootText);
    if (bound && typeof bound !== 'string' && Node.isObjectLiteralExpression(bound)) return ctx.file;
    return null;
  }

  /** 变量名 → 类名（先本文件，再跨文件同名类） */
  private classNameOf(varName: string, ctx: Ctx): string | null {
    const local = this.instanceOf.get(this.impKey(ctx.file, varName));
    if (local) return local;
    // 变量本身就是类名
    if (this.classes.has(varName)) return varName;
    return null;
  }

  private fileOfClass(cls: string, prefer: string): string {
    const cands = this.classes.get(cls);
    return cands?.find((c) => c.file === prefer)?.file ?? cands?.[0]?.file ?? prefer;
  }

  private lookupClassMethod(cls: string, method: string, prefer: string): FnInfo | null {
    const list = this.classMethods.get(`${cls}.${method}`);
    if (!list || list.length === 0) return null;
    return list.find((f) => f.file === prefer) ?? list[0];
  }

  /** 函数调用：字符串方法特判 → 否则内联 */
  private evalCall(call: Node, ctx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH || !Node.isCallExpression(call)) return null;
    const callee = call.getExpression();
    const args = call.getArguments();

    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName();
      const receiver = callee.getExpression();

      if (method === 'replace' || method === 'replaceAll') {
        const base = this.evalString(receiver, { ...ctx, useNode: receiver }, depth + 1);
        if (base === null) return null;
        const search = args[0] ? this.evalString(args[0], ctx, depth + 1) : null;
        if (search === null) return null;
        let repl: string | null = null;
        if (args[1]) {
          repl = this.evalString(args[1], ctx, depth + 1);
          if (repl === null) repl = `\${${args[1].getText()}}`;
        }
        if (repl === null) return null;
        return method === 'replaceAll' ? base.split(search).join(repl) : base.replace(search, repl);
      }

      if (method === 'join') {
        const arr = this.evalArray(receiver, ctx, depth + 1);
        if (!arr) return null;
        const sep = args[0] ? this.evalString(args[0], ctx, depth + 1) : ',';
        return arr.join(sep ?? '');
      }

      if (method === 'toString' || method === 'trim') {
        return this.evalString(receiver, { ...ctx, useNode: receiver }, depth + 1);
      }
    }

    const fn = this.resolveFn(callee, ctx, depth + 1);
    if (fn) return this.inline(fn, args, ctx, depth + 1);
    return null;
  }

  private evalArray(node: Node, ctx: Ctx, depth: number): string[] | null {
    if (!Node.isArrayLiteralExpression(node) || depth > MAX_DEPTH) return null;
    const out: string[] = [];
    for (const el of node.getElements()) {
      const v = this.evalString(el, { ...ctx, useNode: el }, depth + 1);
      out.push(v !== null ? v : `\${${el.getText()}}`);
    }
    return out;
  }

  /** 把 callee 解析成可内联的函数 */
  private resolveFn(callee: Node, ctx: Ctx, depth: number): FnInfo | null {
    if (depth > MAX_DEPTH) return null;

    if (Node.isIdentifier(callee)) {
      const name = callee.getText();

      const local = ctx.locals.get(name);
      if (local && typeof local !== 'string') {
        const info = this.fnInfoOf(local, ctx.file);
        if (info) return info;
      }

      // 局部函数（含函数表达式变量）
      let cur: Node | undefined = ctx.useNode;
      while (cur) {
        if (isFunctionLike(cur)) {
          for (const vd of cur.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
            if (nearestFunction(vd) !== cur || vd.getName() !== name) continue;
            const init = vd.getInitializer();
            if (init) {
              const info = this.fnInfoOf(init, ctx.file);
              if (info) return info;
            }
          }
        }
        cur = cur.getParent();
      }

      const top = this.topDecls.get(ctx.file)?.get(name);
      if (top && Node.isFunctionDeclaration(top.node)) return this.fnInfoOf(top.node, ctx.file);

      const imp = this.imports.get(this.impKey(ctx.file, name));
      if (imp) {
        const target = this.resolveModule(imp.file, imp.modulePath);
        if (target) {
          const t = this.topDecls.get(target)?.get(imp.remoteName);
          if (t && Node.isFunctionDeclaration(t.node)) return this.fnInfoOf(t.node, target);
        }
      }
    }

    if (Node.isPropertyAccessExpression(callee)) {
      const objText = callee.getExpression().getText();
      const dotted = `${objText}.${callee.getName()}`;
      const ownerFile = this.ownerFileOf(leftmostIdentifier(callee.getExpression()), ctx);
      if (ownerFile) {
        const m = this.fileObjMethods.get(ownerFile)?.get(dotted);
        if (m) return m;
      }
      const m2 = this.fileObjMethods.get(ctx.file)?.get(dotted);
      if (m2) return m2;

      if (Node.isIdentifier(callee.getExpression())) {
        const cls = this.classNameOf(callee.getExpression().getText(), ctx);
        if (cls) {
          const m = this.lookupClassMethod(cls, callee.getName(), ctx.file);
          if (m) return m;
        }
      }

      // 兜底：方法名全仓唯一 → 按名字内联
      const uniq = this.uniqueMethod(callee.getName());
      if (uniq) return uniq;
    }

    return null;
  }

  private fnInfoOf(node: Node, file: string): FnInfo | null {
    if (Node.isFunctionDeclaration(node)) {
      return {
        params: node.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
        body: node.getBody() ?? null,
        bodyIsExpression: false,
        file,
      };
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      const body = node.getBody();
      const exprBody = Node.isArrowFunction(node) && !Node.isBlock(body);
      return {
        params: node.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
        body: exprBody ? body : (Node.isBlock(body) ? body : null),
        bodyIsExpression: exprBody,
        file,
      };
    }
    if (Node.isMethodDeclaration(node)) {
      return {
        params: node.getParameters().map((p) => ({ name: p.getName(), defaultValue: p.getInitializer() ?? null })),
        body: node.getBody() ?? null,
        bodyIsExpression: false,
        file,
      };
    }
    return null;
  }

  /** 内联函数：绑定实参 → 求值函数体 */
  private inline(fn: FnInfo, args: Node[], callerCtx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH || !fn.body) return null;

    const locals = new Map<string, string | Node>();
    fn.params.forEach((p, i) => {
      const arg = args[i];
      if (arg) locals.set(p.name, arg);
      else if (p.defaultValue) locals.set(p.name, p.defaultValue);
    });

    const ctx: Ctx = {
      file: fn.file,
      locals,
      useNode: fn.body,
      thisClass: fn.owner ?? callerCtx.thisClass,
      hops: callerCtx.hops, // 与调用点共享跳转预算，跨函数也能兜住环
    };

    if (fn.bodyIsExpression) {
      return this.evalString(fn.body, { ...ctx, useNode: fn.body }, depth + 1);
    }

    try {
      return this.evalBlock(fn.body, ctx, depth + 1);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      return null;
    }
  }

  /** 解释函数体（return / 局部 const / if / 赋值 / 三元） */
  private evalBlock(body: Node, ctx: Ctx, depth: number): string | null {
    if (depth > MAX_DEPTH) return null;

    const stmts = Node.isBlock(body) ? body.getStatements() : [body];
    for (const stmt of stmts) {
      if (Node.isReturnStatement(stmt)) {
        throw new ReturnSignal(
          stmt.getExpression()
            ? this.evalString(stmt.getExpression(), { ...ctx, useNode: stmt.getExpression()! }, depth + 1)
            : null
        );
      }
      if (Node.isVariableStatement(stmt)) {
        for (const vd of stmt.getDeclarations()) {
          ctx.locals.set(vd.getName(), vd.getInitializer() ?? '');
        }
        continue;
      }
      if (Node.isExpressionStatement(stmt)) {
        const e = stmt.getExpression();
        if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          ctx.locals.set(e.getLeft().getText(), e.getRight());
        }
        continue;
      }
      if (Node.isIfStatement(stmt)) {
        const t = this.truthiness(stmt.getExpression(), ctx, depth + 1);
        if (t === true) return this.evalBlock(stmt.getThenStatement(), ctx, depth + 1);
        if (t === false) {
          const els = stmt.getElseStatement();
          if (els) return this.evalBlock(els, ctx, depth + 1);
        }
        continue;
      }
      if (Node.isBlock(stmt)) {
        const v = this.evalBlock(stmt, ctx, depth + 1);
        if (v !== null) return v;
      }
    }
    return null;
  }

  /** 真值判断：能确定就给 true/false，否则 null */
  private truthiness(node: Node, ctx: Ctx, depth: number): boolean | null {
    if (Node.isStringLiteral(node)) return node.getLiteralValue() !== '';
    if (Node.isNumericLiteral(node)) return Number(node.getLiteralText()) !== 0;
    if (node.getKind() === SyntaxKind.FalseKeyword) return false;
    if (node.getKind() === SyntaxKind.TrueKeyword) return true;
    const v = this.evalString(node, { ...ctx, useNode: node }, depth + 1);
    if (v !== null) return v !== '';
    return null;
  }

  // ------------------------------------------
  // URL 提供点扫描
  // ------------------------------------------

  /**
   * 扫描「产出路径的地方」——不限于 HTTP 调用实参。
   *
   * 这是为了让**路径构造处本身**也能被搜到。典型场景：
   * `config/apiConfig.js` 里的 `ApiPaths` 只是个路径表，全文件没有一个 HTTP 调用，
   * 于是它过去产生 **0 条记录**，导致「搜 `/api/v1/users/:userId/profile`
   * 却找不到它定义在哪」。
   *
   * 覆盖两类：
   * - `config_value`：对象字面量里的叶子属性值 / 箭头函数的表达式体（路径表）
   * - `returned`：函数 `return` 出来的路径（路径构造函数）
   */
  collectProviders(): URLProvider[] {
    const out: URLProvider[] = [];
    const seen = new Set<string>();

    const add = (file: string, node: Node, value: string, kind: URLProvider['kind']) => {
      if (!value || !URLResolver.looksLikePath(value)) return;
      const line = node.getStartLineNumber();
      const key = `${file}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ file, line, value, code: node.getText().slice(0, 200), kind });
    };

    for (const [file, sf] of this.sources) {
      // ① 对象字面量的叶子取值（含「箭头函数表达式体」这种路径表写法）
      for (const p of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        const init = p.getInitializer();
        if (!init) continue;
        if (Node.isObjectLiteralExpression(init)) continue; // 只取叶子，嵌套由子属性覆盖

        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          const body = init.getBody();
          if (Node.isBlock(body)) continue; // 块体由 ② 的 return 覆盖
          const v = this.resolveNode(body, file);
          if (v) add(file, p, v, 'config_value');
          continue;
        }
        const v = this.resolveNode(init, file);
        if (v) add(file, p, v, 'config_value');
      }

      // ② `return` 出来的路径（路径构造函数）
      for (const rs of sf.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        const e = rs.getExpression();
        if (!e) continue;
        const v = this.resolveNode(e, file);
        if (v) add(file, rs, v, 'returned');
      }
    }

    return out;
  }

  // ------------------------------------------
  // 跨过程归属（间接调用 / 模板句柄）
  // ------------------------------------------

  /**
   * 扫描「跨过程」的 URL 落点。
   *
   * ============================================
   * 为什么需要它
   * ============================================
   * 真实项目里 UI / 业务层几乎不直接 `client.get('/api/...')`，而是调自己封装的
   * `this.orderApi.getOrderItem(...)`。于是 `UserDashboard.loadOrderDetails`
   * 这个方法体里**一个字面路径都没有** —— 搜 `/api/orders/:orderId/items/:itemId`
   * 只能搜到 `orderApi` / `dynamicOrderApi`，搜不到真正触发它的那个组件方法，
   * 而那恰恰是「这个接口上线后被谁在用」的答案。
   *
   * 反方向同样缺：`apiFactory.fromTemplate` 自己不产出路径（返回的就是入参），
   * 它是「模板处理器」。只有把调用方传进去的字面路径挂到它的定义行上，
   * 才能回答「模板路径是靠谁拼出来的」。
   *
   * ============================================
   * ⚠️ 只在「名字全仓唯一」时才归属
   * ============================================
   * 名字不唯一一律放弃（例如 `getProductById` 同时存在于 `productApi.js` 与
   * `complexProductApi.js`）。**宁可少归属，也不能挂错文件** —— 挂错的调用点
   * 会让人以为某处代码在用这个接口，比漏掉更有害。
   */
  collectIndirectSites(): IndirectCallSite[] {
    const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);
    /** 该调用文本是否是 HTTP 请求（与 AST 分析器 extractURLPatterns 同口径） */
    const isHttpCallText = (t: string): boolean => {
      if (t.startsWith('cy.')) return false;
      if (t.includes('axios.')) return true;
      if (t === 'fetch' || t.endsWith('.fetch')) return true;
      return HTTP_METHODS.has(t.split('.').pop() ?? '');
    };

    // ① 全仓「具名函数 → 定义处」，供模板句柄定位
    const defsByName = new Map<string, Array<{ file: string; line: number }>>();
    for (const [file, sf] of this.sources) {
      for (const fn of this.namedFunctions(sf)) {
        const name = this.functionName(fn);
        if (!name || HTTP_METHODS.has(name)) continue;
        const list = defsByName.get(name) ?? [];
        list.push({ file, line: fn.getStartLineNumber() });
        defsByName.set(name, list);
      }
    }

    // ② 「函数 → 它内部 HTTP 调用解析出的 URL」
    //
    // 分两个索引，因为同名方法在真实项目里到处都是（`getOrderItem` 同时存在于
    // `orderApi` 与 `dynamicOrderApi`，路径还不一样）：
    // - classProducer：`Class.method` → URL，**精确**，靠接收者类型定位；
    // - plainProducer：`method` → URL，**兜底**，只在全仓同名方法解析出同一个 URL 时可用。
    // 先查精确的，查不到再退回兜底 —— 宁可少归属，也不挂错文件。
    const classProducer = new Map<string, Set<string>>();
    const plainProducer = new Map<string, Set<string>>();
    for (const [file, sf] of this.sources) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isHttpCallText(call.getExpression().getText())) continue;
        const args = call.getArguments();
        if (args.length === 0) continue;
        const url = this.evalString(args[0], { file, locals: new Map(), useNode: args[0], hops: { n: 0 } }, 0);
        if (!url || !URLResolver.looksLikePath(url)) continue;
        const owner = this.nearestNamedFunction(call);
        const name = owner ? this.functionName(owner) : null;
        if (!name || !owner) continue;

        const cls = this.nearestClassName(owner);
        if (cls) {
          const ck = `${cls}.${name}`;
          const cs = classProducer.get(ck) ?? new Set<string>();
          cs.add(url);
          classProducer.set(ck, cs);
        }
        const ps = plainProducer.get(name) ?? new Set<string>();
        ps.add(url);
        plainProducer.set(name, ps);
      }
    }
    const uniqueClass = new Map<string, string>();
    for (const [k, urls] of classProducer) if (urls.size === 1) uniqueClass.set(k, [...urls][0]);
    const uniqueProducer = new Map<string, string>();
    for (const [name, urls] of plainProducer) if (urls.size === 1) uniqueProducer.set(name, [...urls][0]);

    // ③ 逐调用点归属
    const out: IndirectCallSite[] = [];
    const seen = new Set<string>();
    for (const [file, sf] of this.sources) {
      const lines = sf.getFullText().split('\n');
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        let name: string | null = null;
        if (Node.isPropertyAccessExpression(expr)) name = expr.getName();
        else if (Node.isIdentifier(expr)) name = expr.getText();
        if (!name || HTTP_METHODS.has(name)) continue;

        const line = call.getStartLineNumber();
        const lineText = (lines[line - 1] ?? '').trim().slice(0, 200);
        const enclosing = this.functionName(this.nearestNamedFunction(call) ?? call);

        // ③-1 间接调用：被调方法自己会发请求 → 调用行归属它的 URL
        //      先用接收者的类精确定位（`this.orderApi.getOrderItem` 能落到
        //      `DynamicOrderApi.getOrderItem`），再退回「全仓同名唯一」兜底。
        const recvCls = this.resolveReceiverClass(call, file);
        const produced =
          (recvCls ? uniqueClass.get(`${recvCls}.${name}`) : undefined) ?? uniqueProducer.get(name);
        if (produced) {
          // 跳过「就是它自己的定义体」（`this.client.get` 那种自指）
          if (enclosing !== name) {
            const key = `${file}\u0000${line}\u0000${name}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ file, line, code: lineText, callee: name, url: produced, kind: 'indirect_call' });
            }
          }
          continue;
        }

        // ③-2 模板句柄：调用方把字面路径交给一个「自己不产出路径」的仓库内函数
        const defs = defsByName.get(name);
        if (!defs || defs.length !== 1) continue;   // 定义处不唯一 → 不猜
        const args = call.getArguments();
        if (args.length === 0) continue;
        const argVal = this.evalString(args[0], { file, locals: new Map(), useNode: args[0], hops: { n: 0 } }, 0);
        if (!argVal || !URLResolver.looksLikePath(argVal)) continue;
        const def = defs[0];
        const key = `${def.file}\u0000${def.line}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const defSf = this.sources.get(def.file);
        const defLine = (defSf?.getFullText().split('\n')[def.line - 1] ?? '').trim().slice(0, 200);
        out.push({ file: def.file, line: def.line, code: defLine, callee: name, url: argVal, kind: 'template_helper' });
      }
    }

    return out;
  }

  /** 文件里所有「具名」函数（方法 / 函数声明 / 变量或属性上挂的箭头函数） */
  private namedFunctions(sf: SourceFile): Node[] {
    const out: Node[] = [];
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) out.push(fn);
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) out.push(fn);
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.ArrowFunction)) out.push(fn);
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionExpression)) out.push(fn);
    return out.filter((fn) => !!this.functionName(fn));
  }

  /** 往上找最近的「具名」函数（跳过 `.map(id => ...)` 这类匿名回调） */
  private nearestNamedFunction(n: Node): Node | null {
    let cur: Node | undefined = n;
    while (cur) {
      if (isFunctionLike(cur) && this.functionName(cur)) return cur;
      cur = cur.getParent();
    }
    return null;
  }

  /** 函数名：方法/函数声明取自身名；表达式取它挂的变量名或属性名 */
  private functionName(fn: Node | null): string | null {
    if (!fn) return null;
    if (Node.isMethodDeclaration(fn) || Node.isFunctionDeclaration(fn) || Node.isGetAccessorDeclaration(fn)) {
      return fn.getName() || null;
    }
    if (Node.isFunctionExpression(fn) || Node.isArrowFunction(fn)) {
      const p = fn.getParent();
      if (p && Node.isVariableDeclaration(p)) return p.getName();
      if (p && Node.isPropertyAssignment(p)) return p.getName();
    }
    return null;
  }

  /** 往上找最近的类名 */
  private nearestClassName(n: Node): string | null {
    let cur: Node | undefined = n;
    while (cur) {
      if (Node.isClassDeclaration(cur)) return cur.getName() ?? null;
      if (Node.isClassExpression(cur)) {
        const p = cur.getParent();
        if (p && Node.isVariableDeclaration(p)) return p.getName();
        return null;
      }
      cur = cur.getParent();
    }
    return null;
  }

  /**
   * 解析调用接收者的类名。
   *
   * - `this.orderApi.getOrderItem(...)` → 所在类的 `this.orderApi` 是 `new DynamicOrderApi(...)`
   *   → `DynamicOrderApi`
   * - `api.getOrderItem(...)`（`const api = new OrderApi()`）→ `OrderApi`
   *
   * 解析不出返回 null，调用方退回「全仓同名唯一」兜底。
   */
  private resolveReceiverClass(call: Node, file: string): string | null {
    if (!Node.isCallExpression(call)) return null;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return null;
    const recv = expr.getExpression();

    // this.<field>
    if (Node.isPropertyAccessExpression(recv) && Node.isThisExpression(recv.getExpression())) {
      const cls = this.nearestClassName(call);
      if (!cls) return null;
      return this.classFromInit(this.classFields.get(`${cls}.${recv.getName()}`));
    }

    // <var>
    if (Node.isIdentifier(recv)) {
      const name = recv.getText();
      const direct = this.instanceOf.get(this.impKey(file, name));
      if (direct) return direct;
      // 局部变量：`const api = createApi()` 这类**工厂赋值**要沿作用域找声明
      return this.classFromInit(this.localInitializer(call, name));
    }

    return null;
  }

  /**
   * 从「初始化表达式」推断实例的类。
   *
   * - `new X()` → `X`
   * - `createX()` / `factory.createX()` → 工厂函数返回的类（见 `ensureFactoryIndex`）
   *
   * 真实项目里客户端常由**工厂/依赖注入**产出（`this.api = createApi(baseURL)`），
   * 而不是直接 `new`。不做这一步的话，接收者类型解析不出，
   * 同名方法（如 `getOrderItem` 同时存在于两个 API 类、路径还不一样）就一律放弃归属。
   */
  private classFromInit(init: Node | null | undefined): string | null {
    if (!init) return null;
    if (Node.isNewExpression(init)) return init.getExpression().getText();
    if (Node.isCallExpression(init)) {
      const callee = init.getExpression();
      const name = Node.isIdentifier(callee)
        ? callee.getText()
        : Node.isPropertyAccessExpression(callee)
          ? callee.getName()
          : null;
      if (!name) return null;
      this.ensureFactoryIndex();
      return this.factoryClass.get(name) ?? null;
    }
    return null;
  }

  /**
   * 「工厂函数名 → 它 new 出来的类」，只在名字唯一时才认。
   *
   * 判定：函数体里出现 `return new X(...)`。**同名工厂返回不同类时一律放弃** ——
   * 与归属的整体原则一致：宁可少识别，也不把调用点挂到错误的类上。
   */
  private ensureFactoryIndex(): void {
    if (this.factoryBuilt) return;
    this.factoryBuilt = true;

    const byName = new Map<string, Set<string>>();
    for (const [, sf] of this.sources) {
      for (const fn of this.namedFunctions(sf)) {
        const name = this.functionName(fn);
        if (!name) continue;
        const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
        if (!body) continue;

        // 表达式体箭头函数 `const f = () => new X()` 没有 Block
        const candidateReturns: Node[] = [];
        if (Node.isBlock(body)) candidateReturns.push(...body.getDescendantsOfKind(SyntaxKind.ReturnStatement));
        else candidateReturns.push(body);

        for (const rs of candidateReturns) {
          const e = Node.isReturnStatement(rs) ? rs.getExpression() : rs;
          if (!e || !Node.isNewExpression(e)) continue;
          const cls = e.getExpression().getText();
          const set = byName.get(name) ?? new Set<string>();
          set.add(cls);
          byName.set(name, set);
        }
      }
    }

    for (const [name, classes] of byName) {
      if (classes.size === 1) this.factoryClass.set(name, [...classes][0]);
    }
  }

  /**
   * 沿作用域向上找某个局部变量的初始化表达式（`const api = ...`）。
   *
   * 与 `resolveFn` 里找局部函数用的是同一条向上走的路径：
   * 只看「直接属于当前函数」的声明（`nearestFunction(vd) === cur`），
   * 否则内层箭头函数里的同名变量会串味。
   */
  private localInitializer(fromNode: Node, name: string): Node | null {
    let cur: Node | undefined = fromNode;
    while (cur) {
      if (isFunctionLike(cur)) {
        for (const vd of cur.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          if (nearestFunction(vd) !== cur || vd.getName() !== name) continue;
          const init = vd.getInitializer();
          if (init) return init;
        }
      }
      cur = cur.getParent();
    }
    return null;
  }

  // ------------------------------------------
  // 工具
  // ------------------------------------------

  private impKey(file: string, name: string): string {
    return `${file}\u0000${name}`;
  }

  /** 记一次跨声明跳转；超出上限返回 false（防 `const a=b; const b=a` 这类环） */
  private hop(ctx: Ctx): boolean {
    if (!ctx.hops) ctx.hops = { n: 0 };
    ctx.hops.n++;
    return ctx.hops.n <= MAX_HOPS;
  }

  /** `require('x')` 的模块路径 */
  private modulePathOf(init: Node): string | null {
    if (Node.isCallExpression(init)) {
      if (init.getExpression().getText() !== 'require') return null;
      const a = init.getArguments()[0];
      if (a && Node.isStringLiteral(a)) return a.getLiteralValue();
    }
    if (Node.isPropertyAccessExpression(init)) {
      const inner = init.getExpression();
      if (Node.isCallExpression(inner) && inner.getExpression().getText() === 'require') {
        const a = inner.getArguments()[0];
        if (a && Node.isStringLiteral(a)) return a.getLiteralValue();
      }
    }
    return null;
  }

  /** 相对模块路径 → 仓库内真实文件 */
  private resolveModule(fromFile: string, modulePath: string): string | null {
    if (!modulePath.startsWith('.')) return null;
    const joined = this.normalize(`${this.dirname(fromFile)}/${modulePath}`);
    for (const ext of ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts', '.vue']) {
      const cand = joined + ext;
      if (this.files.has(cand)) return cand;
    }
    return null;
  }

  private dirname(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  private normalize(p: string): string {
    const parts: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }
}
