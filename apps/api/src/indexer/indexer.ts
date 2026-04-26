import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from '../parser/index.js';
import { insertFile, insertCodeChunk, updateRepoStatus } from '../db/index.js';
import { batchGenerateEmbeddings } from '../llm/embeddings.js';
import type { IndexJobData } from './queue.js';

const execAsync = promisify(exec);

export async function indexRepository(jobData: IndexJobData) {
  const { repoId, source, url, zipPath } = jobData;

  let repoPath: string;

  if (source === 'gitlab' && url) {
    repoPath = await cloneGitLabRepo(url, repoId);
  } else if (source === 'zip' && zipPath) {
    repoPath = await extractZip(zipPath, repoId);
  } else {
    throw new Error('Invalid job data');
  }

  await indexCodebase(repoId, repoPath);
  await updateRepoStatus(repoId, 'ready');
}

async function cloneGitLabRepo(url: string, repoId: number): Promise<string> {
  const targetDir = `/tmp/codelens-repos/${repoId}`;
  await execAsync(`git clone ${url} ${targetDir}`);
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

      const fileId = await insertFile(repoId, filePath, parseResult.language, content);

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

      console.log(`Indexed ${filePath} with ${parseResult.chunks.length} chunks`);
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
