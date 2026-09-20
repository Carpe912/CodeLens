/**
 * 接口清单面板 —— 把仓库页那个「接口 238」的数字，展开成**可枚举的清单**。
 *
 * ============================================================
 * 为什么这件事必须走结构化查询，而不是「让用户去问 /ask」
 * ============================================================
 * 「这个仓库有哪些接口」是**集合类问题**。检索式问答只会给 top-K，
 * 而 top-K 回答的是「最相似的 K 条」—— 在数学上无法保证完备。
 * 调 K、加 rerank、换嵌入模型都不解决。想完备只能读 `url_patterns`。
 *
 * 所以这个面板直接打 `GET /repos/:id/url-patterns`：**没有 limit**，
 * 条数即全集。这也是为什么界面上要显式写出「共 N 个」而不是「前 N 条」。
 *
 * ============================================================
 * 三个数字不能混用（界面上也刻意分开显示）
 * ============================================================
 *   total              283  `url_patterns` 原始行（未合并）
 *   rows.length        277  按 (method, realPath) 合并后
 *   distinctInterfaces 238  其中 method 已判定的
 * 直接拿 277 当「接口数」会虚高 —— 里面混着前端路由、构建产物、界面文案。
 *
 * ============================================================
 * 判定「是不是接口」不在前端做
 * ============================================================
 * method 未判定的行由后端 `classifyUndecidedRow` 标注为
 * interface / not-interface / unknown，前端只负责**分组展示**。
 * 前端若自己再写一套字符串规则，界面和 `/ask` 的回答迟早会给出互相矛盾的数字。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../../utils/constants';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { UndecidedKind, UrlInventory, UrlPatternRow } from '../../types';

/** method 徽标配色。沿用中国股市习惯之外的中性语义色，不做涨跌暗示 */
const METHOD_CLASS: Record<string, string> = {
  GET: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  POST: 'bg-blue-50 text-blue-700 border-blue-200',
  PUT: 'bg-amber-50 text-amber-700 border-amber-200',
  DELETE: 'bg-rose-50 text-rose-700 border-rose-200',
  PATCH: 'bg-purple-50 text-purple-700 border-purple-200',
};

function methodClass(method: string | null): string {
  return method ? METHOD_CLASS[method] ?? 'bg-slate-100 text-slate-600 border-slate-200'
    : 'bg-amber-50 text-amber-700 border-amber-200';
}

/**
 * 分组键：按**后端前缀**分，读起来像一份 API 文档。
 *
 * 取两段（`/rest/quality/a/...` → `/rest/quality`）而不是一段：
 * 一段会把 168 条全塞进一个 `/rest` 组，等于没分。
 * 注意这是**展示层**的分组，不影响任何计数口径。
 */
