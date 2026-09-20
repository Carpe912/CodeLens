/**
 * 索引队列管理模块
 *
 * 本模块负责管理代码仓库的索引任务队列，使用 BullMQ 和 Redis 实现异步任务处理。
 * 支持五种索引操作：
 * 1. 完整索引（index）：首次索引整个仓库
 * 2. 增量索引（incremental-index）：仅索引变更的文件
 * 3. 刷新索引（refresh）：更新 GitLab 仓库的最新变更
 * 4. 重新索引（reindex）：完全重建仓库索引（清空数据）
 * 5. 断点续跑（resume）：**不清空数据**，只补上次没做完的部分
 *
 * 使用场景：
 * - 新仓库导入时执行完整索引
 * - 代码提交后执行增量索引
 * - 定期刷新远程仓库变更
 * - 索引损坏或需要重建时执行重新索引
 * - 索引失败/中断后，接着做完（优先于 reindex —— 代价与剩余工作量成正比）
 */

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  indexRepository,
  indexMultipleFiles,
  refreshGitLabRepo,
  reindexGitLabRepo,
  resumeRepo,
} from './indexer.js';
import { updateRepoStatus, pool } from '../db/index.js';
import { buildIncrementalReport, saveIncrementalReport } from './incremental-report.js';
import { redactCredentials } from './git-upstream.js';

/**
 * Redis 连接实例
 * 用于 BullMQ 队列的持久化存储和任务状态管理
 * maxRetriesPerRequest 设置为 null 以支持 BullMQ 的阻塞操作
 */
const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null, // BullMQ 需要此配置以支持阻塞命令
});

/**
 * 索引任务队列实例
 * 队列名称：'index-repo'
 * 所有索引相关的任务都通过此队列进行调度和处理
 */
export const indexQueue = new Queue('index-repo', { connection });

/**
 * 完整索引任务数据类型
 * 用于首次索引整个代码仓库
 *
 * @property repoId - 仓库的唯一标识符
 * @property repoName - 仓库名称，用于日志记录
 * @property source - 仓库来源类型：'gitlab' 表示 GitLab 仓库，'zip' 表示上传的压缩包
 * @property url - GitLab 仓库的 URL 地址（source 为 'gitlab' 时必需）
 * @property zipPath - 压缩包文件路径（source 为 'zip' 时必需）
 * @property gitlabToken - GitLab 访问令牌，用于私有仓库认证
 * @property branch - 要索引的分支名称
 * @property baseBranch - 基准分支名称，用于分支对比
 * @property baseRepoId - 基准仓库 ID，用于 fork 仓库的关联
 */
export type IndexJobData = {
  repoId: number;
  repoName: string;
  source: 'gitlab' | 'zip';
  url?: string;
  zipPath?: string;
  gitlabToken?: string;
  branch?: string;
  baseBranch?: string;
  baseRepoId?: number;
};

/**
 * 增量索引任务数据类型
 * 用于仅索引变更的文件，提高索引效率
 *
 * @property repoId - 仓库的唯一标识符
 * @property repoPath - 仓库在本地文件系统的绝对路径
 * @property files - 需要索引的文件列表（相对于仓库根目录的相对路径）
 */
export type IncrementalIndexJobData = {
  repoId: number;
  repoPath: string;
  files: string[]; // 相对路径列表
};

/**
 * 刷新索引任务数据类型
 * 用于从 GitLab 拉取最新变更并更新索引
 *
 * @property repoId - 仓库的唯一标识符
 * @property url - GitLab 仓库的 URL 地址
 * @property gitlabToken - GitLab 访问令牌，用于私有仓库认证
 */
export type RefreshJobData = {
  repoId: number;
  url: string;
  gitlabToken?: string;
};

/**
 * 重新索引任务数据类型
 * 用于完全重建仓库索引，通常在索引损坏或需要更新索引策略时使用
 *
 * @property repoId - 仓库的唯一标识符
 * @property url - GitLab 仓库的 URL 地址
 * @property gitlabToken - GitLab 访问令牌，用于私有仓库认证
 */
export type ReindexJobData = {
  repoId: number;
  url: string;
  gitlabToken?: string;
};

/**
 * 「断点续跑」任务数据。
 *
 * 与 `ReindexJobData` 相比，`url` 是**可选**的：工作区还在时不需要重新克隆，
 * 只有工作区确实丢了才需要 URL。ZIP 源的仓库工作区丢了就只能重传，所以
 * 它的 `url` 为空是合法输入（由 `resumeRepo` 给出明确的报错）。
 */
export type ResumeJobData = {
  repoId: number;
  url?: string;
  gitlabToken?: string;
};

