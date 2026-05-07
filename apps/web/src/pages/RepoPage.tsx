import { useState, useEffect, ChangeEvent, KeyboardEvent, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QAResponse, SearchHit } from '../types';
import { API_BASE } from '../utils/constants';
import { getSearchHistory, addToSearchHistory, clearSearchHistory, getSearchResult } from '../utils/searchHistory';
import { SearchHistoryItem } from '../types';
import { highlightText } from '../utils/textUtils';
import { CodeBlock } from '../components/common/CodeBlock';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CallGraph } from '../components/CallGraph';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
// 导入常用语言支持
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';

const Filter = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
  </svg>
);

export function RepoPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const repoId = id || '';
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'search' | 'ask' | 'root-cause'>('ask'); // 默认问答模式
  const [result, setResult] = useState<QAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>(getSearchHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [repoUrl, setRepoUrl] = useState<string>('');
  const [searchStatus, setSearchStatus] = useState<string>('');

  // Feedback states
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  // Filter states
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [symbolTypeFilter, setSymbolTypeFilter] = useState<string>('all');

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);

  // Collapse states for code evidence
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  // Conversation context for follow-up questions
  const [conversationHistory, setConversationHistory] = useState<Array<{query: string; answer: string}>>([]);
  const [showFollowUpInput, setShowFollowUpInput] = useState(false);
  const [followUpQuery, setFollowUpQuery] = useState('');
  const [followUpSubmitted, setFollowUpSubmitted] = useState(false); // 追踪是否已提交请求

  // Call graph modal state
  const [showCallGraphModal, setShowCallGraphModal] = useState(false);
  const [callGraphSymbol, setCallGraphSymbol] = useState<string>('');

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

  // Fetch repo URL
  useEffect(() => {
    const fetchRepoUrl = async () => {
      try {
        const res = await fetch(`${API_BASE}/repos/${repoId}`);
        if (res.ok) {
          const repo = await res.json();
          setRepoUrl(repo.url || '');
        }
      } catch (err) {
        console.error('Failed to fetch repo URL:', err);
      }
    };
    if (repoId) {
      fetchRepoUrl();
    }
  }, [repoId]);

  const handleSubmit = async (isFollowUp = false) => {
    const searchQuery = isFollowUp ? followUpQuery : query;
    if (!searchQuery) return;

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

    try {
      if (mode === 'search') {
        setSearchStatus('正在搜索代码库...');
        const res = await fetch(`${API_BASE}/search?repoId=${repoId}&q=${encodeURIComponent(searchQuery)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        const newResult = { query: searchQuery, answer: '', evidence: data.hits };
        setResult(newResult);
        resultRef.current = newResult;

        // Add to search history
        addToSearchHistory(searchQuery, mode, repoId, newResult);
        setSearchHistory(getSearchHistory());
      } else if (mode === 'ask') {
        setSearchStatus('正在分析问题...');
        const res = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query: searchQuery }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('问答失败');
        const data = await res.json();
        setResult(data);
        resultRef.current = data;

        // Add to conversation history
        if (data.answer) {
          setConversationHistory(prev => [...prev, { query: searchQuery, answer: data.answer }]);
        }

        // Add to search history
        addToSearchHistory(searchQuery, mode, repoId, data);
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
        const newResult = { query: searchQuery, answer: data.rootCause, evidence: data.evidence };
        setResult(newResult);
        resultRef.current = newResult;

        // Add to search history
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

  // Restore result when coming back from call graph
  useEffect(() => {
    if (resultRef.current && !result) {
      setResult(resultRef.current);
    }
  }, [result]);

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

  // Filter results based on selected filters
  const filteredEvidence = result?.evidence.filter((hit: SearchHit) => {
    // File type filter
    if (fileTypeFilter !== 'all') {
      const ext = hit.file_path.split('.').pop()?.toLowerCase();
      if (ext !== fileTypeFilter) return false;
    }

    // Symbol type filter
    if (symbolTypeFilter !== 'all') {
      if (hit.symbol_type !== symbolTypeFilter) return false;
    }

    return true;
  }) || [];

  // Get unique file types and symbol types from results
  const fileTypes = Array.from(new Set(result?.evidence.map((hit: SearchHit) =>
    hit.file_path.split('.').pop()?.toLowerCase() || 'unknown'
  ) || []));

  const symbolTypes = Array.from(new Set(result?.evidence.map((hit: SearchHit) =>
    hit.symbol_type
  ) || []));

  // Pagination calculations
  const totalPages = Math.ceil(filteredEvidence.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedEvidence = filteredEvidence.slice(startIndex, endIndex);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [fileTypeFilter, symbolTypeFilter, result]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-blue-600 hover:text-blue-700 transition-colors group"
          >
            <svg className="w-5 h-5 transform group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span className="font-medium">返回首页</span>
          </button>

          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900">
              CodeLens
            </h1>
          </div>

          <div className="w-24"></div>
        </div>

        {/* Mode Selector - 隐藏但保留功能 */}
        <div className="hidden mb-6 bg-white rounded-xl p-1.5 border border-gray-200 inline-flex gap-1.5 shadow-sm">
          <button
            onClick={() => setMode('search')}
            className={`px-6 py-2.5 rounded-lg font-medium transition-all ${
              mode === 'search'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              搜索
            </div>
          </button>
          <button
            onClick={() => setMode('ask')}
            className={`px-6 py-2.5 rounded-lg font-medium transition-all ${
              mode === 'ask'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              问答
            </div>
          </button>
          <button
            onClick={() => setMode('root-cause')}
            className={`px-6 py-2.5 rounded-lg font-medium transition-all ${
              mode === 'root-cause'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              根因分析
            </div>
          </button>
        </div>

        {/* Search Box */}
        <div className="mb-6 relative">
          <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder="💬 提问：登录方案是什么？"
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
                  className="w-full px-4 py-2.5 bg-gray-50 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-50 text-gray-900 placeholder-gray-400 text-sm"
                />

                {/* Search history dropdown */}
                {showHistory && searchHistory.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-lg z-10 max-h-60 overflow-y-auto">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                      <span className="text-sm text-gray-600 font-medium">搜索历史</span>
                      <button
                        onClick={() => {
                          clearSearchHistory();
                          setSearchHistory([]);
                        }}
                        className="text-xs text-red-600 hover:text-red-700 transition-colors"
                      >
                        清空
                      </button>
                    </div>
                    {searchHistory.filter(item => item.repoId === repoId).map((item: SearchHistoryItem) => (
                      <div
                        key={item.id}
                        onClick={() => {
                          const savedResult = getSearchResult(item.id);
                          if (savedResult) {
                            setQuery(item.query);
                            setMode(item.mode);
                            setResult(savedResult);
                            resultRef.current = savedResult;
                          } else {
                            setQuery(item.query);
                            setMode(item.mode);
                          }
                          setShowHistory(false);
                        }}
                        className="px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors border-b border-gray-100 last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-gray-900 text-sm truncate">{item.query}</div>
                            <div className="text-xs text-gray-500 mt-1">
                              {new Date(item.timestamp).toLocaleString('zh-CN')}
                            </div>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                            item.mode === 'search' ? 'bg-blue-100 text-blue-700' :
                            item.mode === 'ask' ? 'bg-green-100 text-green-700' :
                            'bg-purple-100 text-purple-700'
                          }`}>
                            {item.mode === 'search' ? '搜索' : item.mode === 'ask' ? '问答' : '根因'}
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
                className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium shadow-sm transition-all flex items-center justify-center min-w-[100px] text-sm"
              >
                {loading ? <LoadingSpinner /> : '提交'}
              </button>
            </div>
          </div>
        </div>

        {/* Loading status indicator */}
        {loading && searchStatus && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
              <span className="text-blue-700 font-medium">{searchStatus}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-6">
            {result.answer && (
              <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
                <h3 className="text-xl font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  回答
                </h3>
                <div className="prose prose-sm max-w-none">
                  <div className="text-gray-700 leading-relaxed">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({node, ...props}) => <p className="mb-3 text-sm" {...props} />,
                        h1: ({node, ...props}) => <h1 className="text-lg font-bold mb-3 mt-4" {...props} />,
                        h2: ({node, ...props}) => <h2 className="text-base font-bold mb-2 mt-3" {...props} />,
                        h3: ({node, ...props}) => <h3 className="text-sm font-bold mb-2 mt-3" {...props} />,
                        ul: ({node, ...props}) => <ul className="list-disc list-inside mb-3 text-sm space-y-1" {...props} />,
                        ol: ({node, ...props}) => <ol className="list-decimal mb-3 text-sm space-y-1 pl-5" {...props} />,
                        li: ({node, ...props}) => <li className="text-sm" {...props} />,
                        code: ({node, className, children, ...props}) => {
                          const isInline = !className;

                          if (isInline) {
                            return <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono text-red-600" {...props}>{children}</code>;
                          }

                          // 代码块：使用 Prism 高亮
                          const match = /language-(\w+)/.exec(className || '');
                          const language = match ? match[1] : 'typescript';
                          const code = String(children).replace(/\n$/, '');

                          try {
                            const grammar = Prism.languages[language];
                            if (grammar) {
                              const highlighted = Prism.highlight(code, grammar, language);
                              return (
                                <code
                                  className={`language-${language}`}
                                  dangerouslySetInnerHTML={{ __html: highlighted }}
                                  {...props}
                                />
                              );
                            }
                          } catch (e) {
                            console.error('Prism highlight error:', e);
                          }

                          // 降级：无高亮
                          return <code className="block text-xs font-mono" {...props}>{children}</code>;
                        },
                        pre: ({node, children, ...props}) => (
                          <pre className="bg-gray-900 p-4 rounded-lg mb-3 overflow-x-auto" {...props}>
                            {children}
                          </pre>
                        ),
                        blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-gray-300 pl-4 italic text-sm text-gray-600 mb-3" {...props} />,
                        a: ({node, ...props}) => <a className="text-blue-600 hover:underline text-sm" {...props} />,
                        strong: ({node, ...props}) => <strong className="font-semibold" {...props} />,
                        em: ({node, ...props}) => <em className="italic" {...props} />,
                      }}
                    >
                      {result.answer}
                    </ReactMarkdown>
                  </div>
                </div>

                {/* Follow-up question section */}
                {!showFollowUpInput ? (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <button
                      onClick={() => setShowFollowUpInput(true)}
                      className="flex items-center gap-2 text-blue-600 hover:text-blue-700 text-sm font-medium transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                      继续提问
                    </button>
                  </div>
                ) : (
                  <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                    <input
                      type="text"
                      placeholder="继续提问，例如：能详细说明一下这个函数的实现吗？"
                      value={followUpQuery}
                      onChange={(e) => setFollowUpQuery(e.target.value)}
                      disabled={loading}
                      className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all disabled:opacity-50 text-gray-900 placeholder-gray-400 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setFollowUpSubmitted(true);
                          handleSubmit(true);
                        }}
                        disabled={loading || !followUpQuery.trim()}
                        className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-all text-sm"
                      >
                        {loading ? <LoadingSpinner /> : '提交'}
                      </button>
                      <button
                        onClick={() => {
                          if (followUpSubmitted && loading && abortControllerRef.current) {
                            // 如果请求已发送且正在加载，取消请求
                            abortControllerRef.current.abort();
                            setFollowUpSubmitted(false);
                          } else {
                            // 如果请求未发送，折叠输入框
                            setShowFollowUpInput(false);
                            setFollowUpQuery('');
                            setFollowUpSubmitted(false);
                          }
                        }}
                        disabled={loading && !followUpSubmitted}
                        className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                {/* Historical Feedback Display */}
                {result.historicalFeedback && result.historicalFeedback.length > 0 && (
                  <div className="mt-6 pt-6 border-t border-gray-200">
                    <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                      <svg className="w-4 h-4 mr-2 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                      历史相关反馈
                    </h4>
                    <div className="space-y-2">
                      {result.historicalFeedback.map((item, idx) => (
                        <div key={idx} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                          <p className="text-xs text-gray-600 mb-2">相关问题: {item.query}</p>
                          {item.feedback.map((fb, fbIdx) => (
                            <div key={fbIdx} className="flex items-start gap-2 text-sm">
                              <span className={`mt-0.5 ${fb.is_helpful ? 'text-green-600' : 'text-orange-600'}`}>
                                {fb.is_helpful ? '✓' : '⚠'}
                              </span>
                              <span className="text-gray-700">{fb.feedback_text}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Feedback Form */}
                {result.questionId && (
                  <div className="mt-6 pt-6 border-t border-gray-200">
                    {!showFeedbackForm ? (
                      <button
                        onClick={() => setShowFeedbackForm(true)}
                        className="flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium transition-colors text-sm"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                        </svg>
                        添加反馈
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <label className="block text-sm font-medium text-gray-900">
                          您的反馈
                        </label>
                        <textarea
                          value={feedbackText}
                          onChange={(e) => setFeedbackText(e.target.value)}
                          placeholder="例如：这个登录流程已经被废弃，现在使用 OAuth2.0 方式"
                          disabled={feedbackSubmitting}
                          className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all disabled:opacity-50 text-gray-900 placeholder-gray-400 resize-none text-sm"
                          rows={3}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleFeedbackSubmit(true)}
                            disabled={feedbackSubmitting || !feedbackText.trim()}
                            className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-all text-sm"
                          >
                            {feedbackSubmitting ? <LoadingSpinner /> : '✓ 有帮助'}
                          </button>
                          <button
                            onClick={() => handleFeedbackSubmit(false)}
                            disabled={feedbackSubmitting || !feedbackText.trim()}
                            className="flex-1 bg-orange-600 text-white py-2 px-4 rounded-lg hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-all text-sm"
                          >
                            {feedbackSubmitting ? <LoadingSpinner /> : '⚠ 需修正'}
                          </button>
                          <button
                            onClick={() => {
                              setShowFeedbackForm(false);
                              setFeedbackText('');
                            }}
                            disabled={feedbackSubmitting}
                            className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed transition-all text-sm"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
            </div>
          )}

          <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                </div>
                代码证据 ({filteredEvidence.length})
              </h3>

              {/* Filters */}
              <div className="flex gap-2">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-500" />
                  <select
                    value={fileTypeFilter}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setFileTypeFilter(e.target.value)}
                    className="px-3 py-1.5 bg-gray-50 border border-gray-300 rounded-lg text-sm text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
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
                    className="px-3 py-1.5 bg-gray-50 border border-gray-300 rounded-lg text-sm text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                  >
                    <option value="all">所有符号类型</option>
                    {symbolTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {filteredEvidence.length === 0 ? (
              <div className="text-gray-500 text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
                {result.evidence.length === 0 ? '未找到相关代码' : '没有符合筛选条件的结果'}
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {paginatedEvidence.map((hit: SearchHit, i: number) => {
                    const itemId = hit.id;
                    const isExpanded = expandedItems.has(itemId);

                    return (
                      <div key={hit.id} className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden hover:border-blue-400 transition-all">
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
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-blue-600 text-white text-xs font-bold flex-shrink-0">
                                {startIndex + i + 1}
                              </span>
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span className="px-2 py-0.5 bg-blue-100 border border-blue-200 rounded text-blue-700 font-mono text-xs flex-shrink-0">
                                  {hit.symbol_type}
                                </span>
                                <span className="text-gray-900 text-sm font-medium truncate">{highlightText(hit.symbol_name, query)}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                              {hit.similarity && (
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
                              <svg
                                className={`w-5 h-5 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                          </div>
                          <div className="mt-2 text-xs text-gray-600 flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span className="truncate">{highlightText(hit.file_path, query)}</span>
                            <span className="text-gray-400 flex-shrink-0">:{hit.line_start}-{hit.line_end}</span>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-4 pb-4 border-t border-gray-200">
                            <div className="mt-3">
                              <CodeBlock
                                code={hit.code_text}
                                language="typescript"
                                lineStart={hit.line_start}
                                filePath={hit.file_path}
                                repoUrl={repoUrl}
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
                      className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-gray-700 transition-all text-sm"
                    >
                      上一页
                    </button>

                    <div className="flex gap-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => {
                        // Show first page, last page, current page, and pages around current
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
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {page}
                            </button>
                          );
                        } else if (page === currentPage - 2 || page === currentPage + 2) {
                          return <span key={page} className="px-2 text-gray-400 text-sm">...</span>;
                        }
                        return null;
                      })}
                    </div>

                    <button
                      onClick={() => setCurrentPage((prev: number) => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-gray-700 transition-all text-sm"
                    >
                      下一页
                    </button>

                    <span className="text-xs text-gray-500 ml-2">
                      {currentPage} / {totalPages}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      </div>

      {/* Call Graph Modal */}
      {showCallGraphModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[80vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                调用图: {callGraphSymbol}
              </h2>
              <button
                onClick={() => {
                  setShowCallGraphModal(false);
                  setCallGraphSymbol('');
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-hidden">
              <CallGraph
                repoId={repoId}
                symbolName={callGraphSymbol}
                onSymbolClick={(newSymbol) => {
                  setCallGraphSymbol(newSymbol);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
