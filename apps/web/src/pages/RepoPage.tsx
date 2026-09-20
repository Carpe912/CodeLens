import { useState, useEffect, ChangeEvent, KeyboardEvent, useRef, lazy, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  QAResponse,
  SearchHit,
  SearchHistoryItem,
  RepoDetail,
  RepoStats,
} from '../types';
import { API_BASE } from '../utils/constants';
import { getSearchHistory, addToSearchHistory, clearSearchHistory, getSearchResult } from '../utils/searchHistory';
import { highlightText } from '../utils/textUtils';
import { CodeBlock } from '../components/common/CodeBlock';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { EvidenceCallTree } from '../components/EvidenceCallTree';
import { QueryCallTree } from '../components/QueryCallTree';
import { ImpactPanel, type ImpactKind } from '../components/ImpactPanel';
import { Card, CardHeader } from '../components/repo/Card';
import { MarkdownBody } from '../components/repo/MarkdownBody';
import { AnswerCard } from '../components/repo/AnswerCard';
import { IncrementalPanel } from '../components/repo/IncrementalPanel';
import { MODES, EXAMPLE_QUESTIONS, MODE_BADGE, type Mode } from '../components/repo/modes';

/**
 * 调用图弹窗内的 reactflow 走懒加载。
 *
 * `CallGraph` 依赖 reactflow（本项目最大的单个依赖），而它**只在弹窗打开时**才需要 ——
 * 静态 import 会让每次打开仓库页都白下载这个图引擎。这里改成 lazy：
 * 只有用户真的点开调用图，才会去取那块 chunk。
 */
const LazyCallGraph = lazy(() =>
  import('../components/CallGraph').then((m) => ({ default: m.CallGraph }))
);

/**
 * 接口清单一整屏（几百行的表）也只有点开才需要，同样懒加载。
 */
const LazyInterfaceInventory = lazy(() =>
  import('../components/repo/InterfaceInventoryPanel').then((m) => ({
    default: m.InterfaceInventoryPanel,
  }))
);

/**
 * 仓库页（/repo/:id）
 *
 * ============================================================
 * 这次重新设计要解决的两个问题
 * ============================================================
 * 1. **功能没被露出来**。原来「搜索 / 问答 / 根因分析」三档模式的选择器写的是
 *    `className="hidden"` —— 也就是说，根因分析这条链路在界面上**根本点不到**，
 *    搜索模式也只能靠默认值碰运气。功能做完了却没人能用，是纯粹的界面问题。
 * 2. **视觉与产品脱节**。首页是深色渐变（slate/purple + cyan 强调色）的品牌页，
 *    点进仓库却变成一张浅灰的后台表格，像两个产品。
 *
 * ============================================================
 * 设计取向：深色命令栏 + 浅色工作区
 * ============================================================
 * 顶部命令栏（仓库身份 + 索引规模 + 模式 + 提问框）用深色，与首页同一套品牌语言；
 * 下方内容区保持浅色纸面 —— 因为代码、答案、调用树这些**内容组件本来就是浅色**，
 * 强行全深色等于把它们的可读性赌在一次没有肉眼验收机会的改版上。
 * 这不是妥协，是刻意的分区：深色是「操作」，浅色是「阅读」。
 *
 * ============================================================
 * 关于「关联层」标签（别删）
 * ============================================================
 * 关联结果与查询路径**没有字面交集**，必须与「直接命中」区分，否则使用者会以为搜索在乱给结果。
 */

const Filter = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
  </svg>
);

/** 关联层结果的标签 */
const RELATED_LABELS: Record<string, string> = {
  indirect_call: '关联 · 间接调用',
  template_helper: '关联 · 模板句柄',
  version_family: '关联 · 版本家族',
};

/** 关联结果「为什么会出现」的解释，展开后展示 */
const RELATED_EXPLAIN: Record<string, string> = {
  indirect_call: '本行通过封装的 API 方法间接请求了该接口，因此把它归到这里。',
  template_helper: '这是路径模板处理器：字面模板由调用方传入，本行是它的定义处。',
  version_family: '该版本路由由循环生成（与查询同位置是 ${version} 占位段），不是手写的字面路由。',
};

/**
 * URL 结果的语义标签（URL 检索没有 code_chunks 的 symbol_type，改用它）。
 *
 * ⚠️ 必须覆盖 usage_context 的**全部**取值：漏掉的会被兜底原样显示英文枚举（数据库字段泄漏）。
 * 枚举来源：apps/api/src/retrieval/url-search.ts 的 usageContext 注释。
 */
const USAGE_CONTEXT_LABELS: Record<string, string> = {
  api_call: '调用点',
  route_definition: '路由定义',
  router: '路由注册',
  unknown: '未归类',
  // 下面三条虽然与 RELATED_LABELS 同源，但**这里的语义不同**：
  // 它们是「直接命中」的（与查询路径有字面交集），只是这行的性质本身是间接的。
  indirect_call: '调用点 · 间接',
  template_helper: '定义处 · 模板',
  version_family: '路由 · 版本家族',
};




