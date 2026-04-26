import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Routes, Route, Link, useNavigate, useParams } from 'react-router-dom';

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

function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [repoName, setRepoName] = useState('');

  const { data: repos } = useQuery<Repo[]>({
    queryKey: ['repos'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/repos`);
      return res.json();
    },
  });

  const createRepoMutation = useMutation({
    mutationFn: async (data: { name: string; source: 'gitlab'; url: string }) => {
      const res = await fetch(`${API_BASE}/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setGitlabUrl('');
      setRepoName('');
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
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-8">CodeLens - 代码智能问答平台</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">GitLab 接入</h2>
          <input
            type="text"
            placeholder="仓库名称"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            className="w-full px-3 py-2 border rounded mb-3"
          />
          <input
            type="text"
            placeholder="GitLab URL"
            value={gitlabUrl}
            onChange={(e) => setGitlabUrl(e.target.value)}
            className="w-full px-3 py-2 border rounded mb-3"
          />
          <button
            onClick={() => {
              if (repoName && gitlabUrl) {
                createRepoMutation.mutate({ name: repoName, source: 'gitlab', url: gitlabUrl });
              }
            }}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
          >
            接入仓库
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
            className="w-full px-3 py-2 border rounded mb-3"
          />
          <p className="text-sm text-gray-600">支持 .zip 格式</p>
        </div>
      </div>

      <div className="border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">仓库列表</h2>
        <div className="space-y-3">
          {repos?.map((repo) => (
            <div
              key={repo.id}
              className="flex items-center justify-between p-4 border rounded hover:bg-gray-50 cursor-pointer"
              onClick={() => navigate(`/repo/${repo.id}`)}
            >
              <div>
                <div className="font-medium">{repo.name}</div>
                <div className="text-sm text-gray-600">
                  {repo.source} · {repo.status}
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

function RepoPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const repoId = id || '';
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'search' | 'ask' | 'root-cause'>('search');
  const [result, setResult] = useState<QAResponse | null>(null);

  const handleSubmit = async () => {
    if (!query) return;

    if (mode === 'search') {
      const res = await fetch(`${API_BASE}/search?repoId=${repoId}&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setResult({ query, answer: '', evidence: data.hits });
    } else if (mode === 'ask') {
      const res = await fetch(`${API_BASE}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: parseInt(repoId), query }),
      });
      const data = await res.json();
      setResult(data);
    } else if (mode === 'root-cause') {
      const res = await fetch(`${API_BASE}/root-cause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: parseInt(repoId), query }),
      });
      const data = await res.json();
      setResult({ query, answer: data.rootCause, evidence: data.evidence });
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
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            className="flex-1 px-4 py-2 border rounded"
          />
          <button onClick={handleSubmit} className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
            提交
          </button>
        </div>
      </div>

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
            <div className="space-y-4">
              {result.evidence.map((hit, i) => (
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
                  <pre className="bg-white p-3 rounded text-sm overflow-x-auto">
                    <code>{hit.code_text}</code>
                  </pre>
                </div>
              ))}
            </div>
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
