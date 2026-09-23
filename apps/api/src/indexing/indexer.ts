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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { languageRegistry } from './languages/registry.js';
import { scanRepoFiles, formatSkippedSummary, checkIndexGuards, SKIP_DIRS } from './file-scanner.js';
import { insertFile, insertCodeChunk, updateRepoStatus, getFileByPath, updateFile, deleteFileChunks, deleteFile, updateIndexProgress, pool } from '../db/index.js';
import { batchGenerateEmbeddings } from '../llm/embeddings.js';
import type { IndexJobData } from './queue.js';
import { EnhancedIndexer } from './enhanced-indexer.js';
import { RelationshipBuilder } from './relationship-builder.js';
import {
  snapshotEntities,
  diffEntitySnapshots,
  emptyDelta,
  buildIncrementalReport,
  saveIncrementalReport,
  type IndexingOutcome,
} from './incremental-report.js';
import {
  assertGitWorkTree,
  getUpstreamStatus,
  fastForwardToUpstream,
  type GitFileChange,
} from './git-upstream.js';

/**
 * 跑外部命令。
 *
 * ⚠️ **一律用 `execFile`（参数数组），不要用 `exec` 拼 shell 字符串。**
 * 这个文件里三个调用点有两个吃的是**用户输入** —— 克隆地址来自用户提交的 URL、
 * 解压路径来自用户上传的文件名。拼进 shell 就是命令注入：
 * 一个叫 `a;rm -rf /tmp/x.zip` 的上传文件名足以执行任意命令。
 * `execFile` 不经过 shell，参数原样交给程序，`;` / `$()` / 反引号都只是普通字符。
 *
 * 另外 `execAsync` 会把 stdout/stderr 缓冲进内存，大仓库的 `git clone` 输出
 * 会白白占内存；`execFile` 同样有 maxBuffer，但至少我们不再额外拼一层 shell。
 */
const execFileAsync = promisify(execFile);

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
 * @param gitlabToken - GitLab 访问凭据（可选）
 *                      - 用于访问私有仓库
 *                      - 会自动注入到 URL 的 userinfo 中
 *
 * @returns 返回克隆后的本地仓库路径
 *
 * 认证机制：
 * - 提供了凭据时，会把 URL 转成 `https://<userinfo>@host/path` 再 clone
 * - 自动将 http:// 转换为 https://（因为许多 GitLab 服务器禁用 HTTP 认证）
 *
 * `gitlabToken` 有**两种形态**，靠有没有冒号区分（见下方注释）：
 *   1) 纯 token → userinfo 用 `oauth2:<token>`
 *   2) 完整 `用户名:密码` → userinfo 原样使用
 *
 * 存储位置：
 * - 所有仓库统一存储在 /tmp/codelens-repos/{repoId} 目录下
 */
