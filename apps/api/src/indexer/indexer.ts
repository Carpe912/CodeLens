/**
 * 代码索引器模块
 *
 * 功能概述：
 * 1. 从 GitLab 或 ZIP 文件中获取代码仓库
 * 2. 解析代码文件，提取代码块（函数、类、方法等）
 * 3. 生成代码块的向量嵌入（embeddings）用于语义搜索
 * 4. 将解析结果存储到数据库中
 * 5. 支持增量索引和全量重建索引
 * 6. 支持 AST（抽象语法树）增强索引
 *
 * 核心流程：
 * 代码仓库 -> 文件收集 -> 代码解析 -> 向量化 -> 数据库存储
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { insertFile, insertCodeChunk, updateRepoStatus, getFileByPath, updateFile, deleteFileChunks, deleteFile, updateIndexProgress, pool } from '../db/index.js';
import { batchGenerateEmbeddings } from '../llm/embeddings.js';
import type { IndexJobData } from './queue.js';
import { EnhancedIndexer } from './enhanced-indexer.js';

// 将 exec 转换为 Promise 形式，便于使用 async/await
const execAsync = promisify(exec);

/**
 * 索引代码仓库的主入口函数
 *
 * 功能：根据不同的数据源（GitLab 或 ZIP 文件）获取代码仓库，然后进行完整索引
 *
 * @param jobData - 索引任务数据
 * @param jobData.repoId - 仓库 ID
 * @param jobData.source - 数据源类型：'gitlab' 或 'zip'
 * @param jobData.url - GitLab 仓库 URL（当 source 为 'gitlab' 时必需）
 * @param jobData.zipPath - ZIP 文件路径（当 source 为 'zip' 时必需）
 * @param jobData.gitlabToken - GitLab 访问令牌（可选，用于私有仓库）
 *
 * @throws {Error} 当 jobData 无效时抛出错误
 *
 * 执行流程：
 * 1. 根据数据源类型获取代码仓库到本地
 * 2. 执行完整的代码库索引
 * 3. 更新仓库状态为 'ready'（就绪）
 */
export async function indexRepository(jobData: IndexJobData) {
  const { repoId, source, url, zipPath, gitlabToken } = jobData;

  let repoPath: string;

  // 根据数据源类型获取代码仓库
  if (source === 'gitlab' && url) {
    // 从 GitLab 克隆仓库
    repoPath = await cloneGitLabRepo(url, repoId, gitlabToken);
  } else if (source === 'zip' && zipPath) {
    // 从 ZIP 文件解压仓库
    repoPath = await extractZip(zipPath, repoId);
  } else {
    throw new Error('Invalid job data');
  }

  // 执行完整索引
  await indexCodebase(repoId, repoPath);
  // 更新仓库状态为就绪
  await updateRepoStatus(repoId, 'ready');
}

/**
 * 从 GitLab 克隆代码仓库到本地
 *
 * 功能：使用 git clone 命令将 GitLab 仓库克隆到本地临时目录
 *
 * @param url - GitLab 仓库的 URL（支持 HTTP 和 HTTPS）
 * @param repoId - 仓库 ID，用于生成唯一的本地目录
 * @param gitlabToken - GitLab 访问令牌（可选）
 *                      - 用于访问私有仓库
 *                      - 会自动注入到 URL 中进行 OAuth2 认证
 *
 * @returns 返回克隆后的本地仓库路径
 *
 * 认证机制：
 * - 如果提供了 token，会将 URL 转换为 https://oauth2:TOKEN@gitlab.com/... 格式
 * - 自动将 http:// 转换为 https://（因为许多 GitLab 服务器禁用 HTTP 认证）
 * - 使用 OAuth2 协议进行身份验证
 *
 * 存储位置：
 * - 所有仓库统一存储在 /tmp/codelens-repos/{repoId} 目录下
 */
