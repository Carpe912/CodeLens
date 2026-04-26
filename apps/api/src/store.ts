import type { RepoRecord, SearchHit } from './index.js';

export type IngestionJob = {
  id: string;
  source: 'gitlab' | 'zip';
  target: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  detail: string;
  createdAt: string;
};

export type QuestionRecord = {
  id: string;
  query: string;
  answer: string;
  createdAt: string;
};

export const repos: RepoRecord[] = [
  {
    id: 'repo_1',
    name: 'auth-portal',
    source: 'gitlab',
    status: 'ready',
    description: '登录、刷新 token、权限控制相关代码库。',
  },
  {
    id: 'repo_2',
    name: 'order-console',
    source: 'zip',
    status: 'indexing',
    description: '上传的 ZIP 包，正在构建 AST 索引。',
  },
];

export const searchHits: SearchHit[] = [
  {
    file: 'src/router/guards/auth.ts',
    symbol: 'beforeEach',
    lineStart: 12,
    lineEnd: 46,
    score: 0.97,
    evidence: '路由守卫在未登录时重定向到登录页，并在 token 失效时触发刷新流程。',
  },
  {
    file: 'src/api/http.ts',
    symbol: 'requestInterceptor',
    lineStart: 18,
    lineEnd: 64,
    score: 0.93,
    evidence: '请求拦截器会附加 access token，并在 401 时统一走 refresh token 逻辑。',
  },
  {
    file: 'src/views/login/index.vue',
    symbol: 'handleSubmit',
    lineStart: 31,
    lineEnd: 88,
    score: 0.89,
    evidence: '登录页提交后先刷新用户信息，再同步权限路由。',
  },
];

export const ingestionJobs: IngestionJob[] = [
  {
    id: 'job_1',
    source: 'gitlab',
    target: 'git@gitlab.example.com:team/auth-portal.git',
    status: 'running',
    detail: '正在拉取默认分支并执行 AST 切块。',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'job_2',
    source: 'zip',
    target: 'uploaded/order-console.zip',
    status: 'done',
    detail: '已完成解压、解析与索引。',
    createdAt: new Date().toISOString(),
  },
];

export const questions: QuestionRecord[] = [
  {
    id: 'q_1',
    query: '登录为什么会重复跳转',
    answer: '优先检查路由守卫、401 清理态、refresh token 与并发请求。',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'q_2',
    query: '首页数据流怎么走',
    answer: '从路由进入后，会经过请求拦截器、接口聚合层和状态管理。',
    createdAt: new Date().toISOString(),
  },
];

export function getMockApiSnapshot() {
  return {
    repos,
    searchHits,
    ingestionJobs,
    questions,
    endpoints: ['/health', '/repos', '/jobs', '/search?q=', '/ask?q=', '/root-cause?q=', '/ingest'],
  };
}
