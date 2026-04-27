import { useState, useEffect, ChangeEvent, KeyboardEvent, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import { CallGraph } from './components/CallGraph.js';

// Simple Filter icon component
const Filter = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
  </svg>
);

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787';

type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  status: 'ready' | 'indexing' | 'failed';
  created_at: string;
};

type SearchHit = {
  id: number;
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  similarity?: number;
};

type QAResponse = {
  questionId?: number;
  query: string;
  answer: string;
  evidence: SearchHit[];
  historicalFeedback?: Array<{
    query: string;
    answer: string;
    feedback: Array<{ feedback_text: string; is_helpful: boolean }>;
  }>;
};

// Toast notification component
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed top-4 right-4 px-6 py-3 rounded-lg shadow-lg ${type === 'success' ? 'bg-green-500' : 'bg-red-500'} text-white z-50`}>
      {message}
    </div>
  );
}

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}

// Code block with syntax highlighting
function CodeBlock({ code, language }: { code: string; language: string }) {
  useEffect(() => {
    Prism.highlightAll();
  }, [code]);

  return (
    <pre className="bg-gray-900 p-4 rounded text-sm overflow-x-auto">
      <code className={`language-${language}`}>{code}</code>
    </pre>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [gitlabToken, setGitlabToken] = useState('');
  const [activeTab, setActiveTab] = useState<'gitlab' | 'upload'>('gitlab');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const { data: repos, isLoading: reposLoading, error: reposError } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/repos`);
      if (!res.ok) throw new Error('Failed to fetch repos');
      return res.json();
    },
    refetchInterval: (query) => {
      // 只在有 indexing 状态的仓库时才轮询
      const data = query.state.data as Repo[] | undefined;
      const hasIndexing = data?.some(repo => repo.status === 'indexing');
      return hasIndexing ? 3000 : false;
    },
  });

  const createRepoMutation = useMutation({
    mutationFn: async (data: { name: string; source: 'gitlab'; url: string; gitlabToken?: string }) => {
      const res = await fetch(`${API_BASE}/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create repo');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setGitlabUrl('');
      setRepoName('');
      setGitlabToken('');
      setToast({ message: '仓库接入成功，正在索引...', type: 'success' });
    },
    onError: (error: Error) => {
      setToast({ message: `接入失败: ${error.message}`, type: 'error' });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE}/repos/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to upload file');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setToast({ message: '上传成功，正在索引...', type: 'success' });
    },
    onError: (error: Error) => {
      setToast({ message: `上传失败: ${error.message}`, type: 'error' });
    },
  });

  const refreshRepoMutation = useMutation({
    mutationFn: async (repoId: number) => {
      const res = await fetch(`${API_BASE}/repos/${repoId}/refresh`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to refresh repository');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setToast({ message: '正在刷新仓库...', type: 'success' });
    },
    onError: (error: Error) => {
      setToast({ message: `刷新失败: ${error.message}`, type: 'error' });
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex flex-col">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex-1 flex flex-col max-w-6xl mx-auto w-full p-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 bg-clip-text text-transparent mb-2">
            CodeLens
          </h1>
          <p className="text-base text-gray-300">代码智能问答平台 - 让代码理解更简单</p>
        </div>

        {/* Tab Card */}
        <div className="bg-slate-800/50 backdrop-blur-xl rounded-xl shadow-2xl border border-slate-700/50 mb-6">
          {/* Tab Headers */}
          <div className="flex border-b border-slate-700/50">
            <button
              onClick={() => setActiveTab('gitlab')}
              className={`flex-1 px-4 py-3 text-sm font-semibold transition-all relative ${
                activeTab === 'gitlab'
                  ? 'text-cyan-400'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {activeTab === 'gitlab' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-400 to-blue-500"></div>
              )}
              <div className="flex items-center justify-center">
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187"/>
                </svg>
                GitLab 接入
              </div>
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex-1 px-4 py-3 text-sm font-semibold transition-all relative ${
                activeTab === 'upload'
                  ? 'text-emerald-400'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {activeTab === 'upload' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-400 to-green-500"></div>
              )}
              <div className="flex items-center justify-center">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                上传代码包
              </div>
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'gitlab' && (
              <div className="space-y-3 max-w-2xl mx-auto">
                <input
                  type="text"
                  placeholder="仓库名称"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  disabled={createRepoMutation.isPending}
                  className="w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 placeholder-gray-500 text-sm"
                />
                <input
                  type="text"
                  placeholder="GitLab URL (例如: https://gitlab.com/user/repo.git)"
                  value={gitlabUrl}
                  onChange={(e) => setGitlabUrl(e.target.value)}
                  disabled={createRepoMutation.isPending}
                  className="w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 placeholder-gray-500 text-sm"
                />
                <input
                  type="password"
                  placeholder="Personal Access Token (可选，私有仓库必填)"
                  value={gitlabToken}
                  onChange={(e) => setGitlabToken(e.target.value)}
                  disabled={createRepoMutation.isPending}
                  className="w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 placeholder-gray-500 text-sm"
                />
                <button
                  onClick={() => {
                    if (repoName && gitlabUrl) {
                      createRepoMutation.mutate({
                        name: repoName,
                        source: 'gitlab',
                        url: gitlabUrl,
                        gitlabToken: gitlabToken || undefined
                      });
                    }
                  }}
                  disabled={createRepoMutation.isPending || !repoName || !gitlabUrl}
                  className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-2 rounded-lg hover:from-cyan-600 hover:to-blue-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed flex items-center justify-center font-semibold shadow-lg hover:shadow-cyan-500/50 transition-all text-sm"
                >
                  {createRepoMutation.isPending ? <LoadingSpinner /> : '接入仓库'}
                </button>
              </div>
            )}

            {activeTab === 'upload' && (
              <div className="max-w-2xl mx-auto">
                <div className="border-2 border-dashed border-slate-600 rounded-lg p-8 text-center hover:border-emerald-500 transition-colors bg-slate-900/30">
                  <input
                    type="file"
                    accept=".zip"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        uploadMutation.mutate(file);
                      }
                    }}
                    disabled={uploadMutation.isPending}
                    className="hidden"
                    id="file-upload"
                  />
                  <label
                    htmlFor="file-upload"
                    className={`cursor-pointer ${uploadMutation.isPending ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <div className="flex flex-col items-center">
                      <svg className="w-16 h-16 text-gray-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <p className="text-base font-semibold text-gray-300 mb-1">
                        {uploadMutation.isPending ? '上传中...' : '点击选择 ZIP 文件'}
                      </p>
                      <p className="text-xs text-gray-500">支持 .zip 格式的代码压缩包</p>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Repos List */}
        <div className="bg-slate-800/50 backdrop-blur-xl rounded-xl shadow-2xl p-6 border border-slate-700/50 flex-1 overflow-auto" style={{ minHeight: '200px' }}>
          <h2 className="text-xl font-bold text-gray-200 mb-4 flex items-center">
            <svg className="w-6 h-6 mr-2 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            仓库列表
          </h2>

          {reposLoading && (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          )}

          {reposError && (
            <div className="bg-red-50 border-l-4 border-red-500 p-6 rounded-lg">
              <div className="flex items-center">
                <svg className="w-6 h-6 text-red-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-red-700 font-medium">加载失败: {(reposError as Error).message}</p>
              </div>
            </div>
          )}

          {repos && repos.length === 0 && (
            <div className="text-center py-8">
              <svg className="w-12 h-12 text-gray-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className="text-gray-400 text-sm">暂无仓库，请先接入或上传代码</p>
            </div>
          )}

          <div className="space-y-3">
            {repos?.map((repo) => (
              <div
                key={repo.id}
                className={`group relative bg-slate-900/50 border border-slate-700 rounded-lg p-4 transition-all ${
                  repo.status === 'ready' ? 'hover:border-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20' : 'cursor-default'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => repo.status === 'ready' && navigate(`/repo/${repo.id}`)}
                  >
                    <div className="flex items-center mb-2">
                      <h3 className="text-base font-semibold text-gray-200 mr-2">{repo.name}</h3>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        repo.source === 'gitlab'
                          ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                          : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      }`}>
                        {repo.source === 'gitlab' ? 'GitLab' : 'ZIP'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className={`flex items-center font-medium ${
                        repo.status === 'ready' ? 'text-green-400' : ''
                      } ${
                        repo.status === 'indexing' ? 'text-blue-400 animate-pulse' : ''
                      } ${
                        repo.status === 'failed' ? 'text-red-400' : ''
                      }`}>
                        {repo.status === 'ready' && (
                          <>
                            <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            就绪
                          </>
                        )}
                        {repo.status === 'indexing' && (
                          <>
                            <svg className="w-4 h-4 mr-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            索引中...
                          </>
                        )}
                        {repo.status === 'failed' && (
                          <>
                            <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                            </svg>
                            失败
                          </>
                        )}
                      </span>
                      <span className="text-gray-500">
                        {new Date(repo.created_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {repo.source === 'gitlab' && repo.status === 'ready' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshRepoMutation.mutate(repo.id);
                        }}
                        disabled={refreshRepoMutation.isPending}
                        className="p-2 rounded-lg bg-slate-800 hover:bg-cyan-500/20 border border-slate-600 hover:border-cyan-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed group/refresh"
                        title="刷新仓库"
                      >
                        <svg
                          className={`w-4 h-4 text-gray-400 group-hover/refresh:text-cyan-400 transition-colors ${refreshRepoMutation.isPending ? 'animate-spin' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    )}
                    {repo.status === 'ready' && (
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Search history management
const SEARCH_HISTORY_KEY = 'codelens_search_history';
const MAX_HISTORY_ITEMS = 10;

function getSearchHistory(): string[] {
  try {
    const history = localStorage.getItem(SEARCH_HISTORY_KEY);
    return history ? JSON.parse(history) : [];
  } catch {
    return [];
  }
}

function addToSearchHistory(query: string) {
  const history = getSearchHistory();
  const filtered = history.filter(q => q !== query);
  const updated = [query, ...filtered].slice(0, MAX_HISTORY_ITEMS);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
}

function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
}

// Highlight search keywords in text
function highlightText(text: string, query: string) {
  if (!query.trim()) {
    return text;
  }

  const parts = text.split(new RegExp(`(${query})`, 'gi'));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={index} className="bg-yellow-200 px-1 rounded">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

function RepoPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const repoId = id || '';
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'search' | 'ask' | 'root-cause'>('search');
  const [result, setResult] = useState<QAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHistory, setSearchHistory] = useState<string[]>(getSearchHistory());
  const [showHistory, setShowHistory] = useState(false);

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

  // Refs for debounce and abort controller
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

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

  const handleSubmit = async () => {
    if (!query) return;

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

    // Add to search history
    addToSearchHistory(query);
    setSearchHistory(getSearchHistory());

    try {
      if (mode === 'search') {
        const res = await fetch(`${API_BASE}/search?repoId=${repoId}&q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        setResult({ query, answer: '', evidence: data.hits });
      } else if (mode === 'ask') {
        const res = await fetch(`${API_BASE}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('问答失败');
        const data = await res.json();
        setResult(data);
      } else if (mode === 'root-cause') {
        const res = await fetch(`${API_BASE}/root-cause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoId: parseInt(repoId), query }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('根因分析失败');
        const data = await res.json();
        setResult({ query, answer: data.rootCause, evidence: data.evidence });
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setError((err as Error).message);
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

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
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <button onClick={() => navigate('/')} className="text-blue-600 hover:underline">
          ← 返回首页
        </button>
      </div>

      <div className="mb-6">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setMode('search')}
            className={`px-4 py-2 rounded ${mode === 'search' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            搜索
          </button>
          <button
            onClick={() => setMode('ask')}
            className={`px-4 py-2 rounded ${mode === 'ask' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            问答
          </button>
          <button
            onClick={() => setMode('root-cause')}
            className={`px-4 py-2 rounded ${mode === 'root-cause' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            根因分析
          </button>
        </div>

        <div className="relative">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={
                mode === 'search'
                  ? '搜索代码...'
                  : mode === 'ask'
                  ? '提问：登录方案是什么？'
                  : '描述 bug：登录一天要登录好几次'
              }
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const newQuery = e.target.value;
                setQuery(newQuery);

                // Clear previous debounce timer
                if (debounceTimerRef.current) {
                  clearTimeout(debounceTimerRef.current);
                }

                // Auto-search with debounce (only for search mode)
                if (mode === 'search' && newQuery.trim()) {
                  debounceTimerRef.current = window.setTimeout(() => {
                    handleSubmit();
                  }, 800); // 800ms debounce for auto-search
                }
              }}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter' && !loading) {
                  // Clear debounce timer on Enter
                  if (debounceTimerRef.current) {
                    clearTimeout(debounceTimerRef.current);
                  }
                  handleSubmit();
                }
              }}
              onFocus={() => setShowHistory(true)}
              onBlur={() => setTimeout(() => setShowHistory(false), 200)}
              disabled={loading}
              className="flex-1 px-4 py-2 border rounded disabled:bg-gray-100"
            />
            <button
              onClick={handleSubmit}
              disabled={loading || !query}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center min-w-[100px]"
            >
              {loading ? <LoadingSpinner /> : '提交'}
            </button>
          </div>

          {/* Search history dropdown */}
          {showHistory && searchHistory.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded shadow-lg z-10 max-h-60 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-50">
                <span className="text-sm text-gray-600">搜索历史</span>
                <button
                  onClick={() => {
                    clearSearchHistory();
                    setSearchHistory([]);
                  }}
                  className="text-xs text-red-600 hover:underline"
                >
                  清空
                </button>
              </div>
              {searchHistory.map((item: string, index: number) => (
                <div
                  key={index}
                  onClick={() => {
                    setQuery(item);
                    setShowHistory(false);
                  }}
                  className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm"
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded text-red-600">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          {result.answer && (
            <div className="border-2 border-blue-200 rounded-xl p-6 bg-gradient-to-br from-blue-50 to-indigo-50">
              <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center">
                <svg className="w-6 h-6 mr-2 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                回答
              </h3>
              <div className="whitespace-pre-wrap text-gray-700 leading-relaxed">{result.answer}</div>

              {/* Historical Feedback Display */}
              {result.historicalFeedback && result.historicalFeedback.length > 0 && (
                <div className="mt-6 pt-6 border-t border-blue-200">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    历史相关反馈
                  </h4>
                  <div className="space-y-3">
                    {result.historicalFeedback.map((item, idx) => (
                      <div key={idx} className="bg-white rounded-lg p-4 border border-gray-200">
                        <p className="text-sm text-gray-600 mb-2">相关问题: {item.query}</p>
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
                <div className="mt-6 pt-6 border-t border-blue-200">
                  {!showFeedbackForm ? (
                    <button
                      onClick={() => setShowFeedbackForm(true)}
                      className="flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                      </svg>
                      添加反馈或补充信息
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-gray-700">
                        您的反馈（例如：功能已废弃、相关议题编号、补充说明等）
                      </label>
                      <textarea
                        value={feedbackText}
                        onChange={(e) => setFeedbackText(e.target.value)}
                        placeholder="例如：这个登录流程已经被废弃，现在使用 OAuth2.0 方式，参见议题 #456"
                        disabled={feedbackSubmitting}
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all disabled:bg-gray-50 resize-none"
                        rows={3}
                      />
                      <div className="flex gap-3">
                        <button
                          onClick={() => handleFeedbackSubmit(true)}
                          disabled={feedbackSubmitting || !feedbackText.trim()}
                          className="flex-1 bg-gradient-to-r from-green-600 to-green-700 text-white py-2 px-4 rounded-xl hover:from-green-700 hover:to-green-800 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed font-medium shadow-lg hover:shadow-xl transition-all"
                        >
                          {feedbackSubmitting ? <LoadingSpinner /> : '✓ 有帮助的补充'}
                        </button>
                        <button
                          onClick={() => handleFeedbackSubmit(false)}
                          disabled={feedbackSubmitting || !feedbackText.trim()}
                          className="flex-1 bg-gradient-to-r from-orange-600 to-orange-700 text-white py-2 px-4 rounded-xl hover:from-orange-700 hover:to-orange-800 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed font-medium shadow-lg hover:shadow-xl transition-all"
                        >
                          {feedbackSubmitting ? <LoadingSpinner /> : '⚠ 需要修正'}
                        </button>
                        <button
                          onClick={() => {
                            setShowFeedbackForm(false);
                            setFeedbackText('');
                          }}
                          disabled={feedbackSubmitting}
                          className="px-4 py-2 border-2 border-gray-300 rounded-xl hover:bg-gray-50 disabled:cursor-not-allowed transition-all"
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

          <div className="border rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">证据 ({filteredEvidence.length} / {result.evidence.length})</h3>

              {/* Filters */}
              <div className="flex gap-3">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-600" />
                  <select
                    value={fileTypeFilter}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setFileTypeFilter(e.target.value)}
                    className="px-3 py-1 border rounded text-sm"
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
                    className="px-3 py-1 border rounded text-sm"
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
              <div className="text-gray-500 text-center py-8">
                {result.evidence.length === 0 ? '未找到相关代码' : '没有符合筛选条件的结果'}
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {paginatedEvidence.map((hit: SearchHit, i: number) => (
                    <div key={hit.id} className="border rounded p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium">
                          [{startIndex + i + 1}] {highlightText(hit.file_path, query)}:{hit.line_start}-{hit.line_end}
                        </div>
                        <div className="flex items-center gap-3">
                          {hit.similarity && (
                            <div className="text-sm text-gray-600">相似度: {(hit.similarity * 100).toFixed(1)}%</div>
                          )}
                          <button
                            onClick={() => navigate(`/repo/${repoId}/call-graph/${encodeURIComponent(hit.symbol_name)}`)}
                            className="text-xs px-3 py-1 bg-purple-600 text-white rounded hover:bg-purple-700"
                          >
                            调用图
                          </button>
                        </div>
                      </div>
                      <div className="text-sm text-gray-600 mb-2">
                        {highlightText(hit.symbol_name, query)} ({hit.symbol_type})
                      </div>
                      <CodeBlock code={hit.code_text} language="typescript" />
                    </div>
                  ))}
                </div>

                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-6">
                    <button
                      onClick={() => setCurrentPage((prev: number) => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 border rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
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
                              className={`px-3 py-1 border rounded ${
                                currentPage === page
                                  ? 'bg-blue-600 text-white'
                                  : 'hover:bg-gray-100'
                              }`}
                            >
                              {page}
                            </button>
                          );
                        } else if (page === currentPage - 2 || page === currentPage + 2) {
                          return <span key={page} className="px-2">...</span>;
                        }
                        return null;
                      })}
                    </div>

                    <button
                      onClick={() => setCurrentPage((prev: number) => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 border rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      下一页
                    </button>

                    <span className="text-sm text-gray-600 ml-2">
                      第 {currentPage} / {totalPages} 页
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CallGraphPage() {
  const navigate = useNavigate();
  const { id, symbolName } = useParams<{ id: string; symbolName: string }>();
  const repoId = id || '';
  const decodedSymbolName = symbolName ? decodeURIComponent(symbolName) : '';

  const handleSymbolClick = useCallback((newSymbolName: string) => {
    navigate(`/repo/${repoId}/call-graph/${encodeURIComponent(newSymbolName)}`);
  }, [navigate, repoId]);

  return (
    <div className="h-screen flex flex-col">
      <div className="p-4 border-b bg-white">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(`/repo/${repoId}`)} className="text-blue-600 hover:underline">
              ← 返回搜索
            </button>
            <div className="text-lg font-semibold">
              调用图: {decodedSymbolName}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1">
        <CallGraph
          repoId={repoId}
          symbolName={decodedSymbolName}
          onSymbolClick={handleSymbolClick}
        />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/repo/:id" element={<RepoPage />} />
      <Route path="/repo/:id/call-graph/:symbolName" element={<CallGraphPage />} />
    </Routes>
  );
}
