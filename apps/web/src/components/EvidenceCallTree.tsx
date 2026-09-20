/**
 * 证据调用树
 *
 * 把 `/ask` 返回的平铺 evidence 列表，按 `call_graph` 渲染成一棵可展开的调用树，
 * 解决「10 条证据各自独立、看不出谁调用谁」的问题。
 *
 * 数据来自后端 `POST /call-tree`（见 apps/api/src/analysis/evidence-call-tree.ts）。
 * 该接口刻意**不隐藏不确定性**：
 * - 未解析的调用（库函数 / 内置对象 / 非顶层符号）不会消失，而是聚合在「外部调用」组里；
 * - 同名多候选的节点带 `ambiguous` 标记，展开结果可能不精确；
 * - 被过滤掉的「声明行自调用」伪影数量会在头部说明。
 *
 * 之所以这样设计：这是一棵树给人看的**可视化辅助**，不是权威结论。
 * 把不确定的部分藏起来，比显示出来更容易误导。
 */

import { useEffect, useMemo, useState } from 'react';
import type { SearchHit } from '../types';
// 复用全局 API 基址，避免同一个环境里出现两个不同的后端地址
import { API_BASE } from '../utils/constants';

interface CallTreeCaller {
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  callLine: number | null;
}

interface CallTreeNode {
  key: string;
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  chunkId: number | null;
  callLine: number | null;
  isEvidence: boolean;
  resolved: boolean;
  ambiguous: boolean;
  candidateCount: number;
  candidates?: Array<{ filePath: string; lineStart: number | null }>;
  cyclic: boolean;
  truncated: boolean;
  children: CallTreeNode[];
}

interface CallTreeRoot extends CallTreeNode {
  callers: CallTreeCaller[];
}

interface CallTreeStats {
  evidenceInput: number;
  evidenceResolved: number;
  nodes: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  ambiguousNodes: number;
  selfLoopEdgesFiltered: number;
  cyclesDetected: number;
  truncated: boolean;
  maxDepth: number;
}

interface CallTreeResponse {
  repoId: number;
  roots: CallTreeRoot[];
  stats: CallTreeStats;
  warnings: Array<{ code: string; message: string }>;
}

type EvidenceCallTreeProps = {
  repoId: string;
  items: SearchHit[];
  maxDepth?: number;
  onOpenCallGraph?: (symbol: string) => void;
};

// 符号类型 → 徽章配色。
// ⚠️ 每一种都要给**显式**取值，否则落到 unknown 的灰底 —— 而灰底在暗色主题下几乎看不见。
// 2026-09-19 补了 interface / type / enum / module 四种：
//   - interface / type / enum 是解析器本来就会产的类型（缺少配色 → 明明命中却显示成"未知"）；
//   - module 是「整文件兜底块」（barrel 文件、纯模板组件等）—— 它**不是符号命中**，
//     所以刻意用中性灰蓝，和真符号区分开。
const SYMBOL_TYPE_STYLE: Record<string, string> = {
  function: 'bg-blue-100 text-blue-700 border-blue-200',
  method: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  class: 'bg-purple-100 text-purple-700 border-purple-200',
  variable: 'bg-amber-100 text-amber-700 border-amber-200',
  constant: 'bg-orange-100 text-orange-700 border-orange-200',
  interface: 'bg-violet-100 text-violet-700 border-violet-200',
  enum: 'bg-teal-100 text-teal-700 border-teal-200',
  module: 'bg-slate-200 text-slate-700 border-slate-300',
  url: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  unknown: 'bg-gray-100 text-gray-500 border-gray-200',
};

function typeChip(type: string, title?: string) {
  const cls = SYMBOL_TYPE_STYLE[type] ?? SYMBOL_TYPE_STYLE.unknown;
  return (
    <span
      title={title}
      className={`px-1.5 py-[1px] rounded border font-mono text-[10px] leading-4 flex-shrink-0 ${cls} ${
        title ? 'cursor-help' : ''
      }`}
    >
      {type}
    </span>
  );
}

function shortPath(p: string | null): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

/** 收集需要默认展开的 key：只在根节点处展开一层，让调用关系一眼可见 */
function collectRootKeys(roots: CallTreeRoot[]): Set<string> {
  const s = new Set<string>();
  roots.forEach((r) => {
    if (r.children.length > 0) s.add(r.key);
  });
  return s;
}

/** 递归收集全部有子节点的 key，供「全部展开」使用 */
function collectAllExpandable(roots: CallTreeRoot[]): Set<string> {
  const s = new Set<string>();
  const walk = (n: CallTreeNode) => {
    if (n.children.length > 0) {
      s.add(n.key);
      n.children.forEach(walk);
    }
  };
  roots.forEach(walk);
  return s;
}

