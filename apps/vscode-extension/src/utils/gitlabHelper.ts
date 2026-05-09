/**
 * GitLab辅助函数
 * 用于获取分支信息和计算差异文件
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 规范化GitLab URL
 */
function normalizeGitLabUrl(url: string): string {
  let normalized = url.replace(/\.git$/, '');
  if (normalized.startsWith('git@')) {
    normalized = normalized
      .replace(/^git@/, 'https://')
      .replace(/:([^\/])/, '/$1');
  }
  return normalized;
}

/**
 * 提取项目路径
 */
function extractProjectPath(url: string): string {
  const normalized = normalizeGitLabUrl(url);
  const match = normalized.match(/https?:\/\/[^\/]+\/(.+)/);
  return match ? match[1] : '';
}

/**
 * 获取GitLab项目的默认分支
 */
export async function getGitLabDefaultBranch(
  gitlabUrl: string,
  gitlabToken?: string
): Promise<string> {
  try {
    const normalized = normalizeGitLabUrl(gitlabUrl);
    const projectPath = extractProjectPath(normalized);
    const domain = normalized.match(/https?:\/\/([^\/]+)/)?.[1];

    if (!domain || !projectPath) {
      console.warn('[GitLabHelper] Invalid URL, returning default branch "main"');
      return 'main';
    }

    const encodedPath = encodeURIComponent(projectPath);
    const apiUrl = `https://${domain}/api/v4/projects/${encodedPath}`;

    const headers: Record<string, string> = {};
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }

    console.log(`[GitLabHelper] Fetching default branch from ${apiUrl}`);
    const response = await fetch(apiUrl, { headers });

    if (response.ok) {
      const project = await response.json() as { default_branch?: string };
      const defaultBranch = project.default_branch || 'main';
      console.log(`[GitLabHelper] Default branch: ${defaultBranch}`);
      return defaultBranch;
    }

    console.warn(`[GitLabHelper] API request failed with status ${response.status}, returning "main"`);
    return 'main';
  } catch (error) {
    console.error('[GitLabHelper] Failed to get default branch:', error);
    return 'main';
  }
}

/**
 * 获取当前分支名称
 */
export async function getCurrentBranch(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath });
    return stdout.trim() || 'main';
  } catch (error) {
    console.error('[GitLabHelper] Failed to get current branch:', error);
    return 'main';
  }
}

/**
 * 获取与基础分支的差异文件
 */
export async function getDiffFromBaseBranch(
  workspacePath: string,
  baseBranch: string
): Promise<string[]> {
  try {
    // 使用三点语法获取分支差异
    const { stdout } = await execAsync(
      `git diff --name-only ${baseBranch}...HEAD`,
      { cwd: workspacePath }
    );

    const files = stdout
      .trim()
      .split('\n')
      .filter(f => f && isSupportedFile(f));

    console.log(`[GitLabHelper] Found ${files.length} changed files from ${baseBranch}`);
    return files;
  } catch (error) {
    console.error('[GitLabHelper] Failed to get diff:', error);
    return [];
  }
}

/**
 * 检查文件是否为支持的前端文件类型
 */
function isSupportedFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|vue)$/.test(file);
}

/**
 * 获取Git远程仓库URL
 */
export async function getGitRemoteUrl(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
    return stdout.trim();
  } catch (error) {
    console.error('[GitLabHelper] Failed to get remote URL:', error);
    return null;
  }
}
