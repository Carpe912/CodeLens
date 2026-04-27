import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { insertFile, insertCodeChunk, updateRepoStatus, getFileByPath, updateFile, deleteFileChunks, deleteFile } from '../db/index.js';
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

async function cloneGitLabRepo(url: string, repoId: number, gitlabToken?: string): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;

  // If token is provided, inject it into the URL for authentication
  let cloneUrl = url;
  if (gitlabToken) {
    // Support both https:// and http:// URLs
    if (url.startsWith('https://')) {
      cloneUrl = url.replace('https://', `https://oauth2:${gitlabToken}@`);
    } else if (url.startsWith('http://')) {
      cloneUrl = url.replace('http://', `http://oauth2:${gitlabToken}@`);
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

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const parseResult = parseFile(filePath, content);

      if (!parseResult || parseResult.chunks.length === 0) {
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
    } catch (error) {
      console.error(`Failed to index ${filePath}:`, error);
    }
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string) {
    const entries = await readdir(currentPath);

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') {
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