/**
 * 启动索引任务工作进程
 *
 * 创建并启动一个 BullMQ Worker 实例，用于处理队列中的索引任务。
 * Worker 会持续监听队列，自动获取并执行任务。
 *
 * 工作流程：
 * 1. 从队列中获取待处理的任务
 * 2. 根据任务类型（index/incremental-index/refresh/reindex）调用相应的处理函数
 * 3. 任务完成后触发 'completed' 事件
 * 4. 任务失败后触发 'failed' 事件，并更新仓库状态
 *
 * 任务类型说明：
 * - index: 完整索引，索引整个仓库的所有文件
 * - incremental-index: 增量索引，仅索引指定的变更文件
 * - refresh: 刷新索引，从远程拉取最新变更并更新索引
 * - reindex: 重新索引，清除旧索引并重建
 *
 * 配置说明：
 * - lockDuration: 任务锁定时长（1小时），防止任务被重复执行
 * - stalledInterval: 检查停滞任务的间隔（1小时）
 * - maxStalledCount: 停滞任务最大重试次数（1次）
 *
 * @returns Worker 实例，可用于监听事件或停止工作进程
 */
export function startIndexWorker() {
  const worker = new Worker<
    IndexJobData | IncrementalIndexJobData | RefreshJobData | ReindexJobData | ResumeJobData
  >(
    'index-repo', // 队列名称，必须与 indexQueue 的名称一致
    async (job) => {
      console.log(`Processing index job ${job.id}`);

      try {
        // 根据任务名称分发到不同的处理逻辑
        if (job.name === 'index') {
          // 完整索引：索引整个仓库
          const data = job.data as IndexJobData;
          console.log(`Full indexing for repo ${data.repoName}`);
          await indexRepository(data);
        } else if (job.name === 'incremental-index') {
          // 增量索引：仅索引指定的文件列表
          const data = job.data as IncrementalIndexJobData;
          console.log(`Incremental indexing ${data.files.length} files for repo ${data.repoId}`);
          await indexMultipleFiles(data.repoId, data.repoPath, data.files);
        } else if (job.name === 'refresh') {
          // 刷新索引：从 GitLab 拉取最新变更并更新索引
          const data = job.data as RefreshJobData;
          console.log(`Refreshing repo ${data.repoId}`);
          await refreshGitLabRepo(data.repoId, data.url, data.gitlabToken);
        } else if (job.name === 'reindex') {
          // 重新索引：完全重建仓库索引
          const data = job.data as ReindexJobData;
          console.log(`Re-indexing repo ${data.repoId}`);
          await reindexGitLabRepo(data.repoId, data.url, data.gitlabToken);
        } else if (job.name === 'resume') {
          // 断点续跑：不清空数据，只补上次没做完的部分
          const data = job.data as ResumeJobData;
          console.log(`Resuming repo ${data.repoId}`);
          await resumeRepo(data.repoId, data.url, data.gitlabToken);
        }
        console.log(`Index job ${job.id} completed`);
      } catch (error) {
        // 任务执行失败，记录错误并重新抛出以触发 'failed' 事件
        console.error(`Index job ${job.id} failed:`, error);
        throw error;
      }
    },
    {
      connection, // Redis 连接实例
      lockDuration: 3600000, // 任务锁定时长：1小时（3600000毫秒），防止长时间运行的任务被误判为停滞
      stalledInterval: 3600000, // 停滞检查间隔：每小时检查一次是否有停滞的任务
      maxStalledCount: 1, // 停滞重试次数：仅重试1次，避免无限重试导致资源浪费
    }
  );

  /**
   * 任务完成事件监听器
   * 当任务成功完成时触发，记录完成日志
   */
  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  /**
   * 任务失败事件监听器
   * 当任务执行失败时触发，执行以下操作：
   * 1. 记录失败日志和错误信息
   * 2. 把仓库状态从 'indexing' 里救出来
   *
   * ⚠️ **为什么必须在这里救状态**（原实现只处理 `index`）
   * `/refresh` 与 `/reindex` 这两条路由在**入队前**就把 `repos.status` 改成了
   * `'indexing'`。如果任务随后失败而这里不管，状态就会**永久停在 indexing**：
   * UI 一直转圈、前端拦住所有刷新操作、连删除仓库都会被拒。
   * 任务失败是暂时的，「状态被卡住」是永久的 —— 后者才是真正难查的那个。
   *
   * 恢复到什么状态取决于**索引还在不在**：
   * - `refresh` 失败 → 旧索引完好无损，恢复成 `'ready'`，并把失败原因写进
   *   `last_incremental`（用 note 承载）让界面显示得出来；
   * - `reindex` 失败 → 路由已经先 `clearRepoData` 清空了索引，此时报 `'ready'` 是**撒谎**，
   *   必须报 `'failed'`；
   * - `index`（首次全量）失败 → 同理 `'failed'`；
   * - `resume` 失败 → 数据**没有被清空**（只可能更完整了一些），但整仓依然不完整，
   *   所以同样报 `'failed'`。区别在于这个 `failed` 是**可低成本恢复的**：
   *   再点一次续跑即可，不会重做已完成的部分。
   *
   * `incremental-index` 不改仓库状态，所以不需要处理。
   */
  worker.on('failed', async (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);

    if (!job) return;

    if (job.name === 'index' || job.name === 'reindex' || job.name === 'resume') {
      const data = job.data as IndexJobData | ReindexJobData | ResumeJobData;
      try {
        await updateRepoStatus(data.repoId, 'failed');
        console.log(`Updated repo ${data.repoId} status to 'failed'`);
      } catch (updateError) {
        console.error(`Failed to update repo status:`, updateError);
      }
      return;
    }

    if (job.name === 'refresh') {
      const data = job.data as RefreshJobData;
      try {
        // 旧索引仍然可用 ⇒ 状态回 'ready'（不是 'failed'），
        // 但失败这件事必须留下痕迹，否则用户只会看到「点了没反应」。
        // 错误信息过一遍脱敏：git 的 stderr 里可能带着 remote URL 的 token。
        await saveIncrementalReport(
          pool,
          data.repoId,
          buildIncrementalReport({
            mode: 'incremental',
            note: `刷新失败：${redactCredentials(String(err?.message ?? err))}`,
          })
        );
        await updateRepoStatus(data.repoId, 'ready');
        console.log(`Repo ${data.repoId} refresh failed; status restored to 'ready' with a note`);
      } catch (updateError) {
        console.error(`Failed to restore repo status:`, updateError);
      }
    }
  });

  return worker;
}

