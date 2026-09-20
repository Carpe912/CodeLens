/**
 * 增量更新面板
 *
 * ============================================================
 * 它要回答的两个问题（必须**分开**答，混在一起就成了一锅粥）
 * ============================================================
 * 1. **上游将要发生什么** —— 与默认分支对比，落后几个提交、动到哪些文件。
 *    这是「输入」。用户点「应用更新」之前应该先看到它，否则按钮就是个盲盒。
 * 2. **上次索引实际变了什么** —— 新增/删除/位移了哪些函数、类、常量、接口。
 *    这是「输出」，也是「最好是可以告诉我都新增了那些东西」的正面回答。
 *
 * 只做第 1 层的问题是：看到「上游改了 3 个文件」仍然不知道这对检索意味着什么
 * （新增了一个接口就能被搜到；只调整了缩进则什么都没变）。
 * 只做第 2 层的问题是：看不出「为什么会有这些变化」。
 *
 * ============================================================
 * 为什么 ZIP 源要显式降级而不是隐藏按钮
 * ============================================================
 * ZIP 解压出来的目录没有 `.git`，**物理上**无法做 diff。后端会返回
 * `supported:false` 并给出指引。界面上必须把这句话显示出来 ——
 * 如果只是把按钮藏掉，用户会以为「这个功能还没做」，而不是
 * 「这个来源类型做不了，要走全量」。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { API_BASE } from '../../utils/constants';
import { Card, CardHeader } from './Card';
import type {
  EntityItem,
  GitFileChange,
  IncrementalReport,
  RepoDetail,
  UpstreamCheckResponse,
} from '../../types';

// ---------------------------------------------------------------- 小工具

/** 提交时间 → 「09-19 21:03」。只用于列表，带上年份反而难扫 */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 耗时 → 「1.2s」/「3 分 05 秒」 */
function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(Math.round(s - m * 60)).padStart(2, '0')} 秒`;
}

/** 相对时间，只用于「上次运行于」这类文案 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

const STATUS_META: Record<GitFileChange['status'], { label: string; cls: string; sign: string }> = {
  added: { label: '新增', cls: 'bg-emerald-50 border-emerald-200 text-emerald-700', sign: '+' },
  modified: { label: '修改', cls: 'bg-amber-50 border-amber-200 text-amber-700', sign: '~' },
  deleted: { label: '删除', cls: 'bg-rose-50 border-rose-200 text-rose-700', sign: '-' },
  renamed: { label: '重命名', cls: 'bg-violet-50 border-violet-200 text-violet-700', sign: '→' },
};

const KIND_LABEL: Record<EntityItem['kind'], string> = {
  function: '函数',
  class: '类',
  constant: '常量',
  urlPattern: '接口',
};

/** 计数小胶囊 */
function CountChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>
      <span>{label}</span>
      <span className="font-mono font-semibold">{value}</span>
    </span>
  );
}

/** 一条实体（函数/类/常量/接口） */
function EntityRow({ item }: { item: EntityItem }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs min-w-0">
      <span className="flex-shrink-0 px-1.5 rounded bg-slate-100 border border-slate-200 text-[10px] text-slate-600">
        {KIND_LABEL[item.kind]}
      </span>
      <span className="font-mono text-slate-800 truncate" title={item.symbol}>
        {item.symbol}
      </span>
      <span className="font-mono text-slate-400 truncate ml-auto text-[11px]" title={item.path}>
        {item.path}:{item.line}
      </span>
    </div>
  );
}

/** 可折叠的清单：超过 `initial` 条时收起，避免面板把页面撑太长 */
function CollapsibleList<T>({
  items,
  initial = 6,
  render,
  emptyText,
}: {
  items: T[];
  initial?: number;
  render: (item: T) => ReactNode;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return <p className="text-xs text-slate-400 py-1">{emptyText}</p>;
  const shown = open ? items : items.slice(0, initial);
  return (
    <>
      <div className="divide-y divide-slate-50">{shown.map(render)}</div>
      {items.length > initial && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[11px] text-cyan-700 hover:text-cyan-800 transition-colors"
        >
          {open ? '收起' : `展开其余 ${items.length - initial} 条`}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 主组件

export function IncrementalPanel({
  repoId,
  repoDetail,
  onReload,
}: {
  /** 路由参数里的仓库 ID（字符串形式，直接用于拼 URL，与页面其余请求保持一致） */
  repoId: string;
  repoDetail: RepoDetail | null;
  /** 刷新完成后调用，让父页面重新拉取仓库详情（含新的 last_incremental） */
  onReload: () => void | Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<UpstreamCheckResponse | null>(null);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);

  /** 组件卸载后停止轮询，避免对已卸载组件 setState */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const isZip = repoDetail?.source === 'zip';

  // ---- 检查上游 ----
  const runCheck = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/repos/${repoId}/upstream-check`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // 502 时后端会给 { supported:false, error }，把 git 的原话显示出来
        const msg = body?.error || `检查失败（HTTP ${res.status}）`;
        setCheck(null);
        setError(msg);
        return;
      }
      setCheck(body as UpstreamCheckResponse);
    } catch (err) {
      setCheck(null);
      setError(`无法连接服务：${(err as Error).message}`);
    } finally {
      if (aliveRef.current) setChecking(false);
    }
  }, [repoId]);

  // ---- 应用更新：入队 → 轮询直到不再是 indexing ----
  const applyUpdate = useCallback(async () => {
    setApplying(true);
    setError('');
    setElapsed(0);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${API_BASE}/repos/${repoId}/refresh`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      // 轮询仓库状态。增量通常几十秒，但被牵连重建的文件多时会明显更久，
      // 所以给 10 分钟上限（全量则根本走不到这里，那条路是 job 内部自己处理的）。
      const MAX_WAIT_MS = 10 * 60 * 1000;
      for (;;) {
        if (!aliveRef.current) return;
        await new Promise((r) => setTimeout(r, 3000));
        if (!aliveRef.current) return;
        setElapsed(Date.now() - startedAt);

        const s = await fetch(`${API_BASE}/repos/${repoId}`).then((r) => (r.ok ? r.json() : null));
        if (s && s.status !== 'indexing') break;
        if (Date.now() - startedAt > MAX_WAIT_MS) {
          // 超时**不是**失败：任务可能还在跑。如实说明并让用户自己刷新看结果。
          throw new Error('等待超过 10 分钟仍未结束，任务可能仍在后台运行，可稍后刷新页面查看结果');
        }
      }

      await onReload();
      // 重新检查一次：刚才应用完，应当显示「已是最新」，这是最直观的成功信号
      await runCheck();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }, [repoId, onReload, runCheck]);

  // ---- 上次的实际结果：优先用刚检查回来的那份，否则用页面详情里的 ----
  const last: IncrementalReport | null =
    (check?.supported ? check.lastIncremental : null) ?? repoDetail?.last_incremental ?? null;

  const upstream = check?.supported ? check : null;

  return (
    <Card>
      <CardHeader
        title="增量更新"
        subtitle={
          isZip
            ? 'ZIP 源不支持与上游对比'
            : '与默认分支对比，只重建变更的部分；重建后会列出新增/删除的实体'
        }
        iconClass="bg-cyan-50 text-cyan-600"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        }
        right={
          !isZip && (
            <div className="flex items-center gap-2">
              <button
                onClick={runCheck}
                disabled={checking || applying || repoDetail?.status === 'indexing'}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {checking ? '检查中…' : '检查上游更新'}
              </button>
              <button
                onClick={applyUpdate}
                disabled={applying || checking || !upstream || upstream.behind === 0}
                title={
                  !upstream
                    ? '请先检查上游更新'
                    : upstream.behind === 0
                      ? '上游没有新提交'
                      : `将拉取 ${upstream.behind} 个提交并增量重建索引`
                }
                className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-xs font-medium hover:from-cyan-600 hover:to-blue-700 disabled:from-slate-300 disabled:to-slate-300 disabled:cursor-not-allowed transition-colors"
              >
                {applying ? `应用中… ${Math.round(elapsed / 1000)}s` : '应用更新并重建索引'}
              </button>
            </div>
          )
        }
      />

      <div className="px-5 py-4 space-y-4">
        {/* ---------- ZIP 源的降级说明 ---------- */}
        {isZip && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600 leading-relaxed">
            <span className="font-medium text-slate-700">ZIP 源只能全量重建。</span>{' '}
            解压出来的目录没有 <span className="font-mono">.git</span>，没有上游可比对。
            要更新请重新上传压缩包（走全量索引），或改用 GitLab 源接入。
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700 leading-relaxed">
            {error}
          </div>
        )}

        {/* ---------- 第 1 层：上游将要发生什么 ---------- */}
        {upstream && (
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-mono text-xs text-slate-700">{upstream.branch}</span>
              {upstream.behind === 0 ? (
                <span className="text-xs text-emerald-700 font-medium">已是最新，上游没有新提交</span>
              ) : (
                <span className="text-xs text-cyan-700 font-medium">
                  上游领先 {upstream.behind} 个提交
                </span>
              )}
              {/* 本地领先上游说明镜像目录被改脏了 —— 值得显式提示 */}
              {upstream.ahead > 0 && (
                <span className="text-xs text-amber-700 font-medium" title="本地副本有上游没有的提交，快进可能失败">
                  本地领先 {upstream.ahead} 个提交
                </span>
              )}
              <span className="ml-auto font-mono text-[11px] text-slate-400">
                {upstream.localSha.slice(0, 8)} → {upstream.upstreamSha.slice(0, 8)}
              </span>
            </div>

            {upstream.files.length > 0 && (
              <>
                <div className="px-3 py-2 border-b border-slate-100 flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ['added', upstream.summary.added],
                      ['modified', upstream.summary.modified],
                      ['deleted', upstream.summary.deleted],
                      ['renamed', upstream.summary.renamed],
                    ] as const
                  ).map(([k, v]) =>
                    v > 0 ? (
                      <CountChip key={k} label={STATUS_META[k].label} value={v} cls={STATUS_META[k].cls} />
                    ) : null
                  )}
                  <span className="text-[11px] text-slate-500 ml-1">
                    共 {upstream.summary.total} 个文件，其中{' '}
                    <span className="font-medium text-slate-700">{upstream.summary.indexable}</span> 个会进索引
                    {/* 差额不为 0 时必须解释，否则用户会以为漏了 */}
                    {upstream.summary.indexable < upstream.summary.total && (
                      <span className="text-slate-400">
                        （索引器只支持 TS/JS/TSX/JSX 与 .vue）
                      </span>
                    )}
                  </span>
                </div>

                <div className="px-3 py-2 max-h-64 overflow-y-auto divide-y divide-slate-50">
                  {upstream.files.slice(0, expanded ? undefined : 8).map((f) => {
                    const meta = STATUS_META[f.status];
                    return (
                      <div key={`${f.status}:${f.path}`} className="flex items-baseline gap-2 py-1 text-xs min-w-0">
                        <span className={`flex-shrink-0 w-12 text-center px-1 rounded border text-[10px] ${meta.cls}`}>
                          {meta.label}
                        </span>
                        <span className="font-mono text-slate-700 truncate" title={f.path}>
                          {f.status === 'renamed' && f.fromPath ? (
                            <>
                              <span className="text-slate-400">{f.fromPath}</span>
                              <span className="text-slate-400"> → </span>
                              {f.path}
                            </>
                          ) : (
                            f.path
                          )}
                        </span>
                        {!f.indexable && (
                          <span className="flex-shrink-0 text-[10px] text-slate-400 border border-slate-200 rounded px-1">
                            不进索引
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {upstream.files.length > 8 && (
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-1 text-[11px] text-cyan-700 hover:text-cyan-800"
                    >
                      {expanded ? '收起' : `展开其余 ${upstream.files.length - 8} 个文件`}
                    </button>
                  )}
                </div>
              </>
            )}

            {upstream.commits.length > 0 && (
              <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/50 max-h-40 overflow-y-auto">
                <div className="text-[11px] text-slate-500 mb-1">将拉取的提交</div>
                {upstream.commits.map((c) => (
                  <div key={c.sha} className="flex items-baseline gap-2 py-0.5 text-xs min-w-0">
                    <span className="font-mono text-[11px] text-cyan-700 flex-shrink-0">{c.shortSha}</span>
                    <span className="text-slate-700 truncate" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[10px] text-slate-400">
                      {c.author} · {shortTime(c.date)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---------- 第 2 层：上次索引实际变了什么 ---------- */}
        {last && (
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-medium text-slate-700">上次增量结果</span>
              <span
                className={`px-1.5 rounded border text-[10px] font-medium ${
                  last.mode === 'full'
                    ? 'bg-slate-100 border-slate-300 text-slate-600'
                    : 'bg-cyan-50 border-cyan-200 text-cyan-700'
                }`}
              >
                {last.mode === 'full' ? '全量' : '增量'}
              </span>
              <span className="text-[11px] text-slate-400">
                {shortTime(last.at)}（{relativeTime(last.at)}）
              </span>
              {last.branch && <span className="font-mono text-[11px] text-slate-500">{last.branch}</span>}
              {last.fromSha && last.toSha && last.fromSha !== last.toSha && (
                <span className="font-mono text-[11px] text-slate-400">
                  {last.fromSha.slice(0, 8)} → {last.toSha.slice(0, 8)}
                </span>
              )}
            </div>

            <div className="px-3 py-3 space-y-3">
              {/* note 承载两类信息：正常情况的说明（无变更/无可索引文件）与失败原因 */}
              {last.note && (
                <p className="text-xs text-slate-500 leading-relaxed m-0">{last.note}</p>
              )}

              {/* 上游侧汇总 */}
              {last.gitSummary && last.gitSummary.total > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">上游文件</span>
                  {(
                    [
                      ['added', last.gitSummary.added],
                      ['modified', last.gitSummary.modified],
                      ['deleted', last.gitSummary.deleted],
                      ['renamed', last.gitSummary.renamed],
                    ] as const
                  ).map(([k, v]) =>
                    v > 0 ? (
                      <CountChip key={k} label={STATUS_META[k].label} value={v} cls={STATUS_META[k].cls} />
                    ) : null
                  )}
                </div>
              )}

              {/* 索引侧结果 —— 「告诉我都新增了那些东西」的正面回答 */}
              {last.outcome ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-500">索引实体</span>
                    <CountChip
                      label="新增"
                      value={last.outcome.entities.counts.added}
                      cls="bg-emerald-50 border-emerald-200 text-emerald-700"
                    />
                    <CountChip
                      label="删除"
                      value={last.outcome.entities.counts.removed}
                      cls="bg-rose-50 border-rose-200 text-rose-700"
                    />
                    <CountChip
                      label="仅位移"
                      value={last.outcome.entities.counts.moved}
                      cls="bg-slate-50 border-slate-200 text-slate-600"
                    />
                    <span className="text-[11px] text-slate-400 ml-1">
                      重建 {last.outcome.rebuiltFiles} 个文件 · 耗时{' '}
                      {humanDuration(last.outcome.durationMs)}
                    </span>
                  </div>

                  {/* 位移单独说明：插一行注释会让整文件行号平移，
                      那不是「新增/删除」，不解释的话数字会显得很怪 */}
                  {last.outcome.entities.counts.moved > 0 && (
                    <p className="text-[11px] text-slate-400 m-0 leading-relaxed">
                      「仅位移」表示符号本身还在、只是起始行号变了（例如文件开头插入了若干行），
                      不计入新增或删除。
                    </p>
                  )}

                  {last.outcome.propagated.length > 0 && (
                    <p className="text-[11px] text-slate-500 m-0 leading-relaxed">
                      另有 <span className="font-medium text-slate-700">{last.outcome.propagated.length}</span>{' '}
                      个文件自身没改，但因为引用了改动过的文件而被牵连重建（
                      <span className="font-mono text-slate-500">
                        {last.outcome.propagated.slice(0, 3).join('、')}
                        {last.outcome.propagated.length > 3 ? ' 等' : ''}
                      </span>
                      ）。
                    </p>
                  )}

                  {last.outcome.entities.added.length > 0 && (
                    <div>
                      <div className="text-[11px] font-medium text-emerald-700 mb-1">新增的实体</div>
                      <CollapsibleList
                        items={last.outcome.entities.added}
                        render={(it: EntityItem) => <EntityRow key={`${it.kind}:${it.path}:${it.symbol}`} item={it} />}
                        emptyText="无"
                      />
                    </div>
                  )}

                  {last.outcome.entities.removed.length > 0 && (
                    <div>
                      <div className="text-[11px] font-medium text-rose-700 mb-1">删除的实体</div>
                      <CollapsibleList
                        items={last.outcome.entities.removed}
                        render={(it: EntityItem) => <EntityRow key={`${it.kind}:${it.path}:${it.symbol}`} item={it} />}
                        emptyText="无"
                      />
                    </div>
                  )}

                  {last.outcome.entities.truncated && (
                    <p className="text-[11px] text-amber-700 m-0">
                      明细条数过多已截断，上面的计数是真实总数。
                    </p>
                  )}

                  {last.outcome.entities.counts.added === 0 &&
                    last.outcome.entities.counts.removed === 0 &&
                    last.outcome.entities.counts.moved === 0 && (
                      <p className="text-xs text-slate-400 m-0">
                        本次没有实体级变化（可能只改了注释/格式，或改动都在符号内部）。
                      </p>
                    )}
                </div>
              ) : (
                // 没有 outcome：无变更、只落了全量、或刷新失败
                !last.note && last.mode === 'full' && (
                  <p className="text-xs text-slate-400 m-0">
                    本次走的是全量重建，没有增量明细。全量重建不会做实体差集对比。
                  </p>
                )
              )}
            </div>
          </div>
        )}

        {!isZip && !upstream && !last && !error && !checking && (
          <p className="text-xs text-slate-400 m-0">
            还没有增量记录。点「检查上游更新」先看上游有什么变化。
          </p>
        )}
      </div>
    </Card>
  );
}
