/**
 * GitLab工具函数
 */

/**
 * 规范化GitLab URL
 * 将SSH和HTTPS格式统一为HTTPS，去除.git后缀
 */
export function normalizeGitLabUrl(url: string): string {
  // 去除.git后缀
  let normalized = url.replace(/\.git$/, '');

  // 统一SSH和HTTPS格式为HTTPS
  if (normalized.startsWith('git@')) {
    // git@gitlab.com:team/project → https://gitlab.com/team/project
    normalized = normalized
      .replace(/^git@/, 'https://')
      .replace(/:([^\/])/, '/$1'); // 只替换第一个冒号（端口号之前的）
  }

  return normalized;
}

/**
 * 从URL提取项目路径
 * 例如: https://gitlab.com/team/project → team/project
 */
export function extractProjectPath(url: string): string {
  const normalized = normalizeGitLabUrl(url);
  const match = normalized.match(/https?:\/\/[^\/]+\/(.+)/);
  return match ? match[1] : '';
}

/**
 * 从URL提取GitLab域名
 * 例如: https://gitlab.com/team/project → gitlab.com
 */
export function extractGitLabDomain(url: string): string {
  const normalized = normalizeGitLabUrl(url);
  const match = normalized.match(/https?:\/\/([^\/]+)/);
  return match ? match[1] : '';
}

/**
 * 从URL提取项目名称
 * 例如: https://gitlab.com/team/project → project
 */
export function extractProjectName(url: string): string {
  const projectPath = extractProjectPath(url);
  const parts = projectPath.split('/');
  return parts[parts.length - 1];
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
    const domain = extractGitLabDomain(normalized);

    if (!domain || !projectPath) {
      console.warn('[GitLab] Invalid URL, returning default branch "main"');
      return 'main';
    }

    // 调用GitLab API获取项目信息
    const encodedPath = encodeURIComponent(projectPath);
    const apiUrl = `https://${domain}/api/v4/projects/${encodedPath}`;

    const headers: Record<string, string> = {};
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }

    console.log(`[GitLab] Fetching default branch from ${apiUrl}`);
    const response = await fetch(apiUrl, { headers });

    if (response.ok) {
      const project = await response.json() as { default_branch?: string };
      const defaultBranch = project.default_branch || 'main';
      console.log(`[GitLab] Default branch: ${defaultBranch}`);
      return defaultBranch;
    } else {
      console.warn(`[GitLab] API request failed with status ${response.status}, returning "main"`);
      return 'main';
    }
  } catch (error) {
    console.error('[GitLab] Failed to get default branch:', error);
    return 'main';
  }
}

/**
 * 验证GitLab Token是否有效
 */
export async function validateGitLabToken(
  gitlabUrl: string,
  gitlabToken: string
): Promise<boolean> {
  try {
    const domain = extractGitLabDomain(gitlabUrl);
    const apiUrl = `https://${domain}/api/v4/user`;

    const response = await fetch(apiUrl, {
      headers: {
        'PRIVATE-TOKEN': gitlabToken,
      },
    });

    return response.ok;
  } catch (error) {
    console.error('[GitLab] Token validation failed:', error);
    return false;
  }
}