/**
 * 将完整索引任务加入队列
 *
 * 用于首次索引整个代码仓库，会索引仓库中的所有文件。
 * 任务会被添加到 'index-repo' 队列中，由 Worker 异步处理。
 *
 * 使用场景：
 * - 用户首次导入新仓库
 * - 从 GitLab 克隆新仓库
 * - 上传 ZIP 压缩包创建新仓库
 *
 * @param data - 完整索引任务数据，包含仓库信息和来源
 * @returns 返回任务 ID，可用于查询任务状态
 */
export async function enqueueIndexJob(data: IndexJobData) {
  const job = await indexQueue.add('index', data);
  return job.id;
}

/**
 * 将增量索引任务加入队列
 *
 * 仅索引指定的文件列表，适用于代码变更后的快速索引。
 * 相比完整索引，增量索引速度更快，资源消耗更少。
 *
 * 使用场景：
 * - Git 提交后索引变更的文件
 * - 用户编辑文件后的实时索引
 * - Webhook 触发的增量更新
 *
 * @param data - 增量索引任务数据，包含仓库路径和文件列表
 * @returns 返回任务 ID，可用于查询任务状态
 */
export async function enqueueIncrementalIndexJob(data: IncrementalIndexJobData) {
  const job = await indexQueue.add('incremental-index', data);
  return job.id;
}

/**
 * 将刷新索引任务加入队列
 *
 * 从 GitLab 远程仓库拉取最新变更，并更新本地索引。
 * 会执行 git pull 操作，然后索引新增或修改的文件。
 *
 * 使用场景：
 * - 定期同步远程仓库的最新代码
 * - 用户手动触发仓库刷新
 * - 检测到远程仓库有新提交时自动刷新
 *
 * @param data - 刷新任务数据，包含仓库 ID、URL 和访问令牌
 * @returns 返回任务 ID，可用于查询任务状态
 */
export async function enqueueRefreshJob(data: RefreshJobData) {
  const job = await indexQueue.add('refresh', data);
  return job.id;
}

/**
 * 将重新索引任务加入队列
 *
 * 完全重建仓库索引，会清除旧的索引数据并重新索引所有文件。
 * 这是一个重量级操作，通常在索引损坏或需要更新索引策略时使用。
 *
 * 使用场景：
 * - 索引数据损坏或不一致
 * - 升级索引算法或策略
 * - 修复索引错误
 * - 用户手动请求重建索引
 *
 * @param data - 重新索引任务数据，包含仓库 ID、URL 和访问令牌
 * @returns 返回任务 ID，可用于查询任务状态
 */
export async function enqueueReindexJob(data: ReindexJobData) {
  const job = await indexQueue.add('reindex', data);
  return job.id;
}

/**
 * 将「断点续跑」任务加入队列
 *
 * 不删除任何已有索引数据，只把**上次没做完的部分**补完：
 * - 第一遍按「已登记且有代码块」跳过；
 * - 第二遍只处理 `files.entities_indexed_at IS NULL` 的文件。
 *
 * 与 reindex 的区别：reindex 是「推平重来」，resume 是「接着做」。
 * 索引失败后应该先试 resume —— 它的代价与「没做完的工作量」成正比，
 * 而不是与仓库大小成正比。
 *
 * 使用场景：
 * - 上次索引任务失败/被中断，想接着做完
 * - 第二遍（实体层）部分文件失败，想只补那批文件
 * - 不重新花钱生成已经生成好的向量
 *
 * @param data - 续跑任务数据，包含仓库 ID（URL 只在工作区丢失时才需要）
 * @returns 返回任务 ID，可用于查询任务状态
 */
export async function enqueueResumeJob(data: ResumeJobData) {
  const job = await indexQueue.add('resume', data);
  return job.id;
}
