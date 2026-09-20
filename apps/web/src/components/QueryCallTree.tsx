/**
 * 问答结果里的「调用关系」面板
 *
 * ============================================
 * 它替代了什么
 * ============================================
 * 以前问答结果下面是「代码证据」——一个按相关度平铺的列表，看不出调用关系。
 * 现在改成：从**用户的原始提问**里解析出根符号与调用方向，直接渲染调用树。
 *
 * 例：
 *  -「https://host/rest/account/getUserAuthority 这个接口在哪里被调用了」
 *      → 根 = getUserAuthority，方向 = 调用方（向上）
 *  -「batchProcessOrders 调用了哪些方法」
 *      → 根 = batchProcessOrders，方向 = 被调用方（向下）
 *  -「登录功能怎么实现的」（语义模糊）
 *      → 无明确方向，退到「检索命中的第一个符号」做双向展开
 *
 * ============================================
 * 解析不出来时怎么办（重要）
 * ============================================
 * 提问里的名字在本仓库没有定义时，后端返回 `intent.level='file'` 且 `root=null`。
 * 这时**不画一棵假的树**，而是把 `fallback`（调用方传入的证据列表）如实展示出来，
 * 并说明「为什么没能构建调用关系」。宁可不显示，也不要显示误导性的图。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../utils/constants';
import type { QueryCallTreeResponse, CallDirection } from '../types/callTree';
import { SymbolTreeView, shortPath } from './SymbolCallTree';

type QueryCallTreeProps = {
  repoId: string;
  /** 用户的原始提问 */
  query: string;
  /** 检索命中的证据符号，用于提问里没有明确符号时定根 */
  candidates: Array<{ symbol: string; filePath: string }>;
  /**
   * 无法构建调用关系时展示的内容（由调用方传入证据列表）。
   * 不传则只在组件内部显示降级提示。
   */
  fallback?: React.ReactNode;
  /**
   * 是否成功构建出调用关系。父组件据此决定要不要继续展示原始证据列表。
   * 传函数引用无需 memo —— 内部用 ref 持有，不会触发重复请求。
   */
  onResolvedChange?: (resolved: boolean) => void;
};

const DIRECTION_LABEL: Record<CallDirection, string> = {
  callers: '谁调用了它',
  callees: '它调用了谁',
  both: '双向',
};

const MATCHED_BY_LABEL: Record<string, string> = {
  'url-segment': '从接口路径末段识别',
  'query-token': '从提问中的符号名识别',
  'evidence-top': '提问无符号名，暂用首个命中符号',
  none: '未识别到符号',
};

