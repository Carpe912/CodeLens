/**
 * 影响面分析面板
 *
 * ============================================================
 * 它补的是什么缺口
 * ============================================================
 * 后端早有 `GET /impact/symbol`（改这个符号会波及谁）与 `GET /impact/file`
 * （改这个文件会波及谁），但**前端没有任何入口** —— 能力做完了却点不到，
 * 是纯粹的界面缺失。
 *
 * 这两个接口基于两条真实的关系数据：
 *   - 符号级：call_graph 的实体级反向传递闭包（to_chunk_id → from_chunk_id）
 *   - 文件级：file_dependencies 的反向传递闭包（谁 import 了我）
 *
 * ============================================================
 * 设计上的两个坚持
 * ============================================================
 *
 * 【1】不隐藏「结论不完整」这件事。
 * `warnings` / `unresolvedEdges` / `truncated` 不是装饰，是这个结论的可信度。
 * 一个「0 个受影响、也没有任何提示」的报告，读起来就是「改这里没有影响」——
 * 而真相可能是调用图里 55% 的边都没解析出来。所以这里专门有一块「结论强度」，
 * 哪怕没有警告也明说「未发现数据缺失」，让使用者知道这是检查过的。
 *
 * 【2】歧义不猜。
 * 同一个符号名可能有多个定义（仓库 29 里 `path` 有 28 个、`constructor` 有 10 个）。
 * 后端此时返回 409 + 候选列表，这里把它渲染成可点选的候选，而不是自己挑一个
 * 或者直接报错 —— 猜错比报错更糟，而且错得看不出来。
 */

import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../utils/constants';
import type {
  AffectedFile,
  AffectedSymbol,
  FileImpactReport,
  ImpactErrorBody,
  SymbolCandidate,
  SymbolImpactReport,
} from '../types';
import { shortPath } from './SymbolCallTree';

export type ImpactKind = 'symbol' | 'file';

/** 文件级才有方向：谁依赖我（改动影响面） / 我依赖谁 */
type Direction = 'dependents' | 'dependencies';

const DEPTH_OPTIONS = [1, 2, 3, 4, 5, 6];

const DIRECTION_META: Record<Direction, { label: string; hint: string }> = {
  dependents: { label: '谁依赖我', hint: '改动这个目标的连带影响' },
  dependencies: { label: '我依赖谁', hint: '这个目标自己依赖了什么' },
};

/**
 * 从输入猜目标是「符号」还是「文件」。
 *
 * 只作为**默认值**，界面上会明确显示当前用的是哪一种并允许切换 ——
 * 猜错了使用者能看见、能改，而不是默默按错误的理解去查。
 */
export function inferImpactKind(target: string): ImpactKind {
  const t = target.trim();
  if (t.includes('/')) return 'file';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|json)$/i.test(t)) return 'file';
  return 'symbol';
}

type ImpactError = {
  status: number;
  body: ImpactErrorBody | null;
  fallback: string;
};

type ImpactPanelProps = {
  repoId: string;
  /** 当前目标：符号名或仓库内文件路径。null = 尚未提交过 */
  target: string | null;
  /** 每次提交自增，使「同一个目标再点一次」也能重新查询 */
  runToken: number;
  /** 由证据行跳进来时的类型建议 */
  initialKind?: ImpactKind;
  /** 点某个受影响节点 → 以它为起点继续分析（交给父组件写回输入框） */
  onDrillDown?: (target: string, kind: ImpactKind) => void;
};

