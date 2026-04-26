import { useState, useEffect, ChangeEvent, KeyboardEvent, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

const API_BASE = 'http://localhost:8787';

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
  query: string;
  answer: string;
  evidence: SearchHit[];
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
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const { data: repos, isLoading: reposLoading, error: reposError } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/repos`);
      if (!res.ok) throw new Error('Failed to fetch repos');
      return res.json();
    },
    refetchInterval: 3000, // Poll every 3 seconds to update indexing status
  });

  const createRepoMutation = useMutation({
    mutationFn: async (data: { name: string; source: 'gitlab'; url: string }) => {
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

  return (
    <div className="max-w-6xl mx-auto p-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <h1 className="text-3xl font-bold mb-8">CodeLens - 代码智能问答平台</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">GitLab 接入</h2>
          <input
            type="text"
            placeholder="仓库名称"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            disabled={createRepoMutation.isPending}
            className="w-full px-3 py-2 border rounded mb-3 disabled:bg-gray-100"
          />
          <input
            type="text"
            placeholder="GitLab URL"
            value={gitlabUrl}
            onChange={(e) => setGitlabUrl(e.target.value)}
            disabled={createRepoMutation.isPending}
            className="w-full px-3 py-2 border rounded mb-3 disabled:bg-gray-100"
          />
          <button
            onClick={() => {
              if (repoName && gitlabUrl) {
                createRepoMutation.mutate({ name: repoName, source: 'gitlab', url: gitlabUrl });
              }
            }}
            disabled={createRepoMutation.isPending || !repoName || !gitlabUrl}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {createRepoMutation.isPending ? <LoadingSpinner /> : '接入仓库'}
          </button>
        </div>

        <div className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">上传代码包</h2>
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
            className="w-full px-3 py-2 border rounded mb-3 disabled:bg-gray-100"
          />
          <p className="text-sm text-gray-600">
            {uploadMutation.isPending ? '上传中...' : '支持 .zip 格式'}
          </p>
        </div>
      </div>

      <div className="border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">仓库列表</h2>

        {reposLoading && <LoadingSpinner />}

        {reposError && (
          <div className="text-red-600 p-4 bg-red-50 rounded">
            加载失败: {(reposError as Error).message}
          </div>
        )}

        {repos && repos.length === 0 && (
          <div className="text-gray-500 text-center py-8">
            暂无仓库，请先接入或上传代码
          </div>
        )}

        <div className="space-y-3">
          {repos?.map((repo) => (
            <div
              key={repo.id}
              className="flex items-center justify-between p-4 border rounded hover:bg-gray-50 cursor-pointer"
              onClick={() => repo.status === 'ready' && navigate(`/repo/${repo.id}`)}
            >
              <div>
                <div className="font-medium">{repo.name}</div>
                <div className="text-sm text-gray-600 flex items-center gap-2">
                  <span>{repo.source}</span>
                  <span>·</span>
                  <span className={`
                    ${repo.status === 'ready' ? 'text-green-600' : ''}
                    ${repo.status === 'indexing' ? 'text-blue-600 animate-pulse' : ''}
                    ${repo.status === 'failed' ? 'text-red-600' : ''}
                  `}>
                    {repo.status === 'ready' && '✓ 就绪'}
                    {repo.status === 'indexing' && '⏳ 索引中...'}
                    {repo.status === 'failed' && '✗ 失败'}
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-500">
                {new Date(repo.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
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
            <div className="border rounded-lg p-6 bg-blue-50">
              <h3 className="font-semibold mb-2">回答</h3>
              <div className="whitespace-pre-wrap">{result.answer}</div>
            </div>
          )}

          <div className="border rounded-lg p-6">
            <h3 className="font-semibold mb-4">证据 ({result.evidence.length})</h3>
            {result.evidence.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                未找到相关代码
              </div>
            ) : (
              <div className="space-y-4">
                {result.evidence.map((hit: SearchHit, i: number) => (
                  <div key={hit.id} className="border rounded p-4 bg-gray-50">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium">
                        [{i + 1}] {hit.file_path}:{hit.line_start}-{hit.line_end}
                      </div>
                      {hit.similarity && (
                        <div className="text-sm text-gray-600">相似度: {(hit.similarity * 100).toFixed(1)}%</div>
                      )}
                    </div>
                    <div className="text-sm text-gray-600 mb-2">
                      {hit.symbol_name} ({hit.symbol_type})
                    </div>
                    <CodeBlock code={hit.code_text} language="typescript" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/repo/:id" element={<RepoPage />} />
    </Routes>
  );
}
