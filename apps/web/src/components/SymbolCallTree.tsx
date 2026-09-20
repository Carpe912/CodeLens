/**
 * 符号调用树 —— 树渲染器
 *
 * `SymbolTreeView`：**纯渲染**组件，接收一份调用树载荷（含 callers/callees），
 * 负责展开/收起、点击查看代码。问答页的「调用关系」面板（QueryCallTree）直接用，
 * 也供 EvidenceCallTree 之外的场景复用。
 *
 * 数据来自后端 `POST /query-call-tree`（见 apps/api/src/analysis/query-call-tree.ts）。
 * 过去还有一个带输入框的独立弹窗（右上角「调用关系」按钮，走 /symbol-call-tree），
 * 其入口已移除 —— 该弹窗随之删除，需要时从 git 历史取回。
 */

import { useEffect, useMemo, useState } from 'react';
import type { CallTreeNode, CallTreePayload } from '../types/callTree';

const TYPE_STYLE: Record<string, string> = {
  function: 'bg-blue-100 text-blue-700 border-blue-200',
  method: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  class: 'bg-purple-100 text-purple-700 border-purple-200',
  variable: 'bg-amber-100 text-amber-700 border-amber-200',
  constant: 'bg-orange-100 text-orange-700 border-orange-200',
  arrow_function: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  unknown: 'bg-gray-100 text-gray-500 border-gray-200',
};

function typeChip(type: string) {
  const cls = TYPE_STYLE[type] ?? TYPE_STYLE.unknown;
  return (
    <span className={`px-1.5 py-[1px] rounded border font-mono text-[10px] leading-4 flex-shrink-0 ${cls}`}>
      {type}
    </span>
  );
}

export function shortPath(p: string | null): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

function collectExpandable(nodes: CallTreeNode[]): Set<string> {
  const s = new Set<string>();
  const walk = (n: CallTreeNode) => {
    if (n.children.length > 0) {
      s.add(n.key);
      n.children.forEach(walk);
    }
  };
  nodes.forEach(walk);
  return s;
}

/**
 * 调用树渲染器。
 *
 * @param data         调用树载荷
 * @param defaultOpen  是否默认展开第一层（默认 true，让双向关系一眼可见）
 */
