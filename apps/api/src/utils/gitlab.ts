/**
 * GitLab 工具函数集
 *
 * 提供 GitLab 相关的实用功能：
 * 1. URL 格式标准化（SSH/HTTPS 统一）
 * 2. 项目信息提取（路径、域名、名称）
 * 3. API 集成（获取默认分支、验证 Token）
 *
 * 使用场景：
 * - 代码仓库克隆和同步
 * - GitLab API 调用
 * - 项目配置管理
 */

/**
 * 规范化 GitLab URL
 * 将 SSH 和 HTTPS 格式统一为 HTTPS，去除 .git 后缀
 *
 * @param url 原始 GitLab URL（支持 SSH 或 HTTPS 格式）
 * @returns 标准化后的 HTTPS URL
 *
 * 转换规则：
 * 1. 去除 .git 后缀
 * 2. SSH 格式转 HTTPS：git@gitlab.com:team/project → https://gitlab.com/team/project
 *
 * 示例：
 * normalizeGitLabUrl('git@gitlab.com:team/project.git')
 * => 'https://gitlab.com/team/project'
 *
 * normalizeGitLabUrl('https://gitlab.com/team/project.git')
 * => 'https://gitlab.com/team/project'
 */
export function normalizeGitLabUrl(url: string): string {
  // 去除 .git 后缀
  let normalized = url.replace(/\.git$/, '');

  // 统一 SSH 和 HTTPS 格式为 HTTPS
  if (normalized.startsWith('git@')) {
    // git@gitlab.com:team/project → https://gitlab.com/team/project
    normalized = normalized
      .replace(/^git@/, 'https://')
      .replace(/:([^\/])/, '/$1'); // 只替换第一个冒号（端口号之前的）
  }

  return normalized;
}

/**
 * 从 URL 提取项目路径
 *
 * @param url GitLab URL
 * @returns 项目路径（不含域名）
 *
 * 示例：
 * extractProjectPath('https://gitlab.com/team/project')
 * => 'team/project'
 *
 * extractProjectPath('git@gitlab.com:team/subgroup/project.git')
 * => 'team/subgroup/project'
 */
export function extractProjectPath(url: string): string {
  const normalized = normalizeGitLabUrl(url);
  // 匹配 https://domain/ 之后的所有内容
  const match = normalized.match(/https?:\/\/[^\/]+\/(.+)/);
  return match ? match[1] : '';
}

/**
 * 从 URL 提取 GitLab 域名
 *
 * @param url GitLab URL
 * @returns GitLab 域名（不含协议）
 *
 * 示例：
 * extractGitLabDomain('https://gitlab.com/team/project')
 * => 'gitlab.com'
 *
 * extractGitLabDomain('git@gitlab.example.com:team/project')
 * => 'gitlab.example.com'
 */
export function extractGitLabDomain(url: string): string {
  const normalized = normalizeGitLabUrl(url);
  // 匹配协议后的域名部分
  const match = normalized.match(/https?:\/\/([^\/]+)/);
  return match ? match[1] : '';
}

/**
 * 从 URL 提取项目名称
 *
 * @param url GitLab URL
 * @returns 项目名称（路径的最后一部分）
 *
 * 示例：
 * extractProjectName('https://gitlab.com/team/project')
 * => 'project'
 *
 * extractProjectName('git@gitlab.com:team/subgroup/my-app.git')
 * => 'my-app'
 */
export function extractProjectName(url: string): string {
  const projectPath = extractProjectPath(url);
  const parts = projectPath.split('/');
  return parts[parts.length - 1]; // 返回最后一部分
}

/**
 * 获取 GitLab 项目的默认分支
 *
 * @param gitlabUrl GitLab 项目 URL
 * @param gitlabToken GitLab 访问令牌（可选，私有仓库需要）
 * @returns 默认分支名称（如 'main', 'master'）
 *
 * 实现细节：
 * 1. 解析 URL 提取域名和项目路径
 * 2. 调用 GitLab API v4 获取项目信息
 * 3. 从响应中提取 default_branch 字段
 * 4. 如果失败则返回 'main' 作为默认值
 *
 * API 端点：
 * GET https://{domain}/api/v4/projects/{encoded_path}
 *
 * 错误处理：
 * - URL 无效 → 返回 'main'
 * - API 请求失败 → 返回 'main'
 * - 网络错误 → 返回 'main'
 */
export async function getGitLabDefaultBranch(
  gitlabUrl: string,
  gitlabToken?: string
): Promise<string> {
  try {
    const normalized = normalizeGitLabUrl(gitlabUrl);
    const projectPath = extractProjectPath(normalized);
    const domain = extractGitLabDomain(normalized);

    // 验证 URL 有效性
    if (!domain || !projectPath) {
      console.warn('[GitLab] Invalid URL, returning default branch "main"');
      return 'main';
    }

    // 调用 GitLab API 获取项目信息
    // 项目路径需要 URL 编码（例如 team/project → team%2Fproject）
    const encodedPath = encodeURIComponent(projectPath);
    const apiUrl = `https://${domain}/api/v4/projects/${encodedPath}`;

    // 构建请求头
    const headers: Record<string, string> = {};
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken; // GitLab 私有令牌认证
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
    return 'main'; // 出错时返回默认值
  }
}

/**
 * 验证 GitLab Token 是否有效
 *
 * @param gitlabUrl GitLab 项目 URL（用于提取域名）
 * @param gitlabToken GitLab 访问令牌
 * @returns 如果 Token 有效返回 true，否则返回 false
 *
 * 实现细节：
 * 1. 提取 GitLab 域名
 * 2. 调用 /api/v4/user 端点验证 Token
 * 3. 如果返回 200 OK 则 Token 有效
 *
 * API 端点：
 * GET https://{domain}/api/v4/user
 * Header: PRIVATE-TOKEN: {token}
 *
 * 使用场景：
 * - 用户配置验证
 * - 权限检查
 * - 连接测试
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

    return response.ok; // 200-299 状态码表示成功
  } catch (error) {
    console.error('[GitLab] Token validation failed:', error);
    return false;
  }
}