export async function cloneGitLabRepo(url: string, repoId: number, gitlabToken?: string): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;

  // 如果提供了 token，将其注入到 URL 中用于身份验证
  let cloneUrl = url;
  if (gitlabToken) {
    // 始终使用 HTTPS 进行身份验证（许多 GitLab 服务器禁用 HTTP 认证）
    // 如果需要，将 http:// 转换为 https://
    let httpsUrl = url;
    if (url.startsWith('http://')) {
      httpsUrl = url.replace('http://', 'https://');
    }

    // 将 token 注入到 URL 中，格式：https://oauth2:TOKEN@gitlab.com/...
    if (httpsUrl.startsWith('https://')) {
      cloneUrl = httpsUrl.replace('https://', `https://oauth2:${gitlabToken}@`);
    }
  }

  // 执行 git clone 命令
  await execAsync(`git clone ${cloneUrl} ${targetDir}`);
  return targetDir;
}

/**
 * 从 ZIP 文件解压代码仓库
 *
 * 功能：使用 unzip 命令将 ZIP 压缩包解压到本地临时目录
 *
 * @param zipPath - ZIP 文件的完整路径
 * @param repoId - 仓库 ID，用于生成唯一的解压目录
 *
 * @returns 返回解压后的本地仓库路径
 *
 * 命令说明：
 * - unzip -q：静默模式，不显示解压过程信息
 * - -d：指定解压目标目录
 */
async function extractZip(zipPath: string, repoId: number): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;
  await execAsync(`unzip -q ${zipPath} -d ${targetDir}`);
  return targetDir;
}

/**
 * 索引整个代码库的核心函数
 *
 * 功能：遍历代码库中的所有文件，解析代码结构，生成向量嵌入，并存储到数据库
 *
 * @param repoId - 仓库 ID
 * @param repoPath - 仓库在本地文件系统的路径
 *
 * 核心流程：
 * 1. 收集所有需要索引的代码文件
 * 2. 检查已索引的文件（支持断点续传）
 * 3. 批量处理文件，避免内存溢出
 * 4. 对每个文件：解析代码 -> 生成嵌入 -> 存储到数据库
 * 5. 执行增强索引（AST 分析）
 *
 * 性能优化：
 * - 批量处理：每批 10 个文件
 * - 断点续传：跳过已索引的文件
 * - 内存管理：批次间强制垃圾回收和延迟
 * - 进度追踪：实时更新索引进度
 *
 * 索引阶段：
 * 1. 基础索引：解析代码块，生成向量嵌入
 * 2. 增强索引：使用 AI 进行 AST 分析，提取更深层的代码结构信息
 */