export async function cloneGitLabRepo(url: string, repoId: number, gitlabToken?: string): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;

  // 如果提供了凭据，将其注入到 URL 中用于身份验证
  let cloneUrl = url;
  if (gitlabToken) {
    // 始终使用 HTTPS 进行身份验证（许多 GitLab 服务器禁用 HTTP 认证）
    // 如果需要，将 http:// 转换为 https://
    let httpsUrl = url;
    if (url.startsWith('http://')) {
      httpsUrl = url.replace('http://', 'https://');
    }

    // ⚠️ 用户名**不能**写死成 `oauth2`。
    // 只写 `oauth2:<凭据>` 的话，只有 Personal/Project Access Token 能过；
    // 而这套系统里也真的有人会填「账号密码」（浏览器/钥匙串里存的就是这种）。
    // 判据：**凭据里有没有冒号** ——
    //   - 有冒号 ⇒ 已经是完整的 `用户名:密码`，原样当 userinfo 用；
    //   - 没有   ⇒ 视为裸 token，按 GitLab 的约定配 `oauth2` 当用户名。
    //     （GitLab PAT 的格式是 `glpat-xxxx`，不含冒号，所以这个判据不会误判。）
    // ⚠️ 走「用户名:密码」这条路时，用户名必须是**已 URL 编码**的形式
    //     （`leon.sun@x.com` 要写成 `leon.sun%40x.com`）：userinfo 里出现裸 `@`
    //     会被「最后一个 @ 才是分隔符」的规则吃掉，把 `<x.com>:<密码>` 错当成主机。
    //     钥匙串/`.git-credentials` 里存的就是编码形式，直接抄即可。
    if (httpsUrl.startsWith('https://')) {
      const userinfo = gitlabToken.includes(':') ? gitlabToken : `oauth2:${gitlabToken}`;
      cloneUrl = httpsUrl.replace('https://', `https://${userinfo}@`);
    }
  }

  // ⚠️ clone 前**必须先清掉目标目录**。
  //
  // `git clone <url> <dir>` 在 `dir` 已存在且非空时会直接失败（`fatal: destination path
  // ... already exists and is not an empty directory`），而这个失败发生在
  // **索引本身已经成功之后**（job 队列里同一个仓库被重跑、或「全量重建」与「增强重建」
  // 两个 job 前后脚执行）⇒ 它会把 repo 状态从 `ready` 覆写成 `failed`。
  // 2026-09-19 实测：repo 33 数据完全正常（1051 files / 14084 chunks / 各层齐全），
  // 但仓库页显示 `failed` —— **状态是错的，数据是好的**，比明确失败更难判断。
  //
  // `force: true` 让「目录不存在」不报错，`recursive: true` 连 `.git` 一起清。
  await rm(targetDir, { recursive: true, force: true });

  // 执行 git clone 命令。
  // ⚠️ 用 execFile 传参数数组，**不要**拼成 `git clone ${cloneUrl} ${targetDir}` ——
  // cloneUrl 来自用户提交的 URL（还可能内嵌 token），拼 shell 即命令注入。
  try {
    await execFileAsync('git', ['clone', cloneUrl, targetDir], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    // ⚠️ **脱敏**：git 的失败信息会把命令原文回显，而 `cloneUrl` 里嵌着
    // `用户名:密码`。原样抛出去 = 明文密码进 `codelens-api-error.log`（实测发生过）。
    // 日志是要给人看、也经常要被贴出来的东西，凭据不能躺在里面。
    const raw = error instanceof Error ? error.message : String(error);
    const redactedUrl = cloneUrl === url ? url : cloneUrl.replace('//', '//***:***@');
    const message = raw.split(cloneUrl).join(redactedUrl);
    throw new Error(`git clone 失败（凭据已脱敏）：${message}`);
  }

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
 *
 * ⚠️ `zipPath` 由**上传的文件名**拼成（见 repos 路由的 `/repos/upload`），
 * 所以这里同样必须用 `execFile` 传参数数组 —— 一个叫 `x.zip;rm -rf ~` 的文件名
 * 在 `exec` 拼串写法下就是一条任意命令。
 */
async function extractZip(zipPath: string, repoId: number): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;
  await execFileAsync('unzip', ['-q', zipPath, '-d', targetDir], { maxBuffer: 16 * 1024 * 1024 });
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
 *
 * ⚠️ **导出是为了让 A/B 闸门能构造「真正的全量重建」**（`scripts/ab-incremental-gate.ts`）。
 * 注意它自带**断点续传**：已经登记在 `files` 表里的路径会被**跳过**。
 * 所以「重跑一次 `indexCodebase`」**不等于**全量重建 —— 必须先 `clearRepoData(repoId)`
 * 把库里清空，它才会真的重走一遍。这一点搞错了，A/B 闸门会拿两份「什么都没做」的快照
 * 互相比对，然后报「完全一致」—— 一个看起来最像成功的假阴性。
 */
export async function indexCodebase(
  repoId: number,
  repoPath: string,
  options: { enhanced?: 'full' | 'resume' } = {}
) {
  // 收集所有需要索引的文件（受支持的扩展名来自语言注册表，全仓只此一份清单）
  // ⚠️ 用 scanRepoFiles 而不是 collectFiles：前者会把「被守卫跳过」的文件带出来。
  const { files, skipped } = await scanRepoFiles(repoPath);

  // 被守卫拦下的文件**必须逐条上报**。
  // 三层的判据都是启发式的，静默丢弃会让「这个函数怎么搜不到」变成无解的谜题。
  //
  // ⚠️ 用 `console.log` 而不是 `console.warn`：跳过构建产物是**预期行为**，
  // 不是异常。而 pm2 会把 stderr（warn/error）分流到 `codelens-api-error.log` ——
  // 把 224 行正常信息塞进错误日志，只会让人以后不敢再认真看错误日志。
  // （反过来，如果你在 out 日志里 grep 不到这段输出，先确认自己看的是哪个文件。）
  if (skipped.length > 0) {
    console.log(`[indexer] ${formatSkippedSummary(skipped)}：`);
    for (const item of skipped) {
      console.log(`[indexer]   跳过 ${item.path} —— ${item.reason}（${item.detail}）`);
    }
  }

  // ⚠️ 0 个文件必须**大声失败**。
  //
  // 修前这里什么都不做：索引继续跑完、状态置 `ready`、退出码 0，日志里只有一行
  // `Processed: 0/0` —— 一个 Java 仓库上传后就是这样「成功」的，而且没人会去翻日志。
  // 这与「目录结构一变、`reindex` 静默清空 8 张表」是同一类失败（见运维铁律 2）：
  // **静默的部分成功，比明确的失败危险得多。**
  if (files.length === 0) {
    const skippedNote =
      skipped.length > 0
        ? `注意：有 ${skipped.length} 个文件被守卫跳过（构建产物 / 过大 / 压缩），` +
          `如果仓库里只有这些文件，那真正的问题是它们不该参与索引，而不是没有文件。`
        : '';
    throw new Error(
      `仓库中找不到任何可索引的文件（已跳过 ${SKIP_DIRS.join(' / ')}）。` +
        `当前支持的语言：${languageRegistry.all().map((p) => p.id).join(', ')}；` +
        `扩展名：${languageRegistry.supportedExtensions.join(', ')}。` +
        `若这是 Java / Python / Go 仓库，需要先在 indexing/languages/ 下补对应适配器。` +
        skippedNote
    );
  }

  console.log(`Full indexing ${files.length} files for repo ${repoId}`);

  // 检查哪些文件已经被索引（用于断点续传功能）
  //
  // ⚠️ 判据是「**有文件行** 且 **至少有一个代码块**」，不是只看文件行。
  //
  // `insertFile` 先落 `files` 行、再逐块插 `code_chunks`，所以进程在两者之间挂掉
  // 会留下「有文件行、0 个 chunk」的半成品。只看文件行的旧判据会把它当成已完成
  // ⇒ 续跑时跳过 ⇒ 该文件永久只有文件行、没有任何可检索内容，且没有报错。
  // 加上 `EXISTS(code_chunks)` 之后，半成品会被重新处理。
  //
  // 修完「0 代码块文件也会入库」之后，这条判据更强了：正常完成的文件必然至少有 1 个块
  // （抽不出符号的会拿到整文件兜底块），所以「0 个块」可靠地等价于「没做完」。
  const indexedFilesResult = await pool.query(
    `SELECT f.path
       FROM files f
      WHERE f.repo_id = $1
        AND EXISTS (SELECT 1 FROM code_chunks c WHERE c.file_id = f.id)`,
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

  /**
   * 「没有独立符号、按整文件兜底入库」的文件数。
   *
   * 这类文件（barrel `index.ts`、只有 import 的 `<script setup>`、纯模板组件、i18n 字典、
   * `*.d.ts`）走的是适配层的兜底块，**是预期行为**，所以不该逐条刷日志；
   * 但也不能没人知道 —— 它是「仓库页文件数」与「扫描到的文件数」是否对得上的关键，
   * 所以末尾汇总一行（见下方 `Full indexing completed` 之后）。
   */
  let moduleFallbackFiles = 0;

  /** 连兜底块都没产出的文件数（正常情况下恒为 0，非 0 说明适配层没兜住） */
  let zeroChunkFiles = 0;

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
        // 语言分发走在注册表里 —— 这里不再出现任何 .ts/.vue 字样
        const parser = languageRegistry.forFile(filePath);
        if (!parser) {
          // 扫描器与注册表用的是同一份清单，正常走不到这里。
          // 真走到了说明两者不一致 —— 记日志，不要静默跳过。
          console.warn(`No language parser registered for ${filePath}, skipping`);
          processedCount++;
          await updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount);
          continue;
        }
        const parseResult = parser.parseChunks(filePath, content);

        // ⚠️ 正常情况走到这里 `chunks` **必然非空** —— 适配层
        // （`languages/typescript/index.ts` 的 `parseWithFallback`）保证「抽不出符号」的文件
        // 会补一条 `symbolType: 'module'` 的整文件兜底块。
        //
        // 所以这个分支现在是**防御性**的：真触发 = 适配层没兜住（例如将来新加的 Java 适配器
        // 自己没实现兜底）。必须吵出来，**不能再像修前那样静默 `continue`** ——
        // 修前正是这里让 repo 33 的 257 个文件不落 `files` 表、不打日志、不报错。
        // 这与 `indexCodebase` 开头「0 个文件必须大声失败」是同一条原则：
        // **静默的部分成功，比明确的失败危险得多。**
        if (parseResult.chunks.length === 0) {
          console.warn(
            `[indexer] ${filePath}：适配层未能抽出任何代码块，也没有提供整文件兜底块 → 该文件不会入库。` +
              `请检查 languages/${parser.id}/ 的 parseChunks 是否走了「空结果兜底」。`
          );
          zeroChunkFiles++;
          processedCount++;
          await updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount);
          continue;
        }

        // 统计「整文件兜底」文件（预期行为，末尾汇总上报）
        if (parseResult.chunks.some((c) => c.symbolType === 'module')) {
          moduleFallbackFiles++;
        }

        // 存储相对路径而不是绝对路径（便于跨环境迁移）
        const relativePath = filePath.replace(repoPath, '').replace(/^\//, '');
        // 将文件信息插入数据库
        const fileId = await insertFile(repoId, relativePath, parser.id, content);

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

  // 兜底块与「没兜住」都要报出来。
  //
  // 修前这里什么都不说，于是「仓库页显示 1051 个文件、实际扫到 1308 个」
  // 只能靠人工 `comm` 两个清单才发现 —— 而那时候排查方向已经被引到解析器上去了。
  // 一行汇总把「差额去哪了」变成可读信息。
  if (moduleFallbackFiles > 0) {
    console.log(
      `[indexer] ${moduleFallbackFiles} 个文件没有独立符号（barrel / 纯模板组件 / i18n 字典 / .d.ts 等），` +
        `已按整文件兜底块入库（可检索、可向量化，只是不会出现在符号列表里）`
    );
  }
  if (zeroChunkFiles > 0) {
    console.warn(`[indexer] ⚠️ ${zeroChunkFiles} 个文件连兜底块都没有，未入库 —— 见上方逐条告警`);
  }

  // 运行增强索引以提取 AST 信息
  //
  // 这里曾经以「ANTHROPIC_API_KEY 是否存在」作为开关，但这道门禁是不成立的：
  // EnhancedIndexer 只做 AST 分析（符号表、调用关系、依赖图），**不发起任何 LLM 调用**。
  // 后果是：一旦把 LLM 换成 DeepSeek，ANTHROPIC_API_KEY 不复存在，增强索引就会被
  // 静默跳过 —— 符号表和依赖图全空，/impact 之类的功能随之失效，而且只在日志里
  // 留一行 warning。因此改为无条件执行。
  //
  // ⚠️ 两条路的区别只有一个字：**清不清空**。
  // - `'full'`（默认，全量重建时用）：`reindexRepository` 先 cleanupRepository 清空
  //   10 张关系/实体表，再处理**全部**文件。
  // - `'resume'`（断点续跑时用）：`resumeRepository` **不删任何东西**，只挑
  //   `entities_indexed_at IS NULL` 的文件逐个重建（`rebuildFiles` 内部会对每个目标
  //   先删干净自己，所以重跑同一个文件是幂等的）。
  const enhancedMode = options.enhanced ?? 'full';
  console.log(`Starting enhanced indexing (AST analysis, mode=${enhancedMode})...`);
  {
    const enhancedIndexer = new EnhancedIndexer(pool);

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

    // 执行增强索引（上一轮的失败会把对应文件的标记留成 NULL，续跑时自然被挑出来）
    const onProgress = async (progress: { processedFiles: number; totalFiles: number }) => {
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
    };

    if (enhancedMode === 'resume') {
      await enhancedIndexer.resumeRepository(repoId, { onProgress });
    } else {
      await enhancedIndexer.reindexRepository(repoId, repoPath, { onProgress });
    }

    console.log('Enhanced indexing completed');
  }
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

    // 三层守卫：单文件补索引时同样挡掉构建/压缩产物（与全量、增量同一套判据）
    const guardHit = await checkIndexGuards(relativePath, fullPath, stats.size, content);
    if (guardHit) {
      console.log(
        `[indexer] 单文件索引跳过 ${relativePath} —— ${guardHit.reason}（${guardHit.detail}）`
      );
      return;
    }
    // 解析文件（语言分发走注册表）
    const parser = languageRegistry.forFile(fullPath);
    const parseResult = parser ? parser.parseChunks(fullPath, content) : null;

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
        await updateFile(existingFile.id, content, parser?.id || 'unknown');
        return;
      }

      // 更新文件内容
      await updateFile(existingFile.id, content, parser!.id);

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
      const fileId = await insertFile(repoId, relativePath, parser!.id, content);

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
 * 增量索引：批量更新多个文件（**三层联动**）
 *
 * 功能：当多个文件发生变化时，只重建受影响的那部分索引。
 *
 * ============================================================
 * 为什么不再是「循环调用 indexSingleFile」
 * ============================================================
 * `indexSingleFile` 只维护**第一层**（files + code_chunks + 向量）。
 * 实体层（functions / classes / string_constants / url_patterns）和
 * 关系层（import_relations / call_graph / file_dependencies / url_usages）
 * 它一行都不碰。于是旧实现的增量会出现：
 *   - 内容改了但行号错位 → 检索出来的证据指向**别的代码**
 *   - 删掉的函数还在库里 → 「这个符号在哪」给出幽灵结果
 *   - 调用图静默缺边（chunk id 被级联删掉，没人补）
 * 这条路走下来，索引会「看起来是好的、实际上在慢性烂掉」。
 *
 * ============================================================
 * 引用完整性（本次实现的重点）
 * ============================================================
 * 改动/删除一个文件，**受伤的往往不只是它自己**。线上外键全是
 * ON DELETE CASCADE，所以级联删除会替我们清掉别的文件里的行，
 * 但没有任何机制会把那些行重新算出来。因此必须显式处理三类传播：
 *
 * 1. **删除文件** → 别的文件里「import 了它」的行被级联清掉
 *    （`import_relations.imported_file_id → files(id)` CASCADE）
 *    → 那些 import 方要一起重建，否则它们的依赖边永久消失。
 *    ⚠️ 这个查询必须在**删除之前**跑 —— 删完就查不到「谁引用了它」了。
 * 2. **改动/删除定义接口的文件** → 别的文件里的调用点被级联清掉
 *    （`url_usages → url_patterns → files` 两级 CASCADE）
 *    → 这些调用方要一起重建。
 * 3. **新增文件** → 别的文件里「本该指向它、但当时解析不到落点」的 import
 *    （`imported_file_id IS NULL`）现在能解析了
 *    → 这些 import 方要一起重建。
 *
 * 另外两类**不能**逐文件做，只能整仓重算：
 * - **call_graph**：`from/to_chunk_id` 都外键指向 code_chunks 且 CASCADE，
 *   重写变更文件的 chunk 会打掉别的文件指向它的入边，逐文件补不回来。
 *   代价可接受 —— 边可以从 `functions` 表直接重建，不用重新解析、不用重新生成向量。
 * - **file_dependencies**：一条边要导入方与被导入方双方都在库，只能整仓 GROUP BY。
 *
 * ⚠️ url_patterns 相反：**绝不能按文件删**。接口行是跨文件共享的
 *   （`(repo, method, 规范化路径)` 唯一），删它会级联打掉所有调用方。
 *   它的回收靠 `gcOrphanURLPatterns`，判据是「0 使用点」。
 *
 * @param repoId - 仓库 ID
 * @param repoPath - 仓库在本地文件系统的路径
 * @param relativePaths - 候选变更路径数组（可含删除的文件；内部会判定真实状态）
 *
 * @returns 本次变更的**索引侧结果报告**（新增/删除/位移的实体、被牵连重建的文件）。
 *   没有任何内容变化时返回 `null` —— 「没变化」与「变了但差集为空」是两件事，
 *   调用方（`refreshGitLabRepo`）需要区分它们来决定往 `repos.last_incremental` 里写什么。
 *
 * 使用场景：
 * - Git pull 后更新变更的文件（`refreshGitLabRepo`）
 * - 批量文件修改后的索引更新（`POST /repos/:id/incremental-index`）
 */
export async function indexMultipleFiles(
  repoId: number,
  repoPath: string,
  relativePaths: string[]
): Promise<IndexingOutcome | null> {
  const startedAt = Date.now();
  // 去重：同一个路径被传两次会让「变更判定」重复执行
  const candidates = [...new Set(relativePaths)];
  if (candidates.length === 0) return null;

  const relationshipBuilder = new RelationshipBuilder(pool);

  // ---------------------------------------------------------------
  // 阶段 0：判定每个候选路径的真实状态
  //   新增 / 修改 → 要重建；删除 → 要清理；内容未变 → 直接跳过
  // ---------------------------------------------------------------
  // 「内容未变就跳过」这一步以前藏在 indexSingleFile 里，现在提前到这里，
  // 因为**后续所有阶段都需要知道到底哪些文件真的变了**：
  // 未变的文件不该进重建集合，否则一次 no-op 的增量会去重建整个引用闭包。
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];
  /** 删除前抓下来的文件 id —— 删除后就查不到了 */
  const deletedFileIds: number[] = [];
  /** 变更（新增/修改）文件在**改动前**的 id；新增文件为 null */
  const preChangedIds: number[] = [];
  const addedPaths: string[] = [];

  for (const relativePath of candidates) {
    const existing = await getFileByPath(repoId, relativePath);

    let diskContent: string | null = null;
    try {
      diskContent = await readFile(join(repoPath, relativePath), 'utf-8');
    } catch {
      diskContent = null;
    }

    if (diskContent === null) {
      // 磁盘上没有了
      if (existing) {
        deletedPaths.push(relativePath);
        deletedFileIds.push(existing.id);
      }
      // 库里也没有 → 这个路径本来就不存在，无事可做
      continue;
    }

    // 三层守卫也要管增量路径：上游改了 `public/static/**` 里的压缩包时，
    // 走增量同样会把噪声灌进库 —— 全量索引挡住的那类文件，增量也该挡。
    // 复用刚读出来的 diskContent，不重复读盘。
    const guardHit = await checkIndexGuards(
      relativePath,
      join(repoPath, relativePath),
      Buffer.byteLength(diskContent, 'utf-8'),
      diskContent
    );
    if (guardHit) {
      console.log(
        `[indexer] 增量索引跳过 ${relativePath} —— ${guardHit.reason}（${guardHit.detail}）`
      );
      continue;
    }

    if (!existing) {
      addedPaths.push(relativePath);
      changedPaths.push(relativePath);
      preChangedIds.push(-1); // 占位：id 要等插入后才知道
    } else if (existing.content !== diskContent) {
      changedPaths.push(relativePath);
      preChangedIds.push(existing.id);
    }
    // 内容一致 → 未变更，跳过
  }

  if (changedPaths.length === 0 && deletedPaths.length === 0) {
    console.log(`Incremental indexing: no content change in ${candidates.length} candidate paths`);
    return null;
  }

  console.log(
    `Incremental indexing repo ${repoId}: ${changedPaths.length} changed, ${deletedPaths.length} deleted`
  );

  // ---------------------------------------------------------------
  // 阶段 1：引用传播（**必须在删除之前**）
  // ---------------------------------------------------------------
  // 变更文件的 id 在改动前就已知；删除文件的 id 刚抓下来。
  // 新增文件此刻还没 id，但它不可能已经「被别人 import」过 —— 它以前不存在。
  const touchedIds = [...deletedFileIds, ...preChangedIds.filter((id) => id > 0)];

  let referrers: { importers: number[]; urlUsageFiles: number[] } = {
    importers: [],
    urlUsageFiles: [],
  };
  try {
    referrers = await relationshipBuilder.findReferrersOf(repoId, touchedIds);
  } catch (error) {
    // 传播失败只意味着「可能有文件该重建而没重建」，比整体失败轻。
    // 明确告警而不是静默吞掉 —— 这正是本模块要修的「慢性烂掉」模式。
    console.error('⚠️ Failed to compute referrers (incremental may leave stale edges):', error);
  }

  // ---------------------------------------------------------------
  // 阶段 1.5：抓「改动前」的实体层快照 —— 必须在这里，不能更晚
  // ---------------------------------------------------------------
  // 下面阶段 2 会重写 chunk，而 functions / classes / string_constants 都有
  // `chunk_id → code_chunks ON DELETE CASCADE`，它们会在那一刻被连带删掉；
  // 删除文件时更是整个 files 行消失。**删完再抓就只剩一份空快照**，
  // 报告会把所有删除都漏报成「什么都没发生」。
  //
  // 快照范围刻意**只覆盖「结构上真的变了的文件」**（改动 + 删除），
  // 不含阶段 1/3 传播进来的引用方。理由：引用方的实体元组按构造不会变
  // （同一份内容重新解析 ⇒ 同名的 functions 落在同一行），把它们纳进来
  // 只会增加噪音；而一旦「after 侧」因为某个分支多带进一个文件、
  // 「before 侧」没有它，报告就会把这个文件的所有实体谎报成「新增」。
  // 两侧文件集必须严格同源，这是本报告最容易出错的地方。
  const beforeSnapshot = await snapshotEntities(pool, repoId, [
    ...preChangedIds.filter((id) => id > 0),
    ...deletedFileIds,
  ]);

  // ---------------------------------------------------------------
  // 阶段 2（第一层）：文件与代码块
  // ---------------------------------------------------------------
  for (const relativePath of changedPaths) {
    await indexSingleFile(repoId, repoPath, relativePath);
  }
  for (const relativePath of deletedPaths) {
    // indexSingleFile 的 ENOENT 分支会 deleteFile（级联清掉 chunk 与各实体表）
    await indexSingleFile(repoId, repoPath, relativePath);
  }

  // ---------------------------------------------------------------
  // 阶段 3：新增文件带来的一次额外传播
  // ---------------------------------------------------------------
  // 新文件入库后，原本「本该指向它却解析不到落点」的老 import 需要重算。
  // 判定方式：把老 import 的路径展开成候选集，看候选里有没有新文件 ——
  // 用的是 buildImportRelationships 的**同一个**展开规则，避免假阳性。
  const rebuildIds = new Set<number>([
    ...referrers.importers,
    ...referrers.urlUsageFiles,
  ]);

  // 变更/新增文件的 id：重新查库拿（新增文件的 id 到这里才存在）
  const changedIdRows = await pool.query(
    `SELECT id FROM files WHERE repo_id = $1 AND path = ANY($2)`,
    [repoId, changedPaths]
  );
  for (const row of changedIdRows.rows) rebuildIds.add(row.id);
  // 变更文件即使没被任何人引用，也必须重建自己
  if (changedPaths.length > 0 && changedIdRows.rows.length === 0) {
    console.warn('⚠️ No file rows found for changed paths; skipping entity-layer rebuild');
  }

  if (addedPaths.length > 0) {
    try {
      const unresolved = await relationshipBuilder.findUnresolvedInRepoImports(repoId);
      const addedSet = new Set(addedPaths);
      let promoted = 0;

      for (const row of unresolved) {
        if (rebuildIds.has(row.importerFileId)) continue;
        const candidatesForImport = relationshipBuilder.resolveImportCandidates(
          row.importerPath,
          row.importPath
        );
        if (candidatesForImport.some((c) => addedSet.has(c))) {
          rebuildIds.add(row.importerFileId);
          promoted++;
        }
      }

      if (promoted > 0) {
        console.log(`✓ New files resolved ${promoted} previously unresolved imports`);
      }
    } catch (error) {
      console.error('⚠️ Failed to promote importers of new files:', error);
    }
  }

  // ---------------------------------------------------------------
  // 阶段 4：实体层 + 关系层（逐文件重建）
  // ---------------------------------------------------------------
  // 到这里为止 chunk 层已经是对的；下面失败只会让「增强能力」降级，
  // 不会让索引整体不可用 —— 所以逐段 try/catch，但每条都打日志。
  try {
    const enhancedIndexer = new EnhancedIndexer(pool);
    await enhancedIndexer.rebuildFiles(repoId, [...rebuildIds]);
  } catch (error) {
    console.error('⚠️ Entity/relationship layer rebuild failed:', error);
  }

  // ---------------------------------------------------------------
  // 阶段 5：整仓重算调用图（必须在 import_relations 重建之后）
  // ---------------------------------------------------------------
  try {
    await relationshipBuilder.rebuildCallGraph(repoId);
  } catch (error) {
    console.error('⚠️ call_graph rebuild failed:', error);
  }

  // ---------------------------------------------------------------
  // 阶段 6：回收孤儿接口行（判据 = 0 使用点；范围限定在本次重建的文件）
  // ---------------------------------------------------------------
  try {
    const collected = await relationshipBuilder.gcOrphanURLPatterns(repoId, [...rebuildIds]);
    if (collected > 0) console.log(`✓ Collected ${collected} orphan url_patterns rows`);
  } catch (error) {
    console.error('⚠️ orphan url_patterns GC failed:', error);
  }

  // ---------------------------------------------------------------
  // 阶段 7：出报告 —— 抓「改动后」快照，与阶段 1.5 做差
  // ---------------------------------------------------------------
  // 刻意放在最后（而不是紧跟阶段 4）：这样**阶段 6 的孤儿 url_patterns 回收**
  // 也会计入报告。一条路由如果因为再也没有使用点而被 GC 掉，它确实从索引里
  // 消失了，报告就必须如实说「删除」，不能报成「还在」。
  //
  // 「after 侧」的文件集严格等于「before 侧」的文件集在改动后仍然存在的那部分：
  // before 侧 = 改动前已存在的变更文件 + 被删文件；after 侧 = 全部变更文件（含新增）。
  // 被删文件天然缺席 ⇒ 它们的实体自然落入 `removed`。
  let entities = emptyDelta();
  try {
    const afterIds = changedIdRows.rows.map((row: { id: number }) => row.id);
    const afterSnapshot = await snapshotEntities(pool, repoId, afterIds);
    entities = diffEntitySnapshots(beforeSnapshot, afterSnapshot);
  } catch (error) {
    // 报告失败不该把一次已经正确的索引变成失败，但也**不能静默返回空差集**
    // ——「0 变更」和「没算出来」在 UI 上是完全不同的两句话。
    console.error('⚠️ Failed to build entity delta report:', error);
  }

  const changedIdSet = new Set<number>(changedIdRows.rows.map((row: { id: number }) => row.id));
  const addedSet = new Set(addedPaths);
  let propagated: string[] = [];
  try {
    const propagatedIds = [...rebuildIds].filter((id) => !changedIdSet.has(id));
    if (propagatedIds.length > 0) {
      const rows = await pool.query(
        `SELECT path FROM files WHERE repo_id = $1 AND id = ANY($2) ORDER BY path`,
        [repoId, propagatedIds]
      );
      propagated = rows.rows.map((row: { path: string }) => row.path);
    }
  } catch (error) {
    console.error('⚠️ Failed to list propagated files:', error);
  }

  const outcome: IndexingOutcome = {
    added: [...addedPaths].sort(),
    modified: changedPaths.filter((p) => !addedSet.has(p)).sort(),
    deleted: [...deletedPaths].sort(),
    propagated,
    rebuiltFiles: rebuildIds.size,
    entities,
    durationMs: Date.now() - startedAt,
  };

  console.log(
    `Incremental indexing completed: ${changedPaths.length} changed, ` +
      `${deletedPaths.length} deleted, ${rebuildIds.size} files rebuilt at entity/relationship layer ` +
      `(entities +${entities.counts.added} / -${entities.counts.removed} / ~${entities.counts.moved})`
  );

  return outcome;
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

  // 如果存在，删除现有的仓库目录。
  // 用 fs.rm 而不是 `rm -rf` 拼串：路径虽然是内部生成的（repoId 是数字），
  // 但「这里没有用户输入所以可以拼 shell」这个推理一旦成立，就会有人在旁边
  // 加了用户输入之后忘记改回来。少一个拼串点就少一个犯错的地方。
  try {
    await rm(repoPath, { recursive: true, force: true });
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
 * **从断点继续**一个失败的（或需要补第二遍的）仓库索引 —— 不删任何已有数据。
 *
 * ============================================================
 * 与 reindex 的关系：差别是「清不清库」，不是「跑多少文件」
 * ============================================================
 * | | `reindexGitLabRepo` | `resumeRepo` |
 * |---|---|---|
 * | 数据库 | `clearRepoData` 清空 → 从零 | **不动** |
 * | 工作区 | 删掉重克隆 | 存在就复用 |
 * | 第一遍 | 全量 | 按「已登记且有代码块」跳过 |
 * | 第二遍 | `cleanupRepository` 清 10 张表后全量 | 只做 `entities_indexed_at IS NULL` |
 *
 * 所以续跑不是「打折的重建」，它是**同一条流水线**在「恢复」语义下的运行方式：
 * 每一层各自知道自己做到哪了（第一遍看 `files`+`code_chunks`，
 * 第二遍看 `files.entities_indexed_at`），不需要外部的「进度文件」。
 *
 * ============================================================
 * 工作区缺失时怎么办
 * ============================================================
 * 第一遍必须扫目录，所以工作区不能缺。缺了分两种情况：
 * - GitLab 源：重新克隆即可（**不**动数据库）；
 * - ZIP 源：原始压缩包不在服务器上，无法自动恢复 → 明确报错让用户重传。
 *   ⚠️ 这里刻意**不**退化成「用库里的 content 重写一份工作区」——
 *   那等于用索引内容反向造源码，一旦索引本身是缺的（正是要修的场景），
 *   就会把缺损固化成「源码」。宁可让人重传。
 *
 * @param repoId - 仓库 ID
 * @param url - GitLab 仓库 URL（工作区缺失时用来重新克隆）
 * @param gitlabToken - GitLab 访问凭据（可选）
 */
export async function resumeRepo(repoId: number, url?: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  let workdirReady = false;
  try {
    workdirReady = (await stat(repoPath)).isDirectory();
  } catch {
    workdirReady = false;
  }

  if (!workdirReady) {
    if (!url) {
      throw new Error(
        '本地工作区不存在，且没有可用于重新克隆的仓库地址。' +
          'ZIP 上传的仓库请重新上传（原始压缩包不在服务器上，无法自动恢复）。'
      );
    }
    console.log(`[resume] 工作区缺失，重新克隆：${url}`);
    await cloneGitLabRepo(url, repoId, gitlabToken);
  } else {
    console.log(`[resume] 复用已有工作区 ${repoPath}（不重新克隆）`);
  }

  await indexCodebase(repoId, repoPath, { enhanced: 'resume' });
  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: 'resume' };
}

/**
 * 刷新 GitLab 仓库：把本地副本快进到**默认分支**的最新提交，然后增量索引
 *
 * ============================================================
 * 与旧实现的差别（旧版是 `git pull` + `git diff HEAD@{1} HEAD`）
 * ============================================================
 * 旧链路有三个问题：`HEAD@{1}` 依赖 reflog（中间发生一次 checkout 就错位）、
 * `--name-only` 拿不到新增/删除的**区分**（UI 说不出「新增了哪些」）、
 * 默认分支靠本地 checkout 猜。现在改为「定位默认分支 → fetch（只读）→
 * 对比 `HEAD...origin/<分支>` → `merge --ff-only` 应用」，细节见 `git-upstream.ts`。
 *
 * ============================================================
 * 为什么必须先「预览」再「应用」再「索引」
 * ============================================================
 * 三步的顺序不是形式，是为了让每一步都能独立失败、且失败时状态可解释：
 * - 预览（fetch + diff）**不改工作区也不改库**，失败就是网络问题，重试即可；
 * - 应用（`--ff-only`）**只在能快进时成功**。本地被改脏时它会明确报错，
 *   而不是悄悄造一个合并提交 —— 对一个只用来喂索引的镜像目录，
 *   合并提交会让下次 diff 开始包含我们自己制造的差异，噪音越滚越大；
 * - 索引只在工作区已经确定的 HEAD 上跑，报告里的 `toSha` 才对得上。
 *
 * @param repoId - 仓库 ID
 * @param url - GitLab 仓库的 URL
 * @param gitlabToken - GitLab 访问令牌（可选）
 *
 * @returns `{ filesUpdated, report }`。`filesUpdated` 是**送进索引的候选路径数**
 *   （含删除，所以可能大于上游「新增+修改」的数目）；`report` 同时已写入
 *   `repos.last_incremental`，前端刷新仓库详情即可拿到。
 *
 * 使用场景：
 * - 定时同步 GitLab 仓库的最新代码
 * - Webhook 触发的自动更新
 * - 手动触发的增量更新
 */
export async function refreshGitLabRepo(repoId: number, url: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  // ---- 1. 本地副本可用吗？两种不可用都要退化成全量 ----
  let repoUsable = false;
  try {
    await stat(repoPath);
    // 目录在，但可能是 zip 解压出来的（没有 .git），那样后面所有 git 命令都会失败。
    // 这里提前判定，避免把「不是 git 工作区」报成「fetch 失败」，排查会绕远路。
    await assertGitWorkTree(repoPath);
    repoUsable = true;
  } catch (error) {
    console.log(
      `Repository ${repoId} local copy not usable for incremental (${(error as Error).message}); ` +
        `falling back to full clone + index`
    );
  }

  if (!repoUsable) {
    await cloneGitLabRepo(url, repoId, gitlabToken);
    await indexCodebase(repoId, repoPath);
    await updateRepoStatus(repoId, 'ready');
    const report = buildIncrementalReport({
      mode: 'full',
      note: '本地副本不存在或不是 git 工作区，本次为全量重建',
    });
    await saveIncrementalReport(pool, repoId, report);
    return { filesUpdated: 'full-reindex', report };
  }

  // ---- 2. 先看：fetch（只更新远端引用）+ 算差异，不动工作区 ----
  const status = await getUpstreamStatus(repoPath);
  console.log(
    `Upstream check repo ${repoId}: branch=${status.branch} ` +
      `ahead=${status.ahead} behind=${status.behind} files=${status.files.length}`
  );

  if (status.behind === 0) {
    console.log(`Repo ${repoId} already up to date with origin/${status.branch}`);
    await updateRepoStatus(repoId, 'ready');
    const report = buildIncrementalReport({
      mode: 'incremental',
      status,
      note: '上游没有新提交，索引未改动',
    });
    await saveIncrementalReport(pool, repoId, report);
    return { filesUpdated: 0, report };
  }

  // ---- 3. 应用：只允许快进 ----
  const fromSha = status.localSha;
  const toSha = await fastForwardToUpstream(repoPath, status.branch);
  console.log(`Repo ${repoId} fast-forwarded ${fromSha.slice(0, 8)} → ${toSha.slice(0, 8)}`);

  // ---- 4. 上游的 A/M/D → 索引侧候选路径 ----
  const candidatePaths = collectCandidatePaths(status.files);

  // ---- 5. 增量索引（含实体层与关系层联动）----
  let outcome: IndexingOutcome | null = null;
  let note: string | undefined;
  if (candidatePaths.length > 0) {
    console.log(`Found ${candidatePaths.length} candidate paths to index`);
    outcome = await indexMultipleFiles(repoId, repoPath, candidatePaths);
    if (!outcome) {
      // 走到了这里说明 git 说有变更，但库里比完内容后判定「一个文件都没变」
      // （常见于只改了行尾符、或大小写改了但 git 配置为不区分大小写）。
      // 必须明说，否则 UI 会显示「上游有 3 个新提交」却「索引 0 变更」而看不出原因。
      note = '上游有变更，但文件内容与索引一致，未触发重建';
    }
  } else {
    console.log(
      `Upstream changed ${status.files.length} files, but none matches an indexable language`
    );
    note = '上游有变更，但没有索引器支持的代码文件（仅支持 TS/JS/TSX/JSX 与 .vue）';
  }

  // ---- 6. 出报告并落库 ----
  // fromSha/toSha 用**真实快进结果**，而不是 status 里的值 ——
  // 以实际发生的动作为准，报告才不会与工作区实际状态不一致。
  const report = buildIncrementalReport({ mode: 'incremental', status, outcome, note });
  report.fromSha = fromSha;
  report.toSha = toSha;
  await saveIncrementalReport(pool, repoId, report);

  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: candidatePaths.length, report };
}

/**
 * 把 git 的文件级变更翻译成 `indexMultipleFiles` 的候选路径。
 *
 * 三个分支各有理由，别图省事合并成「只取 indexable 的 path」：
 * - **删除**：路径必须原样送进去，让索引侧把那一行删掉。**不按 indexable 过滤** ——
 *   库里有这份记录的事实比 `languageRegistry` 现在的看法更权威
 *   （注册表支持的语言集合是可能变的）。
 * - **重命名**：旧路径要删、新路径要建。`a.ts → a.txt` 这种改名又改类型的组合里，
 *   新路径不可索引，但旧行**必须**清掉，否则会留下一个永远搜得到的幽灵文件。
 * - **新增 / 修改**：只有可索引类型的才需要重建，其余改了也不进索引。
 */
export function collectCandidatePaths(files: GitFileChange[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.status === 'deleted') {
      paths.add(file.path);
      continue;
    }
    if (file.status === 'renamed') {
      if (file.fromPath) paths.add(file.fromPath);
      if (file.indexable) paths.add(file.path);
      continue;
    }
    if (file.indexable) paths.add(file.path);
  }
  return [...paths];
}