export function RepoPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const repoId = id || '';
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('ask'); // 默认问答模式
  const [result, setResult] = useState<QAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>(getSearchHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [repoDetail, setRepoDetail] = useState<RepoDetail | null>(null);
  const [repoStats, setRepoStats] = useState<RepoStats | null>(null);
  /**
   * 仓库详情的重取令牌。
   * 增量面板跑完一次「应用更新」后需要重新拉详情（新的 `last_incremental`、
   * 新的 status）。用自增令牌触发上面的 effect，而不是把 load 抽成 useCallback ——
   * 详情与统计是**一起**取的，拆开容易出现「详情更新了、统计还是旧的」这种不一致。
   */
  const [repoReloadToken, setRepoReloadToken] = useState(0);
  const [searchStatus, setSearchStatus] = useState<string>('');

  // ---------- 影响面模式的状态 ----------
  // 影响面**不走** result/evidence 那套渲染（它的返回形状完全不同），
  // 而是把「目标 + 一个自增令牌」交给 ImpactPanel，由它自己取数。
  // 令牌的存在是为了让「同一个目标再点一次提交」也能真正重跑。
  //
  // impactKind 用 null 表示「不指定，让面板按输入推断」（输入里带 / 或扩展名
  // 就是文件路径）。只有从证据行的「影响面」按钮进来时才确定是 'symbol' ——
  // 如果这里无条件传一个默认值，就会把面板的自动判断整个架空，
  // 用户输入文件路径也会被当成符号去查（实测踩过）。
  const [impactTarget, setImpactTarget] = useState<string | null>(null);
  const [impactToken, setImpactToken] = useState(0);
  const [impactKind, setImpactKind] = useState<ImpactKind | null>(null);

  // Feedback states
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [answerCopied, setAnswerCopied] = useState(false);

  // Filter states
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [symbolTypeFilter, setSymbolTypeFilter] = useState<string>('all');

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);

  // Collapse states for code evidence
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  // 证据列表的展示方式：list = 平铺列表，tree = 按 call_graph 聚合的调用树
  const [evidenceView, setEvidenceView] = useState<'list' | 'tree'>('list');

  // 主视图「调用关系」是否成功构建。true = 已画出调用树；false = 无法定根（或接口失败），
  // 此时证据区自动展开，避免用户看到空白。
  const [callTreeResolved, setCallTreeResolved] = useState(false);

  // 证据区是否展开。默认：调用关系没建起来、或本来就是搜索模式 → 展开；
  // 调用关系已画出时收起（避免和调用树重复占屏），但用户随时可以点开。
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceSigRef = useRef('');

  // Conversation context for follow-up questions
  const [conversationHistory, setConversationHistory] = useState<Array<{ query: string; answer: string }>>([]);
  const [showFollowUpInput, setShowFollowUpInput] = useState(false);
  const [followUpQuery, setFollowUpQuery] = useState('');
  const [followUpSubmitted, setFollowUpSubmitted] = useState(false);

  // Call graph modal state
  const [showCallGraphModal, setShowCallGraphModal] = useState(false);
  const [callGraphSymbol, setCallGraphSymbol] = useState<string>('');

  // 接口清单弹层：顶栏「接口 N」那个数字点开就是它。
  // 数字本身说明不了任何事（既看不出有哪些接口，也看不出 N 是不是真有那么多），
  // 所以它不是终点而是一个入口。
  const [showInventory, setShowInventory] = useState(false);

  // Refs for debounce and abort controller
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  // Store search result to preserve when navigating to call graph
  const resultRef = useRef<QAResponse | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // 仓库身份 + 索引规模
  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/repos/${repoId}`);
        if (res.ok && !cancelled) {
          setRepoDetail(await res.json());
        }
      } catch (err) {
        console.error('Failed to fetch repo detail:', err);
      }

      try {
        // 统计接口是后加的；老服务上会 404，此时静默跳过，不影响页面其余部分
        const res = await fetch(`${API_BASE}/repos/${repoId}/stats`);
        if (res.ok && !cancelled) {
          setRepoStats(await res.json());
        }
      } catch (err) {
        console.error('Failed to fetch repo stats:', err);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [repoId, repoReloadToken]);

  /** 把目标交给影响面面板（由面板自己发请求）。kind=null 表示交给面板自动推断 */
  const submitImpact = (t: string, kind: ImpactKind | null = null) => {
    setImpactKind(kind);
    setImpactTarget(t);
    setImpactToken((v) => v + 1);
    setError(null);
    setResult(null);
    resultRef.current = null;
  };

  const handleSubmit = async (isFollowUp = false) => {
    const searchQuery = isFollowUp ? followUpQuery : query;
    if (!searchQuery) return;

    // 影响面模式：返回形状与前三种模式完全不同，不走 result 那套流程，
    // 而是把目标交给 ImpactPanel 由它自己取数。
    if (mode === 'impact') {
      submitImpact(searchQuery);
      return;
    }

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    setShowHistory(false);
    setSearchStatus('');
    setResult(null); // 清空之前的结果
    resultRef.current = null;
    setCallTreeResolved(false);
    setCurrentPage(1);
    setExpandedItems(new Set());

    try {
      if (mode === 'search') {
        setSearchStatus('正在检索代码库...');
        const res = await fetch(`${API_BASE}/search?repoId=${repoId}&q=${encodeURIComponent(searchQuery)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        const newResult: QAResponse = { query: searchQuery, answer: '', evidence: data.hits, kind: 'search' };
        setResult(newResult);
        resultRef.current = newResult;

        addToSearchHistory(searchQuery, mode, repoId, newResult);
        setSearchHistory(getSearchHistory());
      } else if (mode === 'ask') {
        setSearchStatus('正在检索证据并生成回答...');
        const res = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query: searchQuery }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('问答失败');
        const data = await res.json();
        const newResult: QAResponse = { ...data, kind: 'ask' };
        setResult(newResult);
        resultRef.current = newResult;

        // Add to conversation history
        if (data.answer) {
          setConversationHistory(prev => [...prev, { query: searchQuery, answer: data.answer }]);
        }

        addToSearchHistory(searchQuery, mode, repoId, newResult);
        setSearchHistory(getSearchHistory());
      } else if (mode === 'root-cause') {
        setSearchStatus('正在进行根因分析...');
        const res = await fetch(`${API_BASE}/root-cause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query: searchQuery }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('根因分析失败');
        const data = await res.json();
        const newResult: QAResponse = {
          query: searchQuery,
          answer: data.rootCause,
          evidence: data.evidence,
          kind: 'root-cause',
        };
        setResult(newResult);
        resultRef.current = newResult;

        addToSearchHistory(searchQuery, mode, repoId, newResult);
        setSearchHistory(getSearchHistory());
      }

      if (isFollowUp) {
        setFollowUpQuery('');
        setShowFollowUpInput(false);
        setFollowUpSubmitted(false);
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setSearchStatus('');
      abortControllerRef.current = null;
    }
  };

  /** 切换模式：清掉上一模式的结果，避免「搜索」模式下展示着问答的答案 */
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    setMode(next);
    setResult(null);
    resultRef.current = null;
    setError(null);
    setSearchStatus('');
    setLoading(false);
    setCallTreeResolved(false);
    setShowHistory(false);
    setExpandedItems(new Set());
    setCurrentPage(1);
  };

  /**
   * 真正的提交实现：**模式和 query 都显式传入**，不读 state。
   *
   * 为什么必须显式传：点示例问题时，代码会在同一帧里先 `switchMode(新模式)`
   * 再发起请求。`setMode` 是异步的，下一次渲染才生效 —— 如果这里读 `mode` state，
   * 拿到的仍是**旧模式**，于是「点根因分析的例子」会发出一个问答请求。
   * 这类 bug 不会报错，只会静默答错，所以宁可把参数一路传下来。
   */
  const runQuery = async (q: string, m: Mode) => {
    if (!q) return;

    // 影响面模式：与 handleSubmit 同一分支理由 —— 返回形状不同，不走 result 流程
    if (m === 'impact') {
      submitImpact(q);
      return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    setSearchStatus('');
    setResult(null);
    resultRef.current = null;
    setCallTreeResolved(false);

    try {
      if (m === 'search') {
        setSearchStatus('正在检索代码库...');
        const res = await fetch(`${API_BASE}/search?repoId=${repoId}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        const newResult: QAResponse = { query: q, answer: '', evidence: data.hits, kind: 'search' };
        setResult(newResult);
        resultRef.current = newResult;
        addToSearchHistory(q, m, repoId, newResult);
        setSearchHistory(getSearchHistory());
      } else if (m === 'ask') {
        setSearchStatus('正在检索证据并生成回答...');
        const res = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query: q }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('问答失败');
        const data = await res.json();
        const newResult: QAResponse = { ...data, kind: 'ask' };
        setResult(newResult);
        resultRef.current = newResult;
        if (data.answer) setConversationHistory(prev => [...prev, { query: q, answer: data.answer }]);
        addToSearchHistory(q, m, repoId, newResult);
        setSearchHistory(getSearchHistory());
      } else {
        setSearchStatus('正在进行根因分析...');
        const res = await fetch(`${API_BASE}/root-cause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query: q }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('根因分析失败');
        const data = await res.json();
        const newResult: QAResponse = { query: q, answer: data.rootCause, evidence: data.evidence, kind: 'root-cause' };
        setResult(newResult);
        resultRef.current = newResult;
        addToSearchHistory(q, m, repoId, newResult);
        setSearchHistory(getSearchHistory());
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setSearchStatus('');
      abortControllerRef.current = null;
    }
  };

  /** 点示例问题：切到该例子所属模式并立即提问（模式显式传，别依赖 state 更新时序） */
  const runExample = (q: string, m: Mode) => {
    setQuery(q);
    runQuery(q, m);
  };

  // Restore result when coming back from call graph
  useEffect(() => {
    if (resultRef.current && !result) {
      setResult(resultRef.current);
    }
  }, [result]);

  // 证据区的默认开合：调用关系建起来就收起（避免重复占屏），否则展开
  useEffect(() => {
    if (!result) return;
    const sig = `${mode}|${result.query}|${result.kind}|${callTreeResolved}`;
    if (evidenceSigRef.current === sig) return;
    evidenceSigRef.current = sig;
    setEvidenceOpen(mode === 'search' || !callTreeResolved);
  }, [mode, result, callTreeResolved]);

  const handleFeedbackSubmit = async (isHelpful: boolean) => {
    if (!result?.questionId || !feedbackText.trim()) return;

    setFeedbackSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/questions/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: result.questionId,
          feedbackText: feedbackText.trim(),
          isHelpful,
        }),
      });

      if (!res.ok) throw new Error('提交反馈失败');

      setFeedbackText('');
      setShowFeedbackForm(false);
      alert('感谢您的反馈！');
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  /**
   * 「继续提问」的取消键：正在生成中 = 中止这次请求；否则 = 收起输入框并清空。
   * （抽取 AnswerCard 时一并搬出：状态归 RepoPage，取消逻辑也留在状态的所有者这侧。）
   */
  const handleFollowUpCancel = () => {
    if (followUpSubmitted && loading && abortControllerRef.current) {
      abortControllerRef.current.abort();
      setFollowUpSubmitted(false);
    } else {
      setShowFollowUpInput(false);
      setFollowUpQuery('');
      setFollowUpSubmitted(false);
    }
  };

  const handleCopyAnswer = async () => {
    if (!result?.answer) return;
    try {
      await navigator.clipboard.writeText(result.answer);
      setAnswerCopied(true);
      setTimeout(() => setAnswerCopied(false), 2000);
    } catch {
      /* 剪贴板不可用时静默失败，不打断阅读 */
    }
  };

  // Filter results based on selected filters
  const filteredEvidence = result?.evidence.filter((hit: SearchHit) => {
    if (fileTypeFilter !== 'all') {
      const ext = hit.file_path.split('.').pop()?.toLowerCase();
      if (ext !== fileTypeFilter) return false;
    }
    if (symbolTypeFilter !== 'all') {
      if (hit.symbol_type !== symbolTypeFilter) return false;
    }
    return true;
  }) || [];

  // Get unique file types and symbol types from results
  const fileTypes = Array.from(new Set(result?.evidence.map((hit: SearchHit) =>
    hit.file_path.split('.').pop()?.toLowerCase() || 'unknown'
  ) || []));

  // 关联结果条数：它们与查询路径没有字面交集，是靠调用关系/版本占位推出来的
  const relatedCount = filteredEvidence.filter((hit: SearchHit) => hit.metadata?.relatedKind).length;

  const symbolTypes = Array.from(new Set(result?.evidence.map((hit: SearchHit) => hit.symbol_type).filter(Boolean) || []));

  // Pagination calculations
  const totalPages = Math.ceil(filteredEvidence.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedEvidence = filteredEvidence.slice(startIndex, endIndex);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [fileTypeFilter, symbolTypeFilter, result]);

  const activeMode = MODES.find(m => m.id === mode)!;
  const modeBadge = MODE_BADGE[mode];
  const repoLabel = repoDetail?.name || `仓库 #${repoId}`;
  const isZip = repoDetail?.source === 'zip';
  const repoWebUrl = repoDetail?.url || repoDetail?.gitlab_url || '';

  return (
    <div className="min-h-screen bg-slate-100">
      {/* ==================== 深色命令栏（与首页同一套品牌语言） ==================== */}
      <header className="bg-gradient-to-r from-slate-900 via-purple-950/60 to-slate-900 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 py-5 space-y-4">
          {/* 第一行：返回 + 品牌 + 仓库身份 + 索引规模 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1.5 text-slate-400 hover:text-cyan-300 transition-colors text-sm flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              仓库列表
            </button>

            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <span className="text-sm font-semibold bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                CodeLens
              </span>
            </div>

            <div className="w-px h-6 bg-slate-700 hidden sm:block" />

            {/* 仓库身份 */}
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h1 className="text-base font-semibold text-slate-100 truncate max-w-[280px]" title={repoLabel}>
                {repoLabel}
              </h1>
              {repoDetail && (
                <>
                  <span className={`px-1.5 py-0.5 rounded border text-[11px] font-medium ${
                    isZip
                      ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                      : 'bg-orange-500/15 border-orange-500/30 text-orange-300'
                  }`}>
                    {isZip ? 'ZIP' : 'GitLab'}
                  </span>
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${
                    repoDetail.status === 'ready' ? 'text-emerald-400'
                      : repoDetail.status === 'indexing' ? 'text-blue-400'
                      : 'text-red-400'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      repoDetail.status === 'ready' ? 'bg-emerald-400'
                        : repoDetail.status === 'indexing' ? 'bg-blue-400 animate-pulse'
                        : 'bg-red-400'
                    }`} />
                    {repoDetail.status === 'ready' ? '索引就绪' : repoDetail.status === 'indexing' ? '索引中' : '索引失败'}
                  </span>
                  {repoDetail.branch && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[11px] font-mono text-slate-400">
                      {repoDetail.branch}
                    </span>
                  )}
                  {repoWebUrl && (
                    <a
                      href={repoWebUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors flex items-center gap-1"
                    >
                      源码
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  )}
                </>
              )}
            </div>

            {/* 索引规模：说明「这个索引里到底有什么」 */}
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {repoStats ? (
                <>
                  {(
                    [
                      { label: '文件', value: repoStats.files },
                      { label: '代码块', value: repoStats.chunks },
                      // ⚠️ 这里必须用 interfacesCallable（可调用接口数），不能用 urlPatterns。
                      //    urlPatterns 是 url_patterns 的裸行数：同一接口因 helper 实参名不同
                      //    会被算成多行，还混着前端路由/构建产物 —— 曾把 277 当成接口数。
                      //    算不出来时降级显示「URL 行」并明说，**不要**把行数冒充接口数。
                      repoStats.interfacesCallable !== undefined
                        ? {
                            label: '接口',
                            value: repoStats.interfacesCallable,
                            onClick: () => setShowInventory(true),
                            hint: `可调用接口 ${repoStats.interfacesCallable} 个 = 已判定 method ${
                              repoStats.interfaces ?? '?'
                            } 个 + method 未判定但路径确认是接口的 ${
                              repoStats.interfacesCallable - (repoStats.interfaces ?? 0)
                            } 个。点击查看完整清单`,
                          }
                        : {
                            label: 'URL 行',
                            value: repoStats.urlPatterns,
                            hint: '接口清单暂不可用 —— 这里是原始 URL 行数，不是接口数',
                          },
                      { label: '调用边', value: repoStats.callEdges },
                    ] as Array<{ label: string; value: number; onClick?: () => void; hint?: string }>
                  ).map((s) => {
                    const inner = (
                      <>
                        <span className="text-[11px] text-slate-400">{s.label}</span>
                        <span className="text-sm font-semibold text-slate-100 font-mono">
                          {s.value}
                        </span>
                        {s.onClick && (
                          <svg
                            className="w-3 h-3 text-slate-500 group-hover:text-cyan-400 transition-colors"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        )}
                      </>
                    );
                    return s.onClick ? (
                      <button
                        key={s.label}
                        onClick={s.onClick}
                        title={s.hint}
                        className="group px-2.5 py-1 rounded-lg bg-slate-800/60 border border-slate-700
                                   flex items-baseline gap-1.5 hover:border-cyan-500/60 hover:bg-slate-800
                                   transition-colors cursor-pointer"
                      >
                        {inner}
                      </button>
                    ) : (
                      <div
                        key={s.label}
                        className="px-2.5 py-1 rounded-lg bg-slate-800/60 border border-slate-700 flex items-baseline gap-1.5"
                        title={`索引中的${s.label}数`}
                      >
                        {inner}
                      </div>
                    );
                  })}
                </>
              ) : (
                <div className="px-2.5 py-1 rounded-lg bg-slate-800/40 border border-slate-800 text-[11px] text-slate-500">
                  统计不可用
                </div>
              )}
            </div>
          </div>

          {/* 第二行：三档模式（原来是 hidden 的，现在是一等公民） */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex gap-1 p-1 rounded-xl bg-slate-800/60 border border-slate-700">
              {MODES.map(m => {
                const active = m.id === mode;
                return (
                  <button
                    key={m.id}
                    onClick={() => switchMode(m.id)}
                    title={m.hint}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      active
                        ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20'
                        : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            {/* 提示文案在深色渐变上 slate-400 几乎不可读；slate-300 才到 4.5:1 附近。
                移动端干脆隐藏 —— 那里它会折行占一整行，而 placeholder 已经说了同样的话。 */}
            <p className="hidden md:block text-xs text-slate-300">{activeMode.hint}</p>
          </div>

          {/* 第三行：提问框 */}
          <div className="relative">
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder={activeMode.placeholder}
                  value={query}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const newQuery = e.target.value;
                    setQuery(newQuery);

                    if (debounceTimerRef.current) {
                      clearTimeout(debounceTimerRef.current);
                    }

                    if (mode === 'search' && newQuery.trim()) {
                      debounceTimerRef.current = window.setTimeout(() => {
                        handleSubmit(false);
                      }, 800);
                    }
                  }}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && !loading) {
                      if (debounceTimerRef.current) {
                        clearTimeout(debounceTimerRef.current);
                      }
                      handleSubmit(false);
                    }
                  }}
                  onFocus={() => setShowHistory(true)}
                  onBlur={() => setTimeout(() => setShowHistory(false), 200)}
                  disabled={loading}
                  className="w-full px-4 py-3 bg-slate-900/70 border border-slate-700 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all disabled:opacity-50"
                />

                {/* Search history dropdown */}
                {showHistory && searchHistory.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-20 max-h-64 overflow-y-auto">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700 sticky top-0 bg-slate-800">
                      <span className="text-xs text-slate-400 font-medium">最近查询（仅本仓库）</span>
                      <button
                        onClick={() => {
                          clearSearchHistory();
                          setSearchHistory([]);
                        }}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors"
                      >
                        清空
                      </button>
                    </div>
                    {searchHistory.filter(item => item.repoId === repoId).map((item: SearchHistoryItem) => (
                      <div
                        key={item.id}
                        onClick={() => {
                          const savedResult = getSearchResult(item.id);
                          // switchMode 会清掉当前结果；历史记录若带着上次的结果快照，这里再整体还原
                          switchMode(item.mode);
                          setQuery(item.query);
                          if (savedResult) {
                            const restored: QAResponse = {
                              ...savedResult,
                              kind: savedResult.kind ?? item.mode,
                            };
                            setResult(restored);
                            resultRef.current = restored;
                          }
                          setShowHistory(false);
                        }}
                        className="px-4 py-2.5 hover:bg-slate-700/50 cursor-pointer transition-colors border-b border-slate-700/50 last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-slate-200 text-sm truncate">{item.query}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {new Date(item.timestamp).toLocaleString('zh-CN')}
                            </div>
                          </div>
                          <span className={`px-2 py-0.5 rounded border text-[11px] font-medium flex-shrink-0 ${MODE_BADGE[item.mode].className}`}>
                            {MODE_BADGE[item.mode].label}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => handleSubmit(false)}
                disabled={loading || !query}
                className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-xl hover:from-cyan-600 hover:to-blue-700 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed font-medium shadow-lg shadow-cyan-500/20 transition-all flex items-center justify-center min-w-[104px] text-sm"
              >
                {loading ? <LoadingSpinner className="h-4 w-4 border-white" /> : '提交'}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ==================== 浅色工作区 ==================== */}
      <main className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {/* 增量更新：放在最前面，因为它是「这个索引现在准不准」的前提。
            查询区在上面（深色命令栏），结果区在下面 —— 这里夹在中间，
            主动看的人看得见，不关心的人也不会被它挡住查询。 */}
        <IncrementalPanel
          repoId={repoId}
          repoDetail={repoDetail}
          onReload={() => setRepoReloadToken((v) => v + 1)}
        />

        {/* Loading status indicator */}
        {loading && searchStatus && (
          <div className="p-4 bg-white border border-cyan-200 rounded-xl shadow-sm">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-600" />
              <span className="text-slate-700 text-sm font-medium">{searchStatus}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* ---------- 空态：把「这个页面能做什么」直接摆在面前 ---------- */}
        {/* 影响面模式不显示它 —— 那种模式下由 ImpactPanel 自己承担引导，
            两个引导同时出现会互相抢注意力。 */}
        {!result && !loading && mode !== 'impact' && (
          <Card className="p-6">
            <h2 className="text-base font-semibold text-slate-900 mb-1">这个仓库能回答什么</h2>
            <p className="text-xs text-slate-500 mb-5">
              索引的是 <span className="font-mono text-slate-700">{repoLabel}</span>
              {repoStats && (
                <>
                  {' · '}
                  {repoStats.files} 个文件 / {repoStats.chunks} 个代码块
                  {repoStats.urlPatterns > 0 && <> / {repoStats.urlPatterns} 个接口</>}
                </>
              )}
              。选一种模式，或直接点下面的例子。
            </p>

            {/* 4 张模式卡：md 两列 / xl 一行四张。原来的 md:grid-cols-3 会让
                第四张（影响面）孤零零掉到第二行，视觉上像残缺的列表。 */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {MODES.map(m => (
                <div
                  key={m.id}
                  className={`rounded-xl border p-4 transition-all cursor-pointer ${
                    m.id === mode
                      ? 'border-cyan-300 bg-cyan-50/50 ring-1 ring-cyan-200'
                      : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                  }`}
                  onClick={() => switchMode(m.id)}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded border text-[11px] font-medium ${MODE_BADGE[m.id].className}`}>
                      {m.label}
                    </span>
                    {m.id === mode && <span className="text-[11px] text-cyan-700 font-medium">当前</span>}
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed mb-3">{m.hint}</p>
                  <div className="space-y-1.5">
                    {EXAMPLE_QUESTIONS[m.id].map(q => (
                      <button
                        key={q}
                        onClick={(e) => {
                          e.stopPropagation();
                          switchMode(m.id);
                          runExample(q, m.id);
                        }}
                        className="w-full text-left text-xs text-blue-700 hover:text-blue-800 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-lg px-2.5 py-1.5 transition-all truncate"
                        title={q}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-slate-100 text-[11px] text-slate-500 leading-relaxed">
              结果会同时给出<b className="text-slate-700">代码证据</b>与
              <b className="text-slate-700">调用关系</b>；若证据不足以回答，会明确说明「证据不足」而不是编造。
              只有 TS / JS / Vue 源码会进索引。
            </div>
          </Card>
        )}

        {/* ---------- 影响面模式：独立一套渲染（返回形状与前三种模式完全不同） ---------- */}
        {mode === 'impact' && (
          <Card>
            <CardHeader
              title="影响面分析"
              icon={
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              }
              iconClass="bg-gradient-to-br from-violet-500 to-fuchsia-600"
              subtitle="基于真实的关系数据（call_graph / file_dependencies）做传递闭包，不是按字符串相似度猜的"
              right={
                <span className="hidden md:block text-[11px] text-slate-500">
                  没有结果不等于没有影响 —— 请看结果里的「结论强度」
                </span>
              }
            />

            <div className="px-5 py-5 space-y-4">
              {/* 还没提交过：给几个能直接点的例子，避免对着空面板发呆 */}
              {!impactTarget && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">试试：</span>
                  {EXAMPLE_QUESTIONS.impact.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => {
                        setQuery(ex);
                        // 不指定类型：和手动输入走同一条推断路径，避免两套判断不一致
                        submitImpact(ex);
                      }}
                      className="text-xs text-violet-700 hover:text-violet-800 bg-white hover:bg-violet-50 border border-slate-200 hover:border-violet-300 rounded-lg px-2.5 py-1.5 transition-all font-mono"
                      title={ex.includes('/') ? '以文件方式查询影响面' : '以符号方式查询影响面'}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )}

              <ImpactPanel
                repoId={repoId}
                target={impactTarget}
                runToken={impactToken}
                initialKind={impactKind ?? undefined}
                onDrillDown={(t, k) => {
                  // 「追下去」：把某个受影响节点变成新的起点。
                  // 同时写回输入框，让使用者看得见自己现在在查什么。
                  setQuery(t);
                  submitImpact(t, k);
                }}
              />
            </div>
          </Card>
        )}

        {result && (
          <>
            {/* ---------- 回答（问答模式） ---------- */}
            {result.kind !== 'search' && result.answer && (
              <AnswerCard
                result={result}
                badge={modeBadge}
                conversationTurns={conversationHistory.length}
                loading={loading}
                copied={answerCopied}
                onCopy={handleCopyAnswer}
                followUpOpen={showFollowUpInput}
                onFollowUpOpenChange={setShowFollowUpInput}
                followUpQuery={followUpQuery}
                onFollowUpQueryChange={setFollowUpQuery}
                followUpSubmitted={followUpSubmitted}
                onFollowUpSubmittedChange={setFollowUpSubmitted}
                onSubmitFollowUp={() => handleSubmit(true)}
                onFollowUpCancel={handleFollowUpCancel}
                feedbackOpen={showFeedbackForm}
                onFeedbackOpenChange={setShowFeedbackForm}
                feedbackText={feedbackText}
                onFeedbackTextChange={setFeedbackText}
                feedbackSubmitting={feedbackSubmitting}
                onFeedbackSubmit={handleFeedbackSubmit}
              />
            )}

            {/* 搜索模式没有生成内容，明确说一句，免得用户以为漏了回答 */}
            {result.kind === 'search' && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-500 shadow-sm">
                <svg className="w-4 h-4 text-cyan-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                搜索模式只做检索定位，不生成回答 —— 命中结果在下方「检索证据」里。想让它解释，切到<b className="text-slate-700">问答</b>。
              </div>
            )}

            {/* ---------- 主视图：调用关系 ---------- */}
            <Card>
              <CardHeader
                title="调用关系"
                icon={
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.99 1.99 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                }
                iconClass="bg-gradient-to-br from-emerald-500 to-teal-600"
                subtitle="依据提问语义自动判断方向：谁调用了它 / 它调用了谁"
              />
              <div className="px-5 py-5">
                <QueryCallTree
                  repoId={repoId}
                  query={result.query}
                  candidates={result.evidence.map((e: SearchHit) => ({ symbol: e.symbol_name, filePath: e.file_path }))}
                  onResolvedChange={setCallTreeResolved}
                />
              </div>
            </Card>

            {/* ---------- 检索证据（可折叠：调用关系建起来时默认收起） ---------- */}
            <Card>
              <CardHeader
                title="检索证据"
                icon={
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                }
                iconClass="bg-gradient-to-br from-purple-500 to-indigo-600"
                subtitle={
                  <span className="flex items-center gap-2 flex-wrap">
                    <span>共 {result.evidence.length} 条命中</span>
                    {relatedCount > 0 && (
                      <span
                        className="px-1.5 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-normal"
                        title="这些位置与查询路径没有字面交集，是通过调用关系或版本占位推出来的"
                      >
                        含 {relatedCount} 条关联
                      </span>
                    )}
                  </span>
                }
                right={
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* 视图切换：平铺列表 / 调用树 */}
                    <div className="flex items-center rounded-lg border border-slate-300 overflow-hidden">
                      <button
                        onClick={() => setEvidenceView('list')}
                        className={`px-2.5 py-1 text-xs transition-all ${
                          evidenceView === 'list' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                        title="按相关度平铺的原始证据列表"
                      >
                        列表
                      </button>
                      <button
                        onClick={() => setEvidenceView('tree')}
                        className={`px-2.5 py-1 text-xs transition-all border-l border-slate-300 ${
                          evidenceView === 'tree' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                        title="按 call_graph 聚合，展示证据之间的调用关系"
                      >
                        调用树
                      </button>
                    </div>

                    <div className="w-px h-5 bg-slate-200" />

                    <div className="flex items-center gap-2">
                      <Filter className="w-3.5 h-3.5 text-slate-500" />
                      <select
                        value={fileTypeFilter}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) => setFileTypeFilter(e.target.value)}
                        className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg text-xs text-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                      >
                        <option value="all">所有文件类型</option>
                        {fileTypes.map(type => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={symbolTypeFilter}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) => setSymbolTypeFilter(e.target.value)}
                        className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg text-xs text-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                      >
                        <option value="all">所有符号类型</option>
                        {symbolTypes.map(type => (
                          <option key={type} value={type}>{type}</option>
                        ))}
                      </select>
                    </div>

                    <button
                      onClick={() => setEvidenceOpen(o => !o)}
                      className="px-3 py-1 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-all text-xs font-medium"
                    >
                      {evidenceOpen ? '收起' : `展开 (${filteredEvidence.length})`}
                    </button>
                  </div>
                }
              />

              {evidenceOpen && (
                <div className="px-5 py-5">
                  {filteredEvidence.length === 0 ? (
                    <div className="text-slate-500 text-center py-8 bg-slate-50 rounded-lg border border-slate-200 text-sm">
                      {result.evidence.length === 0 ? '未找到相关代码' : '没有符合筛选条件的结果'}
                    </div>
                  ) : evidenceView === 'tree' ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-slate-400 px-1">
                        调用树展示全部 {filteredEvidence.length} 条筛选结果之间的关系（不受列表分页影响）。
                      </div>
                      <EvidenceCallTree
                        repoId={repoId}
                        items={filteredEvidence}
                        maxDepth={2}
                        onOpenCallGraph={(symbol: string) => {
                          setCallGraphSymbol(symbol);
                          setShowCallGraphModal(true);
                        }}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="space-y-3">
                        {paginatedEvidence.map((hit: SearchHit, i: number) => {
                          const itemId = hit.id;
                          const isExpanded = expandedItems.has(itemId);
                          const relatedKind = hit.metadata?.relatedKind;
                          const usageLabel = relatedKind
                            ? RELATED_LABELS[relatedKind]
                            : hit.symbol_type
                              ? hit.symbol_type
                              : hit.metadata?.usageContext
                                ? (USAGE_CONTEXT_LABELS[hit.metadata.usageContext] || hit.metadata.usageContext)
                                : '';

                          return (
                            <div key={hit.id} className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden hover:border-blue-400 transition-all">
                              <div
                                className="p-4 cursor-pointer"
                                onClick={() => {
                                  const newExpanded = new Set(expandedItems);
                                  if (isExpanded) {
                                    newExpanded.delete(itemId);
                                  } else {
                                    newExpanded.add(itemId);
                                  }
                                  setExpandedItems(newExpanded);
                                }}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3 flex-1 min-w-0">
                                    <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-slate-900 text-white text-xs font-bold flex-shrink-0">
                                      {startIndex + i + 1}
                                    </span>
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                      {usageLabel && (
                                        <span
                                          className={`px-2 py-0.5 border rounded font-mono text-xs flex-shrink-0 ${
                                            relatedKind
                                              ? 'bg-amber-100 border-amber-300 text-amber-800'
                                              : 'bg-blue-100 border-blue-200 text-blue-700'
                                          }`}
                                          title={relatedKind ? RELATED_EXPLAIN[relatedKind] : undefined}
                                        >
                                          {usageLabel}
                                        </span>
                                      )}
                                      {hit.symbol_name ? (
                                        <span className="text-slate-900 text-sm font-medium truncate">{highlightText(hit.symbol_name, result.query)}</span>
                                      ) : hit.metadata?.constantValue ? (
                                        <span className="text-slate-700 font-mono text-xs truncate" title={hit.metadata.constantValue}>
                                          {hit.metadata.constantValue}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                    {hit.similarity != null && (
                                      <div className="px-2 py-0.5 bg-green-100 border border-green-200 rounded text-xs text-green-700 font-medium">
                                        {(hit.similarity * 100).toFixed(0)}%
                                      </div>
                                    )}
                                    {hit.symbol_name && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setCallGraphSymbol(hit.symbol_name);
                                          setShowCallGraphModal(true);
                                        }}
                                        className="px-3 py-1 bg-purple-100 border border-purple-200 text-purple-700 rounded hover:bg-purple-200 transition-all text-xs font-medium"
                                      >
                                        调用图
                                      </button>
                                    )}
                                    {/* 从检索结果直接就着这个符号查影响面：
                                        这是最自然的入口 —— 你刚看到它，接下来就会问「改它会动到什么」 */}
                                    {hit.symbol_name && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          switchMode('impact');
                                          setQuery(hit.symbol_name);
                                          submitImpact(hit.symbol_name, 'symbol');
                                        }}
                                        title="改动这个符号会波及哪些位置"
                                        className="px-3 py-1 bg-violet-100 border border-violet-200 text-violet-700 rounded hover:bg-violet-200 transition-all text-xs font-medium"
                                      >
                                        影响面
                                      </button>
                                    )}
                                    <svg
                                      className={`w-5 h-5 text-slate-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                  </div>
                                </div>
                                <div className="mt-2 text-xs text-slate-600 flex items-center gap-1">
                                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  <span className="truncate">{highlightText(hit.file_path, result.query)}</span>
                                  <span className="text-slate-400 flex-shrink-0">:{hit.line_start}-{hit.line_end}</span>
                                </div>
                              </div>

                              {isExpanded && (
                                <div className="px-4 pb-4 border-t border-slate-200">
                                  {relatedKind && (
                                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                      <svg className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                      </svg>
                                      <p className="text-xs leading-relaxed text-amber-900">
                                        {RELATED_EXPLAIN[relatedKind]}
                                        {hit.metadata?.constantValue && (
                                          <span className="block mt-1 text-amber-700">
                                            关联到：<span className="font-mono">{hit.metadata.constantValue}</span>
                                          </span>
                                        )}
                                      </p>
                                    </div>
                                  )}
                                  <div className="mt-3">
                                    <CodeBlock
                                      code={hit.code_text}
                                      language="typescript"
                                      lineStart={hit.line_start}
                                      filePath={hit.file_path}
                                      repoUrl={repoWebUrl}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Pagination controls */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mt-6">
                          <button
                            onClick={() => setCurrentPage((prev: number) => Math.max(1, prev - 1))}
                            disabled={currentPage === 1}
                            className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 transition-all text-sm"
                          >
                            上一页
                          </button>

                          <div className="flex gap-1">
                            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => {
                              if (
                                page === 1 ||
                                page === totalPages ||
                                (page >= currentPage - 1 && page <= currentPage + 1)
                              ) {
                                return (
                                  <button
                                    key={page}
                                    onClick={() => setCurrentPage(page)}
                                    className={`px-3 py-1.5 rounded-lg font-medium transition-all text-sm ${
                                      currentPage === page
                                        ? 'bg-slate-900 text-white'
                                        : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
                                    }`}
                                  >
                                    {page}
                                  </button>
                                );
                              } else if (page === currentPage - 2 || page === currentPage + 2) {
                                return <span key={page} className="px-2 text-slate-400 text-sm">...</span>;
                              }
                              return null;
                            })}
                          </div>

                          <button
                            onClick={() => setCurrentPage((prev: number) => Math.min(totalPages, prev + 1))}
                            disabled={currentPage === totalPages}
                            className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 transition-all text-sm"
                          >
                            下一页
                          </button>

                          <span className="text-xs text-slate-500 ml-2">
                            {currentPage} / {totalPages}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </Card>
          </>
        )}
      </main>

      {/* Call Graph Modal */}
      {showCallGraphModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[80vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                调用图: <span className="font-mono">{callGraphSymbol}</span>
              </h2>
              <button
                onClick={() => {
                  setShowCallGraphModal(false);
                  setCallGraphSymbol('');
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center bg-slate-50">
                    <div className="flex flex-col items-center gap-3">
                      <LoadingSpinner className="h-6 w-6 border-cyan-600" />
                      <span className="text-xs text-slate-500">正在加载调用图…</span>
                    </div>
                  </div>
                }
              >
                <LazyCallGraph
                  repoId={repoId}
                  symbolName={callGraphSymbol}
                  onSymbolClick={(newSymbol) => {
                    setCallGraphSymbol(newSymbol);
                  }}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {/* 接口清单弹层：顶栏「接口 N」点开的完整清单 */}
      {showInventory && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 flex-shrink-0">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h7"
                  />
                </svg>
                接口清单
                <span className="text-xs font-normal text-slate-500">
                  仓库 #{repoId}
                </span>
              </h2>
              <button
                onClick={() => setShowInventory(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors"
                title="关闭"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center bg-slate-50">
                    <div className="flex flex-col items-center gap-3">
                      <LoadingSpinner className="h-6 w-6 border-cyan-600" />
                      <span className="text-xs text-slate-500">正在读取接口清单…</span>
                    </div>
                  </div>
                }
              >
                <LazyInterfaceInventory repoId={repoId} />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