async function indexCodebase(repoId: number, repoPath: string) {
  // 收集所有需要索引的文件
  const files = await collectFiles(repoPath);
  console.log(`Full indexing ${files.length} files for repo ${repoId}`);

  // 检查哪些文件已经被索引（用于断点续传功能）
  const indexedFilesResult = await pool.query(
    'SELECT path FROM files WHERE repo_id = $1',
    [repoId]
  );
  const indexedPaths = new Set(indexedFilesResult.rows.map((row: any) => row.path));

  // 过滤掉已经索引的文件
  const filesToProcess = files.filter(filePath => {
    const relativePath = filePath.replace(repoPath, '').replace(/^\//, '');
    return !indexedPaths.has(relativePath);
  });

  const alreadyIndexed = files.length - filesToProcess.length;
  console.log(`Found ${alreadyIndexed} already indexed files, processing ${filesToProcess.length} remaining files`);

  // 初始化进度 - 显示时总是从 0 开始
  // 但内部会跟踪实际处理的文件数量以支持断点续传
  await updateIndexProgress(repoId, files.length, 0, new Date());

  // 批量处理文件以避免内存问题
  const BATCH_SIZE = 10; // 每批处理 10 个文件
  let processedCount = 0; // 从 0 开始用于进度显示

  // 分批处理文件
  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filesToProcess.length / BATCH_SIZE)} (${batch.length} files)`);

    // 处理当前批次的每个文件
    for (const filePath of batch) {
      try {
        // 读取文件内容
        const content = await readFile(filePath, 'utf-8');
        // 解析文件，提取代码块（函数、类、方法等）
        const parseResult = parseFile(filePath, content);

        // 如果解析失败或没有代码块，跳过该文件
        if (!parseResult || parseResult.chunks.length === 0) {
          processedCount++;
          continue;
        }

        // 存储相对路径而不是绝对路径（便于跨环境迁移）
        const relativePath = filePath.replace(repoPath, '').replace(/^\//, '');
        // 将文件信息插入数据库
        const fileId = await insertFile(repoId, relativePath, parseResult.language, content);

        // 为每个代码块生成文本描述（用于生成向量嵌入）
        // 格式：符号名称 符号类型\n代码内容
        const texts = parseResult.chunks.map((chunk) => {
          return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
        });

        // 批量生成向量嵌入（用于语义搜索）
        const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

        // 将每个代码块及其嵌入存储到数据库
        for (let i = 0; i < parseResult.chunks.length; i++) {
          const chunk = parseResult.chunks[i];
          const embedding = embeddings[i] || undefined;

          await insertCodeChunk(
            fileId,
            chunk.symbolName,
            chunk.symbolType,
            chunk.lineStart,
            chunk.lineEnd,
            chunk.code,
            embedding
          );
        }

        console.log(`Indexed ${relativePath} with ${parseResult.chunks.length} chunks`);
        processedCount++;

        // 更新进度：加上已索引的文件数以显示总进度
        await updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount);
      } catch (error) {
        console.error(`Failed to index ${filePath}:`, error);
        processedCount++;
        // 即使失败也更新进度
        await updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount);
      }
    }

    // 如果可用，在批次之间强制执行垃圾回收
    if (global.gc) {
      global.gc();
    }

    // 在批次之间添加延迟以允许内存清理
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`Full indexing completed for ${files.length} files`);

  // 运行增强索引以提取 AST 信息
  console.log('Starting enhanced indexing (AST analysis)...');
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.warn('⚠ ANTHROPIC_API_KEY not found, skipping enhanced indexing');
  } else {
    const enhancedIndexer = new EnhancedIndexer(pool, anthropicApiKey);

    // 更新进度以指示增强索引阶段
    await pool.query(
      `UPDATE repos
       SET index_progress = jsonb_set(
         index_progress,
         '{phase}',
         '"enhanced"'
       )
       WHERE id = $1`,
      [repoId]
    );

    // 执行增强索引（使用 AI 进行深度代码分析）
    await enhancedIndexer.reindexRepository(repoId, repoPath, {
      onProgress: async (progress) => {
        // 更新增强索引的进度信息
        await pool.query(
          `UPDATE repos
           SET index_progress = jsonb_set(
             jsonb_set(
               index_progress,
               '{enhancedProcessed}',
               $1::text::jsonb
             ),
             '{enhancedTotal}',
             $2::text::jsonb
           )
           WHERE id = $3`,
          [progress.processedFiles, progress.totalFiles, repoId]
        );
      }
    });

    console.log('Enhanced indexing completed');
  }
}

/**
 * 收集目录中所有需要索引的代码文件
 *
 * 功能：递归遍历目录，收集所有支持的代码文件路径
 *
 * @param dir - 要扫描的根目录路径
 *
 * @returns 返回所有符合条件的文件路径数组
 *
 * 支持的文件类型：
 * - TypeScript: .ts, .tsx
 * - JavaScript: .js, .jsx
 * - Vue: .vue
 *
 * 跳过的目录（性能优化）：
 * - 依赖目录：node_modules, vendor
 * - 构建输出：dist, build, out, target
 * - 版本控制：.git
 * - 缓存目录：.cache, .turbo, .next, .nuxt, .output, .vercel
 * - 测试覆盖率：coverage, .pytest_cache, __pycache__
 *
 * 算法：深度优先搜索（DFS）
 */
async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  /**
   * 递归遍历目录的内部函数
   * @param currentPath - 当前正在遍历的目录路径
   */
  async function walk(currentPath: string) {
    const entries = await readdir(currentPath);

    for (const entry of entries) {
      // 跳过常见的构建/依赖/缓存目录
      const skipDirs = [
        'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
        '.cache', '.turbo', '.nuxt', '.output', 'out', '.vercel',
        'vendor', 'target', '__pycache__', '.pytest_cache'
      ];

      // 如果是需要跳过的目录，直接继续下一个
      if (skipDirs.includes(entry)) {
        continue;
      }

      const fullPath = join(currentPath, entry);
      const stats = await stat(fullPath);

      if (stats.isDirectory()) {
        // 如果是目录，递归遍历
        await walk(fullPath);
      } else if (stats.isFile()) {
        // 如果是文件，检查是否是支持的代码文件类型
        if (fullPath.match(/\.(ts|tsx|js|jsx|vue)$/)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * 增量索引：更新单个文件
 *
 * 功能：当单个文件发生变化时，更新其在数据库中的索引信息
 *
 * @param repoId - 仓库 ID
 * @param repoPath - 仓库在本地文件系统的路径
 * @param relativePath - 文件的相对路径（相对于仓库根目录）
 *
 * 处理场景：
 * 1. 文件已存在且内容未变：跳过处理
 * 2. 文件已存在且内容已变：删除旧的代码块，重新解析并插入新的代码块
 * 3. 文件是新文件：解析并插入到数据库
 * 4. 文件已被删除：从数据库中删除该文件及其所有代码块
 *
 * 优化策略：
 * - 内容比对：通过比较文件内容避免不必要的重新索引
 * - 原子更新：先删除旧数据，再插入新数据，保证数据一致性
 *
 * 使用场景：
 * - Git 仓库的增量更新
 * - 文件监听触发的实时索引
 * - 手动触发的单文件重新索引
 */
export async function indexSingleFile(repoId: number, repoPath: string, relativePath: string) {
  const fullPath = join(repoPath, relativePath);

  try {
    // 检查文件是否存在
    const stats = await stat(fullPath);
    if (!stats.isFile()) {
      throw new Error('Not a file');
    }

    // 读取文件内容
    const content = await readFile(fullPath, 'utf-8');
    // 解析文件
    const parseResult = parseFile(fullPath, content);

    // 检查文件是否已经存在于数据库中
    const existingFile = await getFileByPath(repoId, relativePath);

    if (existingFile) {
      // 文件已存在 - 更新它
      if (existingFile.content === content) {
        // 内容未变，跳过处理
        console.log(`File ${relativePath} unchanged, skipping`);
        return;
      }

      console.log(`Updating file ${relativePath}`);

      // 删除旧的代码块
      await deleteFileChunks(existingFile.id);

      if (!parseResult || parseResult.chunks.length === 0) {
        // 文件不再包含可解析的代码，只更新内容
        await updateFile(existingFile.id, content, parseResult?.language || 'unknown');
        return;
      }

      // 更新文件内容
      await updateFile(existingFile.id, content, parseResult.language);

      // 插入新的代码块
      const texts = parseResult.chunks.map((chunk) => {
        return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
      });

      // 生成向量嵌入
      const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

      // 插入所有代码块
      for (let i = 0; i < parseResult.chunks.length; i++) {
        const chunk = parseResult.chunks[i];
        const embedding = embeddings[i] || undefined;

        await insertCodeChunk(
          existingFile.id,
          chunk.symbolName,
          chunk.symbolType,
          chunk.lineStart,
          chunk.lineEnd,
          chunk.code,
          embedding
        );
      }

      console.log(`Updated ${relativePath} with ${parseResult.chunks.length} chunks`);
    } else {
      // 新文件 - 插入它
      console.log(`Indexing new file ${relativePath}`);

      if (!parseResult || parseResult.chunks.length === 0) {
        // 文件没有可解析的代码，跳过它
        return;
      }

      // 插入文件记录
      const fileId = await insertFile(repoId, relativePath, parseResult.language, content);

      // 生成代码块的文本描述
      const texts = parseResult.chunks.map((chunk) => {
        return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
      });

      // 生成向量嵌入
      const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

      // 插入所有代码块
      for (let i = 0; i < parseResult.chunks.length; i++) {
        const chunk = parseResult.chunks[i];
        const embedding = embeddings[i] || undefined;

        await insertCodeChunk(
          fileId,
          chunk.symbolName,
          chunk.symbolType,
          chunk.lineStart,
          chunk.lineEnd,
          chunk.code,
          embedding
        );
      }

      console.log(`Indexed new file ${relativePath} with ${parseResult.chunks.length} chunks`);
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // 文件已被删除
      const existingFile = await getFileByPath(repoId, relativePath);
      if (existingFile) {
        console.log(`Deleting file ${relativePath}`);
        // 从数据库中删除文件（会级联删除所有相关的代码块）
        await deleteFile(existingFile.id);
      }
    } else {
      console.error(`Failed to index ${relativePath}:`, error);
      throw error;
    }
  }
}

/**
 * 增量索引：批量更新多个文件
 *
 * 功能：当多个文件发生变化时，批量更新它们的索引信息
 *
 * @param repoId - 仓库 ID
 * @param repoPath - 仓库在本地文件系统的路径
 * @param relativePaths - 文件的相对路径数组
 *
 * 使用场景：
 * - Git pull 后更新变更的文件
 * - 批量文件修改后的索引更新
 * - 定时任务触发的批量更新
 *
 * 实现方式：
 * - 顺序处理每个文件（调用 indexSingleFile）
 * - 每个文件独立处理，单个文件失败不影响其他文件
 */
export async function indexMultipleFiles(repoId: number, repoPath: string, relativePaths: string[]) {
  console.log(`Incremental indexing ${relativePaths.length} files for repo ${repoId}`);

  // 逐个处理每个文件
  for (const relativePath of relativePaths) {
    await indexSingleFile(repoId, repoPath, relativePath);
  }

  console.log(`Incremental indexing completed for ${relativePaths.length} files`);
}

/**
 * 重新索引 GitLab 仓库：删除本地副本，重新克隆，并执行完整索引
 *
 * 功能：完全重建仓库的索引，适用于需要从头开始索引的场景
 *
 * @param repoId - 仓库 ID
 * @param url - GitLab 仓库的 URL
 * @param gitlabToken - GitLab 访问令牌（可选）
 *
 * @returns 返回包含更新信息的对象
 *
 * 执行流程：
 * 1. 删除本地已存在的仓库目录（如果存在）
 * 2. 从 GitLab 重新克隆仓库
 * 3. 执行完整的代码库索引（indexCodebase 会自动处理数据库中的旧数据）
 * 4. 更新仓库状态为 'ready'
 *
 * 使用场景：
 * - 索引数据损坏需要重建
 * - 仓库结构发生重大变化
 * - 手动触发的完整重新索引
 * - 本地仓库文件损坏或丢失
 *
 * 注意事项：
 * - 这是一个破坏性操作，会删除本地仓库目录
 * - 会重新索引所有文件，耗时较长
 * - 数据库中的旧索引数据会被保留（支持断点续传）
 */
export async function reindexGitLabRepo(repoId: number, url: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  // 如果存在，删除现有的仓库目录
  try {
    await execAsync(`rm -rf ${repoPath}`);
    console.log(`Deleted existing repository directory for repo ${repoId}`);
  } catch (error) {
    console.log(`No existing directory to delete for repo ${repoId}`);
  }

  // 克隆仓库
  console.log(`Cloning repository for full reindex: ${url}`);
  await cloneGitLabRepo(url, repoId, gitlabToken);

  // 执行完整索引（indexCodebase 会从 0 开始处理进度）
  await indexCodebase(repoId, repoPath);
  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: 'full-reindex' };
}

/**
 * 刷新 GitLab 仓库：拉取最新变更并索引修改的文件
 *
 * 功能：增量更新仓库索引，只处理发生变化的文件
 *
 * @param repoId - 仓库 ID
 * @param url - GitLab 仓库的 URL
 * @param gitlabToken - GitLab 访问令牌（可选）
 *
 * @returns 返回包含更新文件数量的对象
 *
 * 执行流程：
 * 1. 检查本地仓库目录是否存在
 *    - 不存在：克隆仓库并执行完整索引
 *    - 存在：继续下一步
 * 2. 执行 git pull 拉取最新变更
 * 3. 使用 git diff 获取变更的文件列表
 * 4. 只对变更的文件执行增量索引
 * 5. 更新仓库状态为 'ready'
 *
 * 使用场景：
 * - 定时同步 GitLab 仓库的最新代码
 * - Webhook 触发的自动更新
 * - 手动触发的增量更新
 * - 日常开发中的快速索引更新
 *
 * 性能优化：
 * - 只索引变更的文件，大幅提升更新速度
 * - 使用 git diff 精确识别变更文件
 * - 支持首次克隆时自动切换到完整索引
 *
 * 特殊处理：
 * - 首次克隆（HEAD@{1} 不存在）：自动执行完整索引
 * - 无变更文件：直接返回，不执行索引操作
 * - 只处理支持的代码文件类型（.ts, .tsx, .js, .jsx, .vue）
 */
export async function refreshGitLabRepo(repoId: number, url: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  let repoExists = false;
  try {
    // 检查仓库目录是否存在
    await stat(repoPath);
    repoExists = true;
  } catch (error) {
    // 目录不存在，需要克隆
    console.log(`Repository directory not found, cloning from ${url}`);
  }

  if (!repoExists) {
    // 克隆仓库并执行完整索引
    await cloneGitLabRepo(url, repoId, gitlabToken);
    await indexCodebase(repoId, repoPath);
    await updateRepoStatus(repoId, 'ready');
    return { filesUpdated: 'full-reindex' };
  }

  // 拉取最新变更
  console.log(`Pulling latest changes for repo ${repoId}`);
  await execAsync(`cd ${repoPath} && git pull`);

  // 获取变更文件列表
  let changedFiles: string[] = [];
  try {
    // 使用 git diff 比较 HEAD@{1}（上一次的 HEAD）和当前 HEAD 之间的差异
    const { stdout } = await execAsync(`cd ${repoPath} && git diff --name-only HEAD@{1} HEAD`);
    // 过滤出支持的代码文件类型
    changedFiles = stdout.trim().split('\n').filter(f => f && f.match(/\.(ts|tsx|js|jsx|vue)$/));
  } catch (error: any) {
    // 如果 HEAD@{1} 不存在（首次克隆），执行完整重新索引
    const errorMsg = error.stderr || error.message || '';
    // 支持中英文错误信息
    if (errorMsg.includes('only has 1 entr') || errorMsg.includes('仅有 1 个条目')) {
      console.log(`First time indexing, doing full reindex for repo ${repoId}`);
      await indexCodebase(repoId, repoPath);
      await updateRepoStatus(repoId, 'ready');
      return { filesUpdated: 'full-reindex' };
    }
    throw error;
  }

  if (changedFiles.length === 0) {
    // 没有代码文件发生变化
    console.log(`No code files changed for repo ${repoId}`);
    await updateRepoStatus(repoId, 'ready');
    return { filesUpdated: 0 };
  }

  console.log(`Found ${changedFiles.length} changed files`);

  // 索引变更的文件
  await indexMultipleFiles(repoId, repoPath, changedFiles);

  // 更新状态为就绪
  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: changedFiles.length };
}
