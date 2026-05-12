/**
 * 仓库记录类型定义
 * 用于表示代码仓库的基本信息和状态
 *
 * @property id - 仓库唯一标识符
 * @property name - 仓库名称
 * @property source - 仓库来源类型：'gitlab' 表示从 GitLab 导入，'zip' 表示从压缩包上传
 * @property status - 仓库索引状态：'ready' 已就绪，'indexing' 索引中，'failed' 索引失败
 * @property description - 仓库描述信息（可选）
 */
export type RepoRecord = {
  id: string;
  name: string;
  source: 'gitlab' | 'zip';
  status: 'ready' | 'indexing' | 'failed';
  description?: string;
};

/**
 * 搜索结果命中项类型定义
 * 表示代码搜索返回的单个匹配结果
 *
 * @property file - 文件路径
 * @property symbol - 符号名称（函数名、类名等）
 * @property lineStart - 代码起始行号
 * @property lineEnd - 代码结束行号
 * @property score - 相关性评分（0-1之间，越高越相关）
 * @property evidence - 匹配证据说明，解释为什么这段代码与查询相关
 */
export type SearchHit = {
  file: string;
  symbol: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  evidence: string;
};

/**
 * 索引任务类型定义
 * 表示代码仓库的索引任务信息
 *
 * @property id - 任务唯一标识符
 * @property source - 任务来源类型：'gitlab' 或 'zip'
 * @property target - 目标地址（GitLab 仓库地址或 ZIP 文件路径）
 * @property status - 任务状态：'queued' 排队中，'running' 执行中，'done' 已完成，'failed' 失败
 * @property detail - 任务详细信息描述
 * @property createdAt - 任务创建时间（ISO 8601 格式）
 */
export type IngestionJob = {
  id: string;
  source: 'gitlab' | 'zip';
  target: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  detail: string;
  createdAt: string;
};

/**
 * 问题记录类型定义
 * 存储用户提问和系统回答的历史记录
 *
 * @property id - 问题唯一标识符
 * @property query - 用户提出的问题
 * @property answer - 系统生成的答案
 * @property createdAt - 问题创建时间（ISO 8601 格式）
 */
export type QuestionRecord = {
  id: string;
  query: string;
  answer: string;
  createdAt: string;
};

/**
 * 模拟仓库数据
 * 用于开发和测试环境的示例数据
 */
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

/**
 * 模拟搜索结果数据
 * 展示典型的代码搜索命中结果，包含文件路径、符号信息和相关性评分
 */
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

/**
 * 模拟索引任务数据
 * 展示不同来源（GitLab、ZIP）的索引任务状态
 */
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

/**
 * 模拟问答记录数据
 * 存储历史问答对，用于展示和测试问答功能
 */
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

/**
 * 获取模拟 API 快照
 * 返回所有模拟数据和可用的 API 端点列表
 *
 * @returns 包含所有模拟数据和端点信息的对象
 *
 * 使用场景：
 * - 开发环境快速预览数据结构
 * - 前端开发时的 Mock 数据源
 * - API 文档生成和测试
 */
export function getMockApiSnapshot() {
  return {
    repos,
    searchHits,
    ingestionJobs,
    questions,
    endpoints: ['/health', '/repos', '/jobs', '/search?q=', '/ask?q=', '/root-cause?q=', '/ingest'],
  };
}