export function SymbolTreeView({ data, defaultOpen = true }: { data: CallTreePayload; defaultOpen?: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openCode, setOpenCode] = useState<Set<string>>(new Set());

  // 数据变化时重置展开态
  useEffect(() => {
    if (!defaultOpen) {
      setExpanded(new Set());
    } else {
      const init = new Set<string>();
      data.callers.forEach((n) => init.add(n.key));
      data.callees.forEach((n) => init.add(n.key));
      setExpanded(init);
    }
    setOpenCode(new Set());
  }, [data, defaultOpen]);

  const allExpandable = useMemo(
    () => collectExpandable([...data.callers, ...data.callees]),
    [data]
  );

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleCode = (key: string) =>
    setOpenCode((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const { stats, warnings } = data;

  return (
    <div className="space-y-3">
      {/* 统计栏 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600">
        <span>
          ↑ 被调用 <b className="text-gray-900">{stats.callersNodes}</b> 处
        </span>
        <span>
          ↓ 调用 <b className="text-gray-900">{stats.calleesNodes}</b> 处
        </span>
        <span className="text-gray-400">深度 {stats.maxDepth}</span>
        {stats.ambiguousNodes > 0 && <span className="text-amber-700">同名歧义 {stats.ambiguousNodes}</span>}
        {stats.unresolvedEdges > 0 && <span className="text-gray-400">未解析 {stats.unresolvedEdges}</span>}
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

      {/* 可信度说明 */}
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

      {/* 根节点 */}
      {data.root && <RootNode node={data.root} openCode={openCode} onToggleCode={toggleCode} />}

      {/* 双向分支 */}
      {data.callers.length > 0 && (
        <BranchGroup
          title="被谁调用（向上）"
          direction="up"
          nodes={data.callers}
          expanded={expanded}
          openCode={openCode}
          onToggleExpand={toggleExpand}
          onToggleCode={toggleCode}
        />
      )}
      {data.callees.length > 0 && (
        <BranchGroup
          title="调用了谁（向下）"
          direction="down"
          nodes={data.callees}
          expanded={expanded}
          openCode={openCode}
          onToggleExpand={toggleExpand}
          onToggleCode={toggleCode}
        />
      )}
      {data.callers.length === 0 && data.callees.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-6">
          该符号没有可解析的调用关系（可能确实无人调用，或调用图尚未构建）。
        </div>
      )}
    </div>
  );
}

function RootNode({
  node,
  openCode,
  onToggleCode,
}: {
  node: CallTreeNode;
  openCode: Set<string>;
  onToggleCode: (key: string) => void;
}) {
  const isCodeOpen = openCode.has(node.key);
  return (
    <div className="border border-emerald-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border-b border-emerald-100">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-600 text-white text-[10px] font-bold flex-shrink-0">
          R
        </span>
        {typeChip(node.symbolType)}
        <span className="text-sm font-semibold text-gray-900 font-mono">{node.symbol}</span>
        {node.filePath && (
          <span className="text-xs text-gray-500 font-mono truncate">
            {shortPath(node.filePath)}
            {node.lineStart != null ? `:${node.lineStart}` : ''}
          </span>
        )}
        {node.ambiguous && (
          <span className="text-[10px] px-1.5 py-[1px] rounded bg-amber-100 border border-amber-300 text-amber-800">
            同名 {node.candidateCount} 处
          </span>
        )}
        {node.codeText && (
          <button
            onClick={() => onToggleCode(node.key)}
            className="ml-auto px-2 py-0.5 text-emerald-600 border border-emerald-200 rounded hover:bg-emerald-100 transition-all text-[11px]"
          >
            {isCodeOpen ? '收起代码' : '查看代码'}
          </button>
        )}
      </div>
      {isCodeOpen && node.codeText && (
        <CodeView code={node.codeText} lineStart={node.lineStart} filePath={node.filePath} />
      )}
    </div>
  );
}

function BranchGroup({
  title,
  direction,
  nodes,
  expanded,
  openCode,
  onToggleExpand,
  onToggleCode,
}: {
  title: string;
  direction: 'up' | 'down';
  nodes: CallTreeNode[];
  expanded: Set<string>;
  openCode: Set<string>;
  onToggleExpand: (key: string) => void;
  onToggleCode: (key: string) => void;
}) {
  const dotColor = direction === 'up' ? 'bg-indigo-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-xs font-medium text-gray-700">{title}</span>
        <span className="text-xs text-gray-400">{nodes.length} 个</span>
      </div>
      <div className="border-l-2 border-gray-100 pl-3 space-y-0.5">
        {nodes.map((n) => (
          <TreeNode
            key={n.key}
            node={n}
            expanded={expanded}
            openCode={openCode}
            onToggleExpand={onToggleExpand}
            onToggleCode={onToggleCode}
          />
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  expanded,
  openCode,
  onToggleExpand,
  onToggleCode,
}: {
  node: CallTreeNode;
  expanded: Set<string>;
  openCode: Set<string>;
  onToggleExpand: (key: string) => void;
  onToggleCode: (key: string) => void;
}) {
  const isOpen = expanded.has(node.key);
  const isCodeOpen = openCode.has(node.key);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-50 transition-all">
        <button
          onClick={() => hasChildren && onToggleExpand(node.key)}
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

        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.resolved ? 'bg-emerald-500' : 'bg-gray-300'}`} />
        {typeChip(node.symbolType)}
        <span className="text-sm text-gray-800 font-mono truncate">{node.symbol}</span>

        {node.filePath && (
          <span className="text-xs text-gray-400 font-mono truncate">
            {shortPath(node.filePath)}
            {node.callLine != null ? `:${node.callLine}` : ''}
          </span>
        )}

        {node.cyclic && (
          <span className="text-[10px] px-1.5 py-[1px] rounded bg-rose-50 border border-rose-200 text-rose-700 flex-shrink-0">
            ↻ 成环
          </span>
        )}
        {node.ambiguous && (
          <span className="text-[10px] px-1.5 py-[1px] rounded bg-amber-100 border border-amber-300 text-amber-800 flex-shrink-0">
            同名 {node.candidateCount}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {hasChildren && <span className="text-[10px] text-gray-400">→ {node.children.length}</span>}
          {node.codeText && (
            <button
              onClick={() => onToggleCode(node.key)}
              className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-emerald-600 border border-emerald-200 rounded hover:bg-emerald-50 transition-all text-[10px]"
            >
              {isCodeOpen ? '收起' : '代码'}
            </button>
          )}
        </div>
      </div>

      {isCodeOpen && node.codeText && (
        <div className="ml-6 my-1">
          <CodeView code={node.codeText} lineStart={node.lineStart} filePath={node.filePath} />
        </div>
      )}

      {isOpen && hasChildren && (
        <div className="ml-[11px] border-l border-gray-200 pl-3">
          {node.children.map((c) => (
            <TreeNode
              key={c.key}
              node={c}
              expanded={expanded}
              openCode={openCode}
              onToggleExpand={onToggleExpand}
              onToggleCode={onToggleCode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 轻量代码展示（带行号）。刻意不用 Monaco：调用树里会同时展开多处代码，重型编辑器扛不住。 */
export function CodeView({
  code,
  lineStart,
  filePath,
}: {
  code: string;
  lineStart: number | null;
  filePath: string | null;
}) {
  const lines = code.split('\n');
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
      <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-200 flex items-center justify-between">
        <span className="text-[11px] text-gray-500 font-mono truncate">{filePath ?? ''}</span>
        {lineStart != null && (
          <span className="text-[11px] text-gray-400">
            L{lineStart}-{lineStart + lines.length - 1}
          </span>
        )}
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed text-gray-800">
        {lines.map((ln, i) => (
          <div key={i} className="flex">
            <span className="w-8 flex-shrink-0 text-right pr-3 text-gray-400 select-none">
              {lineStart != null ? lineStart + i : i + 1}
            </span>
            <span className="whitespace-pre">{ln || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
