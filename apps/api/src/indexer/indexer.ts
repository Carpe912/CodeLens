import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { insertFile, insertCodeChunk, updateRepoStatus, getFileByPath, updateFile, deleteFileChunks, deleteFile, updateIndexProgress, pool } from '../db/index.js';
import { batchGenerateEmbeddings } from '../llm/embeddings.js';
import type { IndexJobData } from './queue.js';

const execAsync = promisify(exec);

export async function indexRepository(jobData: IndexJobData) {
  const { repoId, source, url, zipPath, gitlabToken } = jobData;

  let repoPath: string;

  if (source === 'gitlab' && url) {
    repoPath = await cloneGitLabRepo(url, repoId, gitlabToken);
  } else if (source === 'zip' && zipPath) {
    repoPath = await extractZip(zipPath, repoId);
  } else {
    throw new Error('Invalid job data');
  }

  await indexCodebase(repoId, repoPath);
  await updateRepoStatus(repoId, 'ready');
}

export async function cloneGitLabRepo(url: string, repoId: number, gitlabToken?: string): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;

  // If token is provided, inject it into the URL for authentication
  let cloneUrl = url;
  if (gitlabToken) {
    // Always use HTTPS for authentication (many GitLab servers disable HTTP auth)
    // Convert http:// to https:// if needed
    let httpsUrl = url;
    if (url.startsWith('http://')) {
      httpsUrl = url.replace('http://', 'https://');
    }

    if (httpsUrl.startsWith('https://')) {
      cloneUrl = httpsUrl.replace('https://', `https://oauth2:${gitlabToken}@`);
    }
  }

  await execAsync(`git clone ${cloneUrl} ${targetDir}`);
  return targetDir;
}

async function extractZip(zipPath: string, repoId: number): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;
  await execAsync(`unzip -q ${zipPath} -d ${targetDir}`);
  return targetDir;
}

