import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Repo, IndexProgress } from '../types';
import { API_BASE } from '../utils/constants';
import { Toast } from '../components/common/Toast';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ProgressBar } from '../components/common/ProgressBar';

export function HomePage() {
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

  const reindexRepoMutation = useMutation({
    mutationFn: async (repoId: number) => {
      const res = await fetch(`${API_BASE}/repos/${repoId}/reindex`, {
        method: 'POST',
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to reindex repository');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setToast({ message: '正在重新索引仓库...', type: 'success' });
    },
    onError: (error: Error) => {
      setToast({ message: `重新索引失败: ${error.message}`, type: 'error' });
    },
  });

  const deleteRepoMutation = useMutation({
    mutationFn: async (repoId: number) => {
      const res = await fetch(`${API_BASE}/repos/${repoId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete repository');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos'] });
      setToast({ message: '仓库已删除', type: 'success' });
    },
    onError: (error: Error) => {
      setToast({ message: `删除失败: ${error.message}`, type: 'error' });
    },
  });

  const { data: progressData } = useQuery({
    queryKey: ['progress', repos?.filter(r => r.status === 'indexing').map(r => r.id)],
    queryFn: async () => {
      const indexingRepos = repos?.filter(r => r.status === 'indexing') || [];
      if (indexingRepos.length === 0) return {};

      const progressMap: Record<number, IndexProgress> = {};
      await Promise.all(
        indexingRepos.map(async (repo) => {
          try {
            const res = await fetch(`${API_BASE}/repos/${repo.id}/progress`);
            if (res.ok) {
              const data = await res.json();
              if (data.progress) {
                progressMap[repo.id] = data.progress;
              }
            }
          } catch (error) {
            console.error(`Failed to fetch progress for repo ${repo.id}:`, error);
          }
        })
      );
      return progressMap;
    },
    enabled: repos?.some(r => r.status === 'indexing'),
    refetchInterval: 3000,
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex flex-col">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex-1 flex flex-col max-w-6xl mx-auto w-full p-6">
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 bg-clip-text text-transparent mb-2">
            CodeLens
          </h1>
          <p className="text-base text-gray-300">代码智能问答平台 - 让代码理解更简单</p>
        </div>

        <div className="bg-slate-800/50 backdrop-blur-xl rounded-xl shadow-2xl border border-slate-700/50 mb-6">
          <div className="flex border-b border-slate-700/50">
            <button
              onClick={() => setActiveTab('gitlab')}
              className={`flex-1 px-4 py-3 text-sm font-semibold transition-all relative ${
                activeTab === 'gitlab' ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-300'
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
                activeTab === 'upload' ? 'text-emerald-400' : 'text-gray-400 hover:text-gray-300'
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
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('确定要重新索引此仓库吗？这将清空所有现有数据并重新开始索引。')) {
                              reindexRepoMutation.mutate(repo.id);
                            }
                          }}
                          disabled={reindexRepoMutation.isPending}
                          className="p-2 rounded-lg bg-slate-800 hover:bg-purple-500/20 border border-slate-600 hover:border-purple-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed group/reindex"
                          title="重新索引"
                        >
                          <svg
                            className="w-4 h-4 text-gray-400 group-hover/reindex:text-purple-400 transition-colors"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 12v9" />
                          </svg>
                        </button>
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
                      </>
                    )}
                    {repo.status === 'ready' && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`确定要删除仓库"${repo.name}"吗？此操作不可恢复。`)) {
                              deleteRepoMutation.mutate(repo.id);
                            }
                          }}
                          disabled={deleteRepoMutation.isPending}
                          className="p-2 rounded-lg bg-slate-800 hover:bg-red-500/20 border border-slate-600 hover:border-red-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed group/delete"
                          title="删除仓库"
                        >
                          <svg
                            className="w-4 h-4 text-gray-400 group-hover/delete:text-red-400 transition-colors"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                {repo.status === 'indexing' && progressData?.[repo.id] && (
                  <ProgressBar progress={progressData[repo.id]} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