function groupKey(row: UrlPatternRow): string {
  const real = row.realPath;
  if (!real) return '未展开（依赖运行时变量）';
  if (/^https?:\/\//i.test(real)) return '外部地址';
  const segs = real.split('/').filter(Boolean);
  if (segs.length === 0) return '其它';
  if ((segs[0] === 'rest' || segs[0] === 'plugin') && segs.length >= 2) {
    return `/${segs[0]}/${segs[1]}`;
  }
  return `/${segs[0]}`;
}

const UNDECIDED_GROUPS: Array<{ kind: UndecidedKind; title: string; hint: string; tone: string }> = [
  {
    kind: 'interface',
    title: '是真接口，只是 method 没推断出来',
    hint: '路径确认属于后端接口，但 HTTP 方法写在变量里。**计数时应该算进去**。',
    tone: 'border-emerald-200 bg-emerald-50/60',
  },
  {
    kind: 'not-interface',
    title: '不是接口',
    hint: '前端路由 / 构建产物 / 界面文案 / 外部地址。**计数时不能算**。',
    tone: 'border-slate-200 bg-slate-50',
  },
  {
    kind: 'unknown',
    title: '需人工判定',
    hint: '没匹配上任何已知特征。这里刻意不猜 —— 宁可留白也不要给个像真的结论。',
    tone: 'border-amber-200 bg-amber-50/60',
  },
];

type Props = {
  repoId: string;
};

export function InterfaceInventoryPanel({ repoId }: Props) {
  const [data, setData] = useState<UrlInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [methodFilter, setMethodFilter] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [showPending, setShowPending] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/repos/${repoId}/url-patterns`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // 老服务上这个路由不存在（404）—— 如实说明，不要显示成空清单，
          // 否则用户会以为「这个仓库一个接口都没有」。
          throw new Error(`接口清单返回 ${res.status}`);
        }
        setData((await res.json()) as UrlInventory);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const rows = data?.rows ?? [];

  /** 应用筛选后的行（含未判定行 —— 未判定是「要不要排除」的开关，不是筛选条件） */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (methodFilter && (r.method ?? '') !== methodFilter) return false;
      if (!kw) return true;
      return [r.realPath ?? '', r.pattern, r.definitionFile ?? '']
        .join(' ')
        .toLowerCase()
        .includes(kw);
    });
  }, [rows, methodFilter, keyword]);

  /** 已判定的行，按前缀分组 */
  const groups = useMemo(() => {
    const map = new Map<string, UrlPatternRow[]>();
    for (const r of filtered) {
      if (r.method === null) continue;
      const k = groupKey(r);
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const undecided = useMemo(() => filtered.filter((r) => r.method === null), [filtered]);
  const decidedCount = filtered.length - undecided.length;

  /** 可调用接口数：method 已判定 + method 未判定但路径确认是接口的 */
  const undecidedInterfaces = useMemo(
    () => filtered.filter((r) => r.classification?.kind === 'interface'),
    [filtered]
  );

  const methodChips = useMemo(() => {
    const m = data?.byMethod ?? {};
    return Object.keys(m)
      .filter((k) => k !== '(未判定)')
      .sort((a, b) => m[b] - m[a]);
  }, [data]);

  const toggleGroup = (k: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  /** 复制当前筛选结果为 Markdown —— 用户要的是「能拿走的清单」，不是只能看的表 */
  const copyAsMarkdown = useCallback(async () => {
    const lines: string[] = [];
    lines.push(`# 仓库 #${repoId} 接口清单（共 ${decidedCount} 个，已判定 method）`);
    lines.push('');
    for (const [name, list] of groups) {
      lines.push(`## ${name} (${list.length})`);
      lines.push('');
      lines.push('| Method | 路径 | 定义位置 |');
      lines.push('| --- | --- | --- |');
      for (const r of list) {
        const loc = r.definitionFile ? `\`${r.definitionFile}:${r.definitionLine ?? 0}\`` : '—';
        lines.push(`| ${r.method ?? ''} | \`${r.realPath ?? r.pattern}\` | ${loc} |`);
      }
      lines.push('');
    }
    for (const g of UNDECIDED_GROUPS) {
      const list = undecided.filter((r) => (r.classification?.kind ?? 'unknown') === g.kind);
      if (list.length === 0) continue;
      lines.push(`## ${g.title} (${list.length})`);
      lines.push('');
      for (const r of list) {
        lines.push(`- \`${r.realPath ?? r.pattern}\` — ${r.classification?.reason ?? '—'}`);
      }
      lines.push('');
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [repoId, groups, undecided, decidedCount]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner className="h-6 w-6 border-cyan-600" />
          <span className="text-xs text-slate-500">正在读取接口清单…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50 p-8">
        <div className="max-w-md text-center space-y-2">
          <div className="text-sm font-medium text-rose-600">无法读取接口清单</div>
          <div className="text-xs text-slate-500 font-mono break-all">{error}</div>
          <div className="text-xs text-slate-400">
            该清单来自结构化路由 <span className="font-mono">/repos/:id/url-patterns</span>；
            若线上服务版本较旧会返回 404。
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* ==================== 口径说明 + 筛选条（吸顶） ==================== */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white px-5 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs" data-testid="inv-scope">
          <span className="text-slate-500">
            原始行 <b className="font-mono text-slate-700">{data.total}</b>
          </span>
          <span className="text-slate-300">→</span>
          <span className="text-slate-500">
            按 (method, 路径) 合并 <b className="font-mono text-slate-700">{data.rows.length}</b>
          </span>
          <span className="text-slate-300">→</span>
          <span className="text-slate-500">
            其中 <b className="font-mono text-slate-700">{data.distinctInterfaces}</b> 个已判定 method
          </span>
          <span className="text-slate-500">
            ，<b className="font-mono text-emerald-700">{undecidedInterfaces.length}</b> 个是接口但未判定
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-emerald-600">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            结构化查询，条数即全集（非 top-K）
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            data-testid="inv-chip-all"
            onClick={() => setMethodFilter('')}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
              methodFilter === ''
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
            }`}
          >
            全部 {decidedCount}
          </button>
          {methodChips.map((m) => {
            const active = methodFilter === m;
            return (
              <button
                key={m}
                data-testid="inv-chip"
                data-method={m}
                onClick={() => setMethodFilter(active ? '' : m)}
                className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-slate-900 text-white border-slate-900'
                    : `${METHOD_CLASS[m] ?? 'bg-slate-100 text-slate-600 border-slate-200'} hover:brightness-95`
                }`}
              >
                {m} {data.byMethod[m]}
              </button>
            );
          })}

          <input
            data-testid="inv-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="过滤：路径 / 原始写法 / 文件名…"
            className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs
                       text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
          />

          <button
            data-testid="inv-pending-toggle"
            onClick={() => setShowPending((v) => !v)}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
              showPending
                ? 'bg-amber-500 text-white border-amber-500'
                : 'bg-white text-amber-700 border-amber-200 hover:border-amber-400'
            }`}
          >
            method 未判定 {undecided.length}
          </button>

          <button
            data-testid="inv-copy"
            onClick={copyAsMarkdown}
            className="px-3 py-1 rounded-lg text-xs font-medium border border-slate-200
                       bg-white text-slate-600 hover:border-slate-400 transition-colors"
          >
            {copied ? '已复制' : '复制为 Markdown'}
          </button>
        </div>
      </div>

      {/* ==================== 清单主体 ==================== */}
      <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
        {groups.length === 0 && undecided.length === 0 && (
          <div className="text-center text-xs text-slate-400 py-16">
            当前筛选条件下没有匹配的接口。
          </div>
        )}

        {groups.map(([name, list]) => {
          const isCollapsed = collapsed.has(name);
          return (
            <section key={name} data-testid="inv-group" data-group={name}>
              <button
                onClick={() => toggleGroup(name)}
                className="flex items-center gap-2 mb-2 text-left group"
              >
                <svg
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                    isCollapsed ? '-rotate-90' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                <span className="text-sm font-semibold text-slate-800 font-mono group-hover:text-cyan-700">
                  {name}
                </span>
                <span className="text-xs text-slate-400">{list.length}</span>
              </button>

              {!isCollapsed && (
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-3 py-2 text-[11px] font-medium text-slate-500 w-20">方法</th>
                        <th className="px-3 py-2 text-[11px] font-medium text-slate-500">真实路径</th>
                        <th className="px-3 py-2 text-[11px] font-medium text-slate-500">
                          源码里的原始写法
                        </th>
                        <th className="px-3 py-2 text-[11px] font-medium text-slate-500 w-64">
                          定义位置
                        </th>
                        <th className="px-3 py-2 text-[11px] font-medium text-slate-500 w-16 text-right">
                          调用点
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <tr
                          key={r.id}
                          data-testid="inv-row"
                          data-method={r.method ?? ''}
                          data-path={r.realPath ?? r.pattern}
                          /**
                           * 搜索的**完整命中面**（路径 / 原始写法 / 定义文件）。
                           * 只暴露 data-path 会让验收脚本误判「这行不该出现」——
                           * 实际上它靠文件名命中（如 TestScenarioData/index.ts）。
                           */
                          data-key={[r.realPath ?? '', r.pattern, r.definitionFile ?? '']
                            .join(' ')
                            .toLowerCase()}
                          className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70"
                        >
                          <td className="px-3 py-2 align-top">
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded border text-[10px]
                                          font-semibold ${methodClass(r.method)}`}
                            >
                              {r.method}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className="font-mono text-xs text-slate-800 break-all">
                              {r.realPath ?? (
                                <span className="text-slate-400 italic not-italic">
                                  无法静态展开
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className="font-mono text-[11px] text-slate-400 break-all">
                              {r.pattern}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className="font-mono text-[11px] text-slate-500 break-all">
                              {r.definitionFile ? `${r.definitionFile}:${r.definitionLine ?? 0}` : '—'}
                            </span>
                          </td>
                          <td
                            className="px-3 py-2 align-top text-right font-mono text-[11px] text-slate-500"
                            title={r.usageFiles.join('\n')}
                          >
                            {r.usageCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}

        {/* ==================== method 未判定（默认收起） ==================== */}
        {showPending && undecided.length > 0 && (
          <section className="pt-2">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-800">
                method 未判定的 {undecided.length} 条
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                索引器没能从调用点推断出 HTTP 方法。这批里**混着两种东西**，所以既不能整批当接口，
                也不能直接删掉 —— 下面按判定结果分开列。
              </p>
            </div>

            <div className="space-y-3">
              {UNDECIDED_GROUPS.map((g) => {
                const list = undecided.filter(
                  (r) => (r.classification?.kind ?? 'unknown') === g.kind
                );
                if (list.length === 0) return null;
                return (
                  <div
                    key={g.kind}
                    data-testid="inv-pending-bucket"
                    data-kind={g.kind}
                    className={`rounded-lg border ${g.tone} overflow-hidden`}
                  >
                    <div className="px-4 py-2.5 border-b border-black/5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold text-slate-700">{g.title}</span>
                        <span className="text-xs text-slate-500">{list.length} 条</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{g.hint}</div>
                    </div>
                    <table className="w-full text-left bg-white/60">
                      <tbody>
                        {list.map((r) => (
                          <tr key={r.id} className="border-b border-black/5 last:border-b-0">
                            <td className="px-4 py-2 align-top w-1/3">
                              <span className="font-mono text-xs text-slate-800 break-all">
                                {r.realPath ?? r.pattern}
                              </span>
                            </td>
                            <td className="px-4 py-2 align-top w-1/3">
                              <span className="font-mono text-[11px] text-slate-500 break-all">
                                {r.definitionFile
                                  ? `${r.definitionFile}:${r.definitionLine ?? 0}`
                                  : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-2 align-top">
                              <span className="text-[11px] text-slate-600">
                                {r.classification?.reason ?? '—'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
