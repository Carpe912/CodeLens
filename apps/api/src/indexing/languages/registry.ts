/**
 * 语言注册表 —— 「扩展名 → 适配器」的**唯一**映射来源。
 *
 * ============================================================
 * 加一门语言，只需要改这个文件的一行 `register(…)`。
 * ============================================================
 *
 * 为什么需要它（历史包袱）：
 * 受支持的扩展名原本散在三处，而且**三处互不相同**：
 *
 * | 位置 | 清单 |
 * |---|---|
 * | `indexer.ts` 的 `collectFiles` | `.ts .tsx .js .jsx .vue`（**唯一入库闸门**） |
 * | `relationship-builder.ts` | 多 `.mjs .cjs .json` |
 * | `url-resolver.ts` 的 import 解析 | 又一份 |
 *
 * 「扫描到的文件」和「能解析的文件」用两份清单，一旦漂移就会出现
 * 「文件在库里、但抽不出任何东西」——这正是 `.vue` 曾经 0 chunk 的成因。
 * 现在只有 `supportedExtensions` 一份，且它**由适配器自己声明**，不可能漂移。
 */

import * as path from 'path';
import type {
  LanguageId,
  LanguageRegistry,
  RepoScopedParser,
} from './types.js';
import { createTypeScriptFamilyParsers } from './typescript/index.js';

/**
 * 按扩展名分发的注册表实现。
 *
 * ⚠️ 用 `path.extname()` 而不是 `endsWith()`：精准匹配**最后一段**扩展名，
 * 避免 `'foo.less.vue'` 这类多段后缀被前一个规则抢走。
 */
class ExtensionKeyedRegistry implements LanguageRegistry {
  /** 扩展名（小写、含点）→ 适配器 */
  private readonly byExtension = new Map<string, RepoScopedParser>();
  /** 语言标识 → 适配器 */
  private readonly byLanguage = new Map<LanguageId, RepoScopedParser>();
  private cachedExtensions: readonly string[] | null = null;

  register(parser: RepoScopedParser): void {
    for (const rawExt of parser.extensions) {
      // 容错：允许写成 'ts' 或 '.ts'，统一成小写带点
      const ext = (rawExt.startsWith('.') ? rawExt : `.${rawExt}`).toLowerCase();
      this.byExtension.set(ext, parser);
    }
    this.byLanguage.set(parser.id, parser);
    // 失效缓存（新语言注册后必须让 supportedExtensions 重新聚合）
    this.cachedExtensions = null;
  }

  forFile(filePath: string): RepoScopedParser | null {
    const ext = path.extname(filePath).toLowerCase();
    const byExt = this.byExtension.get(ext);
    if (byExt) return byExt;

    // 扩展名兜不住时退到内容嗅探（`.vue` 这类「宿主容器」文件
    // 将来若有需要，可以由适配器声明 sniff 来接管）
    for (const parser of this.byLanguage.values()) {
      if (parser.sniff?.(filePath, '')) return parser;
    }
    return null;
  }

  byId(id: LanguageId): RepoScopedParser | null {
    return this.byLanguage.get(id) ?? null;
  }

  all(): RepoScopedParser[] {
    return [...this.byLanguage.values()];
  }

  get supportedExtensions(): readonly string[] {
    if (!this.cachedExtensions) {
      this.cachedExtensions = [...this.byExtension.keys()].sort();
    }
    return this.cachedExtensions;
  }
}

/** 建一个空注册表（测试用；生产用下面那个默认实例） */
export function createLanguageRegistry(): LanguageRegistry {
  return new ExtensionKeyedRegistry();
}

/**
 * 注册全部内置语言适配器。
 *
 * 新增一门语言 = 在这里多一行 `registry.register(createXxxParser())`。
 * 不需要改 `indexer.ts` / `enhanced-indexer.ts` / `relationship-builder.ts` /
 * DB schema / 检索层 / 前端。
 */
export function createDefaultLanguageRegistry(): LanguageRegistry {
  const registry = createLanguageRegistry();
  // TS/JS 与 Vue 同族，共享一个 ts-morph 分析器实例 → 一次产出两个适配器
  for (const parser of createTypeScriptFamilyParsers()) registry.register(parser);
  // 将来（每个新语言 = 多一行，不需要动任何其他文件）：
  //   registry.register(createJavaParser());     // languages/java/index.ts
  //   registry.register(createPythonParser());   // languages/python/index.ts
  return registry;
}

/**
 * 进程内共享的默认注册表。
 *
 * ⚠️ 适配器实例是**有状态**的（整仓符号表寄生在里面），所以这里只能有一个实例。
 * 调用 `beginRepo()` 之后必须成对调用 `endRepo()`。
 */
export const languageRegistry: LanguageRegistry = createDefaultLanguageRegistry();