export function ImpactPanel({ repoId, target, runToken, initialKind, onDrillDown }: ImpactPanelProps) {
  // kindOverride = 用户手动切过的类型；null 表示「跟随根据目标推断的结果」
  const [kindOverride, setKindOverride] = useState<ImpactKind | null>(null);
  const [direction, setDirection] = useState<Direction>('dependents');
  const [maxDepth, setMaxDepth] = useState(3);
  /** 消歧后选定的 chunkId */
  const [chunkId, setChunkId] = useState<number | undefined>(undefined);

  const [data, setData] = useState<SymbolImpactReport | FileImpactReport | null>(null);
  const [error, setError] = useState<ImpactError | null>(null);
  const [loading, setLoading] = useState(false);

  const inferredKind = target ? inferImpactKind(target) : 'symbol';
  const kind: ImpactKind = kindOverride ?? initialKind ?? inferredKind;

  // 换目标就丢弃上一轮的手动选择，否则「上一轮的 chunkId / 类型」会被带到新目标上，
  // 表现为「查 A 得到的是 B 的结果」这种很难发现的错。
  useEffect(() => {
    setKindOverride(null);
    setChunkId(undefined);
  }, [target, runToken]);

  const url = useMemo(() => {
    if (!repoId || !target) return null;
    if (kind === 'file') {
      const p = new URLSearchParams({
        repoId,
        path: target,
        maxDepth: String(maxDepth),
        direction,
      });
      return `${API_BASE}/impact/file?${p.toString()}`;
    }
    const p = new URLSearchParams({ repoId, symbolName: target, maxDepth: String(maxDepth) });
    if (chunkId !== undefined) p.set('chunkId', String(chunkId));
    return `${API_BASE}/impact/symbol?${p.toString()}`;
  }, [repoId, target, kind, maxDepth, direction, chunkId]);

  useEffect(() => {
    if (!url) {
      setData(null);
      setError(null);
      return;
    }
    const controller = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          let body: ImpactErrorBody | null = null;
          try {
            body = (await res.json()) as ImpactErrorBody;
          } catch {
            // 非 JSON 错误体（例如网关返回的 HTML），下面用状态码兜底
          }
          setError({ status: res.status, body, fallback: `接口返回 ${res.status}` });
          setData(null);
          return;
        }
        setData((await res.json()) as SymbolImpactReport | FileImpactReport);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError({ status: 0, body: null, fallback: (err as Error).message });
        setData(null);
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [url]);

  const isFile = kind === 'file';
  const unit = isFile ? '个文件' : '个符号';

  return (
    <div className="space-y-4">
      {/* ==================== 控制条 ==================== */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {/* 目标类型：明确显示当前按哪种理解查询，并可切换 */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-slate-500">把输入当成</span>
          <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
            {(['symbol', 'file'] as ImpactKind[]).map((k) => (
              <button
                key={k}
                onClick={() => {
                  setKindOverride(k);
                  setChunkId(undefined);
                }}
                className={`px-2.5 py-1 text-xs transition-all ${
                  kind === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {k === 'symbol' ? '符号' : '文件'}
              </button>
            ))}
          </div>
          {kindOverride === null && target && (
            <span className="text-[11px] text-slate-400" title="根据输入里有没有路径分隔符/扩展名推断">
              （自动判断）
            </span>
          )}
        </div>

        {/* 方向：仅文件级有意义 */}
        {isFile && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-slate-500">方向</span>
            <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
              {(['dependents', 'dependencies'] as Direction[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  title={DIRECTION_META[d].hint}
                  className={`px-2.5 py-1 text-xs transition-all ${
                    direction === d ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {DIRECTION_META[d].label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 深度 */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-slate-500">最大跳数</span>
          <select
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value))}
            className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs text-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
          >
            {DEPTH_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} 跳
              </option>
            ))}
          </select>
        </div>

        {target && (
          <div className="ml-auto text-[11px] text-slate-500 font-mono truncate max-w-[420px]" title={target}>
            {isFile ? DIRECTION_META[direction].label : '谁调用了它'}：{target}
          </div>
        )}
      </div>

      {/* ==================== 尚未提交 ==================== */}
      {!target && (
        <div className="py-8 text-center text-sm text-slate-500 bg-slate-50 rounded-lg border border-slate-200">
          在上方输入一个<b className="text-slate-700">符号名</b>（如 getOrders）或
          <b className="text-slate-700">文件路径</b>（如 test-repo/src/utils/apiFactory.js），
          下面会列出改动它会波及哪些位置。
        </div>
      )}

      {/* ==================== 加载中 ==================== */}
      {target && loading && (
        <div className="flex items-center justify-center py-10 bg-slate-50 rounded-lg border border-slate-200">
          <div className="flex items-center gap-3 text-slate-600 text-sm">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-600" />
            正在沿关系数据做传递闭包…
          </div>
        </div>
      )}

      {/* ==================== 错误 ==================== */}
      {target && !loading && error && (
        <ImpactErrorView
          error={error}
          isFile={isFile}
          target={target}
          onPickCandidate={(c) => {
            setChunkId(c.chunkId);
          }}
        />
      )}

      {/* ==================== 结果 ==================== */}
      {target && !loading && !error && data && (
        <>
          {/* 摘要 */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-50 to-blue-50 border border-cyan-200">
              <span className="text-xs text-slate-500">受影响 </span>
              <span className="text-lg font-semibold text-slate-900 font-mono">{data.totalAffected}</span>
              <span className="text-xs text-slate-500"> {unit}</span>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
              最深 <b className="font-mono text-slate-800">{data.byDepth.length}</b> 跳
              <span className="text-slate-400">（上限 {data.maxDepth}）</span>
            </div>
            {data.truncated && (
              <span className="px-2.5 py-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-800 text-xs font-medium">
                结果被截断
              </span>
            )}
            <div className="text-[11px] text-slate-500 font-mono truncate max-w-[480px]" title={data.target}>
              {data.target}
            </div>
          </div>

          {/* ---------- 结论强度：这是本面板与「看起来完整的假结果」的分界线 ---------- */}
          <div
            className={`rounded-lg border px-3 py-2.5 ${
              data.warnings.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50/60 border-emerald-200'
            }`}
          >
            <div className="flex items-start gap-2">
              <svg
                className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
                  data.warnings.length > 0 ? 'text-amber-600' : 'text-emerald-600'
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {data.warnings.length > 0 ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.16 16.25A2 2 0 005 19z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                )}
              </svg>
              <div className="min-w-0 text-xs leading-relaxed">
                <div className={`font-medium ${data.warnings.length > 0 ? 'text-amber-900' : 'text-emerald-800'}`}>
                  结论强度
                </div>
                {data.warnings.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-amber-900">
                    {data.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-emerald-800">
                    未发现数据缺失：没有未解析的关系边，结果也未被截断。
                  </div>
                )}
                {data.unresolvedEdges > 0 && (
                  <div className="mt-1 text-amber-800">
                    未解析的关系边：<b className="font-mono">{data.unresolvedEdges}</b> 条 —— 这部分影响面无法计算，
                    真实范围可能大于本报告。
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---------- 分层结果 ---------- */}
          {data.totalAffected === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500 bg-slate-50 rounded-lg border border-slate-200">
              没有找到受影响的位置。
              <div className="mt-1 text-xs text-slate-400">
                请看上面的「结论强度」——它说明这是确凿的结论，还是数据不足的表现。
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {data.byDepth.map((group) => (
                <div key={group.depth}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-slate-900 text-white text-[11px] font-bold">
                      {group.depth}
                    </span>
                    <span className="text-xs font-medium text-slate-700">
                      {group.depth === 1 ? '直接' : `第 ${group.depth} 跳`}
                      {isFile ? '依赖' : '调用'}
                    </span>
                    <span className="text-xs text-slate-400">{group.nodes.length} 个</span>
                    <div className="flex-1 h-px bg-slate-200" />
                  </div>

                  {/* 一行一个结果，但**不**给每行单独描边：
                      实测 80 个受影响文件时，80 个独立圆角框会变成一片「栅栏」，
                      反而看不出条目边界。改成一条外框 + divide-y 分隔线，
                      行内靠 hover 高亮指示「这一行可点」。 */}
                  <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
                    {isFile
                      ? (group.nodes as AffectedFile[]).map((n) => (
                          <FileRow key={n.fileId} node={n} onDrillDown={onDrillDown} />
                        ))
                      : (group.nodes as AffectedSymbol[]).map((n) => (
                          <SymbolRow key={n.chunkId} node={n} onDrillDown={onDrillDown} />
                        ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================
 * 子组件
 * ============================================================ */

/**
 * 错误视图
 *
 * 三种状态**分别**说明，而不是统一显示一句「查询失败」：
 * - 404 不是「出错」，而是「这个名字在本仓库没有定义」——要讲清精确匹配、区分大小写
 * - 409 是「需要你选一个」，必须给出候选项
 * - 其它才是真的故障
 */
function ImpactErrorView({
  error,
  isFile,
  target,
  onPickCandidate,
}: {
  error: ImpactError;
  isFile: boolean;
  target: string;
  onPickCandidate: (c: SymbolCandidate) => void;
}) {
  const candidates = error.body?.candidates ?? [];

  if (error.status === 409 && candidates.length > 0) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <div className="text-sm font-medium text-blue-900 mb-1">
          符号「{error.body?.symbolName || target}」有 {candidates.length} 个定义，需要指定是哪一个
        </div>
        <p className="text-xs text-blue-800 mb-3 leading-relaxed">
          同名符号在不同文件里很常见。这里<b>不会替你猜</b> —— 猜错不会报错，只会给出另一个符号的影响面，
          比直接报错更难发现。
        </p>
        <div className="space-y-1.5">
          {candidates.map((c) => (
            <button
              key={c.chunkId}
              onClick={() => onPickCandidate(c)}
              className="w-full text-left px-3 py-2 bg-white hover:bg-blue-100 border border-blue-200 hover:border-blue-400 rounded-lg transition-all"
            >
              <span className="font-mono text-xs text-slate-800">{c.filePath}</span>
              <span className="font-mono text-xs text-slate-500">:{c.startLine}</span>
              <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[11px] text-slate-600">
                {c.symbolType}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const notFound = error.status === 404;

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        notFound ? 'bg-slate-50 border-slate-200' : 'bg-red-50 border-red-200'
      }`}
    >
      <div className={`text-sm font-medium ${notFound ? 'text-slate-800' : 'text-red-800'}`}>
        {notFound ? (isFile ? '仓库里没有这个文件' : '仓库里没有这个符号') : '影响面分析失败'}
      </div>
      <p className={`mt-1 text-xs leading-relaxed ${notFound ? 'text-slate-600' : 'text-red-700'}`}>
        {error.body?.error || error.fallback}
      </p>
      {notFound && (
        <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
          {isFile ? (
            <>
              文件路径要写<b>仓库内相对路径</b>，并且带扩展名，例如
              <span className="font-mono text-slate-700"> test-repo/src/utils/apiFactory.js</span>。
              可以先切到「搜索」模式定位到准确路径，再回来查影响面。
            </>
          ) : (
            <>
              符号名是<b>精确匹配、区分大小写</b>的。可以先切到「搜索」模式确认符号的确切写法，
              或试试「问答」模式用自然语言描述。
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** 单行符号 + 可展开的「为什么被影响」 */
function SymbolRow({
  node,
  onDrillDown,
}: {
  node: AffectedSymbol;
  onDrillDown?: (target: string, kind: ImpactKind) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hover:bg-cyan-50/40 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <svg
            className={`w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="px-1.5 py-0.5 rounded bg-blue-100 border border-blue-200 text-blue-700 text-[11px] font-mono flex-shrink-0">
            {node.symbolType}
          </span>
          <span className="text-sm text-slate-900 font-medium truncate">{node.symbolName}</span>
          <span className="text-xs text-slate-500 font-mono truncate">
            {shortPath(node.filePath)}:{node.startLine}
          </span>
        </button>

        {onDrillDown && (
          <button
            onClick={() => onDrillDown(node.symbolName, 'symbol')}
            title="以这个符号为起点继续分析影响面"
            className="px-2 py-1 bg-white border border-slate-300 text-slate-600 hover:bg-cyan-50 hover:border-cyan-400 hover:text-cyan-700 rounded text-[11px] font-medium transition-all flex-shrink-0"
          >
            追下去
          </button>
        )}
      </div>
      {open && <ChainBlock chain={node.pathChain} />}
    </div>
  );
}

/** 单行文件 + 可展开的「为什么被影响」 */
function FileRow({
  node,
  onDrillDown,
}: {
  node: AffectedFile;
  onDrillDown?: (target: string, kind: ImpactKind) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hover:bg-cyan-50/40 transition-colors">
      <div className="flex items-center gap-3 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <svg
            className={`w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm text-slate-900 font-mono truncate" title={node.path}>
            {node.path}
          </span>
        </button>
        {onDrillDown && (
          <button
            onClick={() => onDrillDown(node.path, 'file')}
            title="以这个文件为起点继续分析影响面"
            className="px-2 py-1 bg-white border border-slate-300 text-slate-600 hover:bg-cyan-50 hover:border-cyan-400 hover:text-cyan-700 rounded text-[11px] font-medium transition-all flex-shrink-0"
          >
            追下去
          </button>
        )}
      </div>
      {open && <ChainBlock chain={node.pathChain} />}
    </div>
  );
}

/**
 * 「为什么会被影响」——把 pathChain 渲染成一条链
 *
 * pathChain 是**从目标到当前节点**的完整路径，首元素是目标自身。
 * 后端返回的标签已经是可读形式（`符号名 (类型 @ 路径:行号)`），这里只负责
 * 把它摆成一条能一眼看懂的链，不再二次解析。
 */
function ChainBlock({ chain }: { chain: string[] }) {
  return (
    <div className="px-3 pb-3 pt-2 border-t border-slate-100 bg-slate-50/70">
      <div className="text-[11px] text-slate-500 mb-1.5">
        为什么会受影响 —— 从目标到这里的{chain.length - 1} 跳：
      </div>
      <ol className="space-y-1">
        {chain.map((label, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                i === 0
                  ? 'bg-slate-800 text-white'
                  : 'bg-white border border-slate-300 text-slate-600'
              }`}
            >
              {i === 0 ? '目标' : `第 ${i} 跳`}
            </span>
            <span className="font-mono text-[11px] text-slate-700 break-all leading-relaxed">
              {label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
