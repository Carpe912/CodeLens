/**
 * 企业级配置
 * 这些配置由管理员统一管理，用户无需配置
 */

export const ENTERPRISE_CONFIG = {
  /**
   * 权限检查
   * true: 启用GitLab权限验证
   * false: 禁用权限检查（开发环境）
   */
  enablePermissionCheck: true,

  /**
   * 允许的GitLab域名白名单
   * 空数组表示允许所有域名
   * 示例: ['gitlab.company.com', 'gitlab.internal.com']
   */
  allowedGitLabDomains: [
    // 在这里添加你公司的GitLab域名
    // 'gitlab.company.com',
  ],

  /**
   * API服务器地址
   * 用户可以在VSCode设置中覆盖此配置
   */
  defaultApiUrl: 'https://sunlingyue.cn/code-api',
};

/**
 * 获取企业配置
 */
export function getEnterpriseConfig() {
  return ENTERPRISE_CONFIG;
}

/**
 * 检查是否启用权限检查
 */
export function isPermissionCheckEnabled(): boolean {
  return ENTERPRISE_CONFIG.enablePermissionCheck;
}

/**
 * 获取允许的GitLab域名列表
 */
export function getAllowedGitLabDomains(): string[] {
  return ENTERPRISE_CONFIG.allowedGitLabDomains;
}