export function EvidenceCallTree({ repoId, items, maxDepth = 2, onOpenCallGraph }: EvidenceCallTreeProps) {
  const [data, setData] = useState<CallTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 证据集变了才重新请求：用 symbol+file 拼出的签名做依赖，避免每次渲染都打接口
  const signature = useMemo(
    () => items.map((i) => `${i.symbol_name}@${i.file_path}`).join('|'),
    [items]
  );

  useEffect(() => {
    if (!repoId || items.length === 0) {
      setData(null);
      return;
    }
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/call-tree`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 只传 symbol + filePath：证据里的 id 来自 functions/string_constants 表，
          // 不是 code_chunks 主键，传过去也没用（后端会按名字重新解析）
          body: JSON.stringify({
            repoId: Number(repoId),
            symbols: items.map((i) => ({ symbol: i.symbol_name, filePath: i.file_path })),
            maxDepth,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`调用树接口返回 ${res.status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
        }
        const json: CallTreeResponse = await res.json();
        setData(json);
        setExpanded(collectRootKeys(json.roots));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, signature, maxDepth]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (items.length === 0) {
    return (
      <div className="text-gray-500 text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
        未找到相关代码，无法构建调用树
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-3 text-gray-500 text-sm">
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          正在按 call_graph 构建调用树...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 px-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-800">
        调用树构建失败：{error}
        <div className="mt-1 text-xs text-amber-700">
          证据列表仍可正常查看 —— 调用树是叠加视图，不影响检索结果本身。
        </div>
      </div>
    );
  }

  if (!data || data.roots.length === 0) {
    return (
      <div className="text-gray-500 text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
        暂无调用关系数据
      </div>
    );
  }

  const { stats, warnings } = data;
  const allExpandable = collectAllExpandable(data.roots);
  const expandableCount = allExpandable.size;

  // 根节点就是证据本身，列表视图已经给过它一个类型标签。
  // 两处标签来自不同口径：列表用 `SearchResult['type']`（按来源表 coarse 归类，functions→function），
  // 树用 `code_chunks.symbol_type`（AST 精确类型，method/method）。同一个符号两个标签会让人以为其中一个是错的，
  // 所以根节点跟随列表口径，精确类型放到 title 里。
  const evidenceTypeBySymbol = new Map<string, string>();
  items.forEach((i) => {
    if (i.symbol_name && !evidenceTypeBySymbol.has(i.symbol_name)) {
      evidenceTypeBySymbol.set(i.symbol_name, i.symbol_type);
    }
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600">
        <span>
          证据 <b className="text-gray-900">{stats.evidenceResolved}</b>/{stats.evidenceInput} 条解析到定义
        </span>
        <span>
          调用边 <b className="text-gray-900">{stats.resolvedEdges}</b> 条已解析
        </span>
        <span className={stats.unresolvedEdges > 0 ? 'text-gray-400' : ''}>
          外部/未解析 {stats.unresolvedEdges} 条
        </span>
        {stats.ambiguousNodes > 0 && (
          <span className="text-amber-700">同名歧义 {stats.ambiguousNodes} 个</span>
        )}
        {stats.selfLoopEdgesFiltered > 0 && <span className="text-gray-400">已过滤声明伪影 {stats.selfLoopEdgesFiltered} 条</span>}
        <span className="text-gray-400">深度 {stats.maxDepth}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setExpanded(allExpandable)}
            className="px-2 py-0.5 border border-gray-300 rounded hover:bg-white text-gray-600 transition-all"
          >
            全部展开
          </button>
          <button
            onClick={() => setExpanded(new Set())}
            className="px-2 py-0.5 border border-gray-300 rounded hover:bg-white text-gray-600 transition-all"
          >
            全部收起
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <details className="px-3 py-2 bg-amber-50/60 border border-amber-200 rounded-lg text-xs text-amber-800">
          <summary className="cursor-pointer select-none">
            数据可信度说明（{warnings.length} 条）—— 建议先看一眼
          </summary>
          <ul className="mt-2 space-y-1 list-disc list-inside leading-relaxed">
            {warnings.map((w) => (
              <li key={w.code}>
                <span className="font-mono text-[10px] text-amber-700">{w.code}</span> {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 bg-gray-50/60 text-[11px] text-gray-500 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" /> 证据命中
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> 解析到的被调用方
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-300" /> 未解析（库/内置）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" /> 同名歧义
          </span>
          <span className="ml-auto">点击「调用图」可深挖单个符号</span>
        </div>

        <div className="p-2">
          {data.roots.map((root, idx) => (
            <RootRow
              key={root.key}
              root={root}
              index={idx + 1}
              expanded={expanded}
              onToggle={toggle}
              onOpenCallGraph={onOpenCallGraph}
              evidenceType={evidenceTypeBySymbol.get(root.symbol)}
            />
          ))}
        </div>
      </div>

      <div className="text-[11px] text-gray-400 px-1">
        共 {stats.nodes} 个节点，{expandableCount} 个可展开。未解析项多为内置对象（this / Promise）与库方法（map / push），
        它们不是仓内顶层符号，因此无法给出定义位置。
      </div>
    </div>
  );
}

function RootRow({
  root,
  index,
  expanded,
  onToggle,
  onOpenCallGraph,
  evidenceType,
}: {
  root: CallTreeRoot;
  index: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpenCallGraph?: (symbol: string) => void;
  /** 列表视图里这个符号的类型标签，用于两边保持一致 */
  evidenceType?: string;
}) {
  const isOpen = expanded.has(root.key);
  const hasChildren = root.children.length > 0;
  const chipType = evidenceType || root.symbolType;
  const chipTitle =
    evidenceType && evidenceType !== root.symbolType
      ? `code_chunks 精确类型：${root.symbolType}`
      : undefined;

  return (
    <div className="mb-1 last:mb-0">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-50 transition-all">
        <button
          onClick={() => hasChildren && onToggle(root.key)}
          className={`w-5 h-5 flex items-center justify-center rounded flex-shrink-0 ${
            hasChildren ? 'text-gray-500 hover:bg-gray-200' : 'text-transparent'
          }`}
          aria-label={isOpen ? '收起' : '展开'}
          disabled={!hasChildren}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-blue-600 text-white text-[10px] font-bold flex-shrink-0">
          {index}
        </span>

        {typeChip(chipType, chipTitle)}
        <span className="text-sm font-semibold text-gray-900 font-mono truncate">{root.symbol}</span>

        {root.filePath && (
          <span className="text-xs text-gray-500 font-mono truncate">
            {shortPath(root.filePath)}
            {root.lineStart != null ? `:${root.lineStart}` : ''}
          </span>
        )}

        {root.ambiguous && <AmbiguousBadge node={root} />}
        {!root.resolved && <UnresolvedBadge />}

        {hasChildren && (
          <span className="text-[10px] text-gray-400 flex-shrink-0">→ {root.children.length}</span>
        )}

        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {root.callers.length > 0 && (
            <span
              className="text-[10px] px-1.5 py-[1px] rounded bg-indigo-50 border border-indigo-200 text-indigo-700"
              title={root.callers.map((c) => `${c.symbol} (${shortPath(c.filePath)})`).join('\n')}
            >
              ↑ 被 {root.callers.length} 处调用
            </span>
          )}
          {onOpenCallGraph && (
            <button
              onClick={() => onOpenCallGraph(root.symbol)}
              className="px-2 py-0.5 bg-purple-100 border border-purple-200 text-purple-700 rounded hover:bg-purple-200 transition-all text-[10px] font-medium"
            >
              调用图
            </button>
          )}
        </div>
      </div>

      {isOpen && hasChildren && (
        <div className="ml-[13px] border-l border-gray-200 pl-3 pt-0.5">
          <ChildList nodes={root.children} depth={1} expanded={expanded} onToggle={onToggle} onOpenCallGraph={onOpenCallGraph} />
        </div>
      )}
    </div>
  );
}

/**
 * 子节点列表。
 *
 * 未解析的调用（`resolved === false`）不逐个铺开，而是聚合成一个「外部调用」组 ——
 * 它们通常是 this / Promise / map / push 这类内置与库方法，逐个列会把树冲垮。
 */
function ChildList({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpenCallGraph,
}: {
  nodes: CallTreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpenCallGraph?: (symbol: string) => void;
}) {
  const resolved = nodes.filter((n) => n.resolved);
  const unresolved = nodes.filter((n) => !n.resolved);

  return (
    <div>
      {resolved.map((node) => (
        <ChildRow
          key={node.key}
          node={node}
          depth={depth}
          expanded={expanded}
          onToggle={onToggle}
          onOpenCallGraph={onOpenCallGraph}
        />
      ))}
      {unresolved.length > 0 && (
        <ExternalGroup nodes={unresolved} groupKey={`ext-${nodes[0]?.key ?? depth}`} expanded={expanded} onToggle={onToggle} />
      )}
    </div>
  );
}

function ChildRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenCallGraph,
}: {
  node: CallTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpenCallGraph?: (symbol: string) => void;
}) {
  const isOpen = expanded.has(node.key);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-gray-50 transition-all">
        <button
          onClick={() => hasChildren && onToggle(node.key)}
          className={`w-4 h-4 flex items-center justify-center rounded flex-shrink-0 ${
            hasChildren ? 'text-gray-400 hover:bg-gray-200' : 'text-transparent'
          }`}
          aria-label={isOpen ? '收起' : '展开'}
          disabled={!hasChildren}
        >
          <svg
            className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
        {typeChip(node.symbolType)}
        <span className="text-sm text-gray-800 font-mono truncate">{node.symbol}</span>

        {node.candidates && node.candidates.length > 0 && (
          <span className="text-[10px] text-gray-400 font-mono truncate">
            {shortPath(node.candidates[0].filePath)}
          </span>
        )}

        {node.cyclic && (
          <span className="text-[10px] px-1.5 py-[1px] rounded bg-rose-50 border border-rose-200 text-rose-700 flex-shrink-0">
            ↻ 成环，未再展开
          </span>
        )}
        {node.ambiguous && <AmbiguousBadge node={node} />}
        {node.callLine != null && (
          <span className="text-[10px] text-gray-300 flex-shrink-0">L{node.callLine}</span>
        )}

        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {hasChildren && <span className="text-[10px] text-gray-400">→ {node.children.length}</span>}
          {onOpenCallGraph && (
            <button
              onClick={() => onOpenCallGraph(node.symbol)}
              className="px-1.5 py-0.5 text-purple-600 border border-purple-200 rounded hover:bg-purple-50 transition-all text-[10px]"
            >
              调用图
            </button>
          )}
        </div>
      </div>

      {isOpen && hasChildren && (
        <div className="ml-[11px] border-l border-gray-200 pl-3">
          <ChildList nodes={node.children} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpenCallGraph={onOpenCallGraph} />
        </div>
      )}
    </div>
  );
}

/** 未解析调用的聚合组：默认收起，展开后只列名字 */
function ExternalGroup({
  nodes,
  groupKey,
  expanded,
  onToggle,
}: {
  nodes: CallTreeNode[];
  groupKey: string;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  const isOpen = expanded.has(groupKey);
  const names = nodes.map((n) => n.symbol);

  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-gray-50 transition-all">
        <button
          onClick={() => onToggle(groupKey)}
          className="w-4 h-4 flex items-center justify-center rounded text-gray-400 hover:bg-gray-200 flex-shrink-0"
          aria-label={isOpen ? '收起' : '展开'}
        >
          <svg
            className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
        <span className="text-xs text-gray-500">
          外部调用 / 未解析 <b className="text-gray-600">{nodes.length}</b> 个
        </span>
        <span className="text-[10px] text-gray-400 font-mono truncate">
          {names.slice(0, 6).join(', ')}
          {names.length > 6 ? ` …+${names.length - 6}` : ''}
        </span>
      </div>
      {isOpen && (
        <div className="ml-[11px] border-l border-gray-200 pl-3 py-0.5">
          <div className="flex flex-wrap gap-1.5 py-1">
            {names.map((n, i) => (
              <span
                key={`${n}-${i}`}
                className="px-1.5 py-[1px] rounded bg-gray-50 border border-gray-200 text-gray-500 font-mono text-[10px]"
              >
                {n}
              </span>
            ))}
          </div>
          <div className="text-[10px] text-gray-400 pb-1">
            这些名字在仓内 `code_chunks` 里找不到同名定义（属于库方法、内置对象或对象属性），
            无法给出定义位置。
          </div>
        </div>
      )}
    </div>
  );
}

function AmbiguousBadge({ node }: { node: CallTreeNode }) {
  const title = node.candidates?.length
    ? `同名候选 ${node.candidateCount} 个：\n` +
      node.candidates.map((c) => `${c.filePath}${c.lineStart != null ? `:${c.lineStart}` : ''}`).join('\n') +
      (node.candidateCount > node.candidates.length ? `\n…还有 ${node.candidateCount - node.candidates.length} 个` : '')
    : `同名候选 ${node.candidateCount} 个，展开结果可能不精确`;
  return (
    <span
      className="text-[10px] px-1.5 py-[1px] rounded bg-amber-100 border border-amber-300 text-amber-800 flex-shrink-0 cursor-help"
      title={title}
    >
      同名 {node.candidateCount} 处
    </span>
  );
}

function UnresolvedBadge() {
  return (
    <span className="text-[10px] px-1.5 py-[1px] rounded bg-gray-100 border border-gray-200 text-gray-500 flex-shrink-0">
      未解析
    </span>
  );
}