async function indexCodebase(repoId: number, repoPath: string) {
  const files = await collectFiles(repoPath);
  console.log(`Full indexing ${files.length} files for repo ${repoId}`);

  // Check which files are already indexed (for resume capability)
  const indexedFilesResult = await pool.query(
    'SELECT path FROM files WHERE repo_id = $1',
    [repoId]
  );
  const indexedPaths = new Set(indexedFilesResult.rows.map((row: any) => row.path));

  // Filter out already indexed files
  const filesToProcess = files.filter(filePath => {
    const relativePath = filePath.replace(repoPath, '').replace(/^\//, '');
    return !indexedPaths.has(relativePath);
  });

  const alreadyIndexed = files.length - filesToProcess.length;
  console.log(`Found ${alreadyIndexed} already indexed files, processing ${filesToProcess.length} remaining files`);

  // Initialize or update progress
  await updateIndexProgress(repoId, files.length, alreadyIndexed, new Date());

  // Process files in batches to avoid memory issues
  const BATCH_SIZE = 10;
  let processedCount = alreadyIndexed;

  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filesToProcess.length / BATCH_SIZE)} (${batch.length} files)`);

    for (const filePath of batch) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const parseResult = parseFile(filePath, content);

        if (!parseResult || parseResult.chunks.length === 0) {
          processedCount++;
          continue;
        }

        // Store relative path instead of absolute path
        const relativePath = filePath.replace(repoPath, '').replace(/^\//, '');
        const fileId = await insertFile(repoId, relativePath, parseResult.language, content);

        const texts = parseResult.chunks.map((chunk) => {
          return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
        });

        const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

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

        // Update progress after each file
        await updateIndexProgress(repoId, files.length, processedCount);
      } catch (error) {
        console.error(`Failed to index ${filePath}:`, error);
        processedCount++;
        await updateIndexProgress(repoId, files.length, processedCount);
      }
    }

    // Force garbage collection between batches if available
    if (global.gc) {
      global.gc();
    }

    // Add delay between batches to allow memory cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`Full indexing completed for ${files.length} files`);
}

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string) {
    const entries = await readdir(currentPath);

    for (const entry of entries) {
      // Skip common build/dependency/cache directories
      const skipDirs = [
        'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
        '.cache', '.turbo', '.nuxt', '.output', 'out', '.vercel',
        'vendor', 'target', '__pycache__', '.pytest_cache'
      ];

      if (skipDirs.includes(entry)) {
        continue;
      }

      const fullPath = join(currentPath, entry);
      const stats = await stat(fullPath);

      if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile()) {
        if (fullPath.match(/\.(ts|tsx|js|jsx|vue)$/)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

// Incremental indexing: update a single file
export async function indexSingleFile(repoId: number, repoPath: string, relativePath: string) {
  const fullPath = join(repoPath, relativePath);

  try {
    // Check if file exists
    const stats = await stat(fullPath);
    if (!stats.isFile()) {
      throw new Error('Not a file');
    }

    const content = await readFile(fullPath, 'utf-8');
    const parseResult = parseFile(fullPath, content);

    // Check if file already exists in database
    const existingFile = await getFileByPath(repoId, relativePath);

    if (existingFile) {
      // File exists - update it
      if (existingFile.content === content) {
        console.log(`File ${relativePath} unchanged, skipping`);
        return;
      }

      console.log(`Updating file ${relativePath}`);

      // Delete old chunks
      await deleteFileChunks(existingFile.id);

      if (!parseResult || parseResult.chunks.length === 0) {
        // File no longer has parseable code, just update content
        await updateFile(existingFile.id, content, parseResult?.language || 'unknown');
        return;
      }

      // Update file content
      await updateFile(existingFile.id, content, parseResult.language);

      // Insert new chunks
      const texts = parseResult.chunks.map((chunk) => {
        return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
      });

      const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

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
      // New file - insert it
      console.log(`Indexing new file ${relativePath}`);

      if (!parseResult || parseResult.chunks.length === 0) {
        // File has no parseable code, skip it
        return;
      }

      const fileId = await insertFile(repoId, relativePath, parseResult.language, content);

      const texts = parseResult.chunks.map((chunk) => {
        return `${chunk.symbolName} ${chunk.symbolType}\n${chunk.code}`;
      });

      const embeddings = texts.length > 0 ? await batchGenerateEmbeddings(texts) : [];

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
      // File was deleted
      const existingFile = await getFileByPath(repoId, relativePath);
      if (existingFile) {
        console.log(`Deleting file ${relativePath}`);
        await deleteFile(existingFile.id);
      }
    } else {
      console.error(`Failed to index ${relativePath}:`, error);
      throw error;
    }
  }
}

// Incremental indexing: update multiple files
export async function indexMultipleFiles(repoId: number, repoPath: string, relativePaths: string[]) {
  console.log(`Incremental indexing ${relativePaths.length} files for repo ${repoId}`);

  for (const relativePath of relativePaths) {
    await indexSingleFile(repoId, repoPath, relativePath);
  }

  console.log(`Incremental indexing completed for ${relativePaths.length} files`);
}

// Re-index GitLab repository: delete local copy, re-clone, and do full index
export async function reindexGitLabRepo(repoId: number, url: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  // Delete existing repository directory if it exists
  try {
    await execAsync(`rm -rf ${repoPath}`);
    console.log(`Deleted existing repository directory for repo ${repoId}`);
  } catch (error) {
    console.log(`No existing directory to delete for repo ${repoId}`);
  }

  // Clone the repository
  console.log(`Cloning repository for full reindex: ${url}`);
  await cloneGitLabRepo(url, repoId, gitlabToken);

  // Do full index
  await indexCodebase(repoId, repoPath);
  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: 'full-reindex' };
}

// Refresh GitLab repository: pull latest changes and index modified files
export async function refreshGitLabRepo(repoId: number, url: string, gitlabToken?: string) {
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  let repoExists = false;
  try {
    // Check if repo directory exists
    await stat(repoPath);
    repoExists = true;
  } catch (error) {
    // Directory doesn't exist, need to clone
    console.log(`Repository directory not found, cloning from ${url}`);
  }

  if (!repoExists) {
    // Clone the repository and do a full index
    await cloneGitLabRepo(url, repoId, gitlabToken);
    await indexCodebase(repoId, repoPath);
    await updateRepoStatus(repoId, 'ready');
    return { filesUpdated: 'full-reindex' };
  }

  // Pull latest changes
  console.log(`Pulling latest changes for repo ${repoId}`);
  await execAsync(`cd ${repoPath} && git pull`);

  // Get list of changed files
  let changedFiles: string[] = [];
  try {
    const { stdout } = await execAsync(`cd ${repoPath} && git diff --name-only HEAD@{1} HEAD`);
    changedFiles = stdout.trim().split('\n').filter(f => f && f.match(/\.(ts|tsx|js|jsx|vue)$/));
  } catch (error: any) {
    // If HEAD@{1} doesn't exist (first clone), do a full reindex
    const errorMsg = error.stderr || error.message || '';
    if (errorMsg.includes('only has 1 entr') || errorMsg.includes('仅有 1 个条目')) {
      console.log(`First time indexing, doing full reindex for repo ${repoId}`);
      await indexCodebase(repoId, repoPath);
      await updateRepoStatus(repoId, 'ready');
      return { filesUpdated: 'full-reindex' };
    }
    throw error;
  }

  if (changedFiles.length === 0) {
    console.log(`No code files changed for repo ${repoId}`);
    await updateRepoStatus(repoId, 'ready');
    return { filesUpdated: 0 };
  }

  console.log(`Found ${changedFiles.length} changed files`);

  // Index changed files
  await indexMultipleFiles(repoId, repoPath, changedFiles);

  // Update status to ready
  await updateRepoStatus(repoId, 'ready');

  return { filesUpdated: changedFiles.length };
}