export function QueryCallTree({ repoId, query, candidates, fallback, onResolvedChange }: QueryCallTreeProps) {
  const [data, setData] = useState<QueryCallTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户手动切换的方向；undefined = 跟随语义判断 */
  const [directionOverride, setDirectionOverride] = useState<CallDirection | undefined>(undefined);

  // 用 ref 持有回调，避免父组件传内联箭头函数导致 effect 反复重跑
  const resolvedRef = useRef(onResolvedChange);
  resolvedRef.current = onResolvedChange;
  const notify = (resolved: boolean) => resolvedRef.current?.(resolved);

  // 只在提问/证据集变化时重取，避免每次渲染都打接口
  const signature = useMemo(
    () => `${query}||${candidates.map((c) => c.symbol).join(',')}`,
    [query, candidates]
  );

  useEffect(() => {
    setDirectionOverride(undefined);
  }, [signature]);

  useEffect(() => {
    if (!repoId || !query.trim()) {
      setData(null);
      notify(false);
      return;
    }
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const body: Record<string, unknown> = {
          repoId: Number(repoId),
          query,
          candidates: candidates.map((c) => ({ symbol: c.symbol, filePath: c.filePath })),
          maxDepth: 2,
        };
        if (directionOverride) body.direction = directionOverride;

        const res = await fetch(`${API_BASE}/query-call-tree`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`调用关系接口返回 ${res.status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
        }
        const json: QueryCallTreeResponse = await res.json();
        setData(json);
        // 只有真正解析到根符号 + 树，才算「构建成功」
        notify(Boolean(json.root && json.tree));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
          notify(false);
        }
      } finally {
        setLoading(false);
      }
    }

    load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, signature, directionOverride]);

  // —— 加载中 ——
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-3 text-gray-500 text-sm">
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          正在按提问语义解析调用关系...
        </div>
      </div>
    );
  }

  // —— 出错：降级到证据列表，但把原因说清楚 ——
  if (error) {
    return (
      <div className="space-y-3">
        <div className="py-3 px-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-800">
          调用关系构建失败：{error}
          <div className="mt-1 text-xs text-amber-700">已回落到代码证据列表 —— 调用关系是叠加视图，不影响检索结果本身。</div>
        </div>
        {fallback}
      </div>
    );
  }

  const intent = data?.intent;
  const resolved = data?.root && data?.tree;

  // —— 未能解析到符号：不画假树，如实降级 ——
  if (data && !resolved) {
    return (
      <div className="space-y-3">
        <div className="py-3 px-4 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-600">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <div className="font-medium text-gray-700">未能从提问定位到符号，无法构建调用关系</div>
              <div className="mt-1 text-xs text-gray-500">
                已识别方向：{intent ? DIRECTION_LABEL[intent.direction] : '—'}
                {' · '}
                来源：{MATCHED_BY_LABEL[intent?.matchedBy ?? 'none']}
                {intent && intent.tokens.length > 0 && (
                  <>
                    {' · '}
                    候选名：<span className="font-mono">{intent.tokens.slice(0, 4).join(', ')}</span>
                  </>
                )}
              </div>
              {data.warnings.map((w) => (
                <div key={w.code} className="mt-1 text-xs text-amber-700">
                  {w.message}
                </div>
              ))}
            </div>
          </div>
        </div>
        {fallback}
      </div>
    );
  }

  if (!data || !resolved || !intent) {
    return <>{fallback}</>;
  }

  return (
    <div className="space-y-3">
      {/* 语义识别结果 + 方向切换 */}
      <div className="px-3 py-2.5 bg-emerald-50/60 border border-emerald-200 rounded-lg">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="flex items-center gap-1.5 text-emerald-800 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {MATCHED_BY_LABEL[intent.matchedBy]}
          </span>
          <span className="text-gray-600">{intent.reason}</span>
          <span className="font-mono text-gray-800">{data.root?.symbol}</span>
          {data.root?.filePath && (
            <span className="text-gray-400 font-mono">
              {shortPath(data.root.filePath)}:{data.root.lineStart}
            </span>
          )}

          {/* 方向切换 */}
          <div className="ml-auto flex items-center rounded-md border border-emerald-300 overflow-hidden">
            {(['callers', 'both', 'callees'] as CallDirection[]).map((d) => {
              const active = (directionOverride ?? intent.direction) === d;
              return (
                <button
                  key={d}
                  onClick={() => setDirectionOverride(d)}
                  className={`px-2.5 py-1 text-[11px] transition-colors ${
                    active ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-700 hover:bg-emerald-50'
                  }`}
                >
                  {DIRECTION_LABEL[d]}
                </button>
              );
            })}
          </div>
        </div>

        {/* 其它候选根（提问里同时出现了多个可定位的符号） */}
        {data.alternatives.length > 0 && (
          <div className="mt-1.5 text-[11px] text-gray-500">
            提问里还提到了：
            {data.alternatives.map((a) => (
              <span key={a.chunkId} className="ml-1.5 font-mono text-gray-700">
                {a.symbol}
              </span>
            ))}
          </div>
        )}
      </div>

      <SymbolTreeView data={data.tree!} />
    </div>
  );
}
