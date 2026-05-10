import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getEnterpriseConfig } from '../config/enterprise';

const execAsync = promisify(exec);

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  gitlabUrl?: string;
  projectPath?: string;
}

export class PermissionChecker {
  private allowedGitLabDomains: string[];
  private enablePermissionCheck: boolean;
  private apiService: any; // 用于检查仓库

  constructor(apiService?: any) {
    // 使用企业配置
    const enterpriseConfig = getEnterpriseConfig();
    this.allowedGitLabDomains = enterpriseConfig.allowedGitLabDomains;
    this.enablePermissionCheck = enterpriseConfig.enablePermissionCheck;
    this.apiService = apiService;
  }

  /**
   * 检查工作区是否有索引权限
   */
  async checkWorkspacePermission(workspaceFolder: vscode.WorkspaceFolder): Promise<PermissionCheckResult> {
    // 如果企业配置禁用了权限检查，直接允许
    if (!this.enablePermissionCheck) {
      return { allowed: true };
    }

    // 1. 检查是否为Git仓库
    const gitInfo = await this.getGitInfo(workspaceFolder.uri.fsPath);
    if (!gitInfo.isGitRepo) {
      // 非Git仓库，尝试通过文件夹名称匹配
      if (this.apiService) {
        try {
          const folderName = workspaceFolder.name;
          const checkResult = await this.apiService.repos.checkByRepoName(folderName);

          if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
            // 服务器已有同名仓库索引，直接允许
            return {
              allowed: true,
            };
          }
        } catch (error) {
          console.error('[PermissionChecker] Failed to check repo by folder name:', error);
        }
      }
      // 服务器没有匹配的仓库，拒绝索引
      return {
        allowed: false,
        reason: `服务器上没有名为 "${workspaceFolder.name}" 的仓库索引。请先在服务器上创建索引。`,
      };
    }

    // 2. 检查是否为GitLab仓库
    if (!gitInfo.remoteUrl) {
      // 本地Git仓库，无远程地址，尝试通过文件夹名称匹配
      if (this.apiService) {
        try {
          const folderName = workspaceFolder.name;
          const checkResult = await this.apiService.repos.checkByRepoName(folderName);

          if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
            // 服务器已有同名仓库索引，直接允许
            return {
              allowed: true,
            };
          }
        } catch (error) {
          console.error('[PermissionChecker] Failed to check repo by folder name:', error);
        }
      }
      // 服务器没有匹配的仓库，拒绝索引
      return {
        allowed: false,
        reason: `服务器上没有名为 "${workspaceFolder.name}" 的仓库索引。请先在服务器上创建索引。`,
      };
    }

    // 3. 解析GitLab URL
    const gitlabInfo = this.parseGitLabUrl(gitInfo.remoteUrl);
    if (!gitlabInfo) {
      // 非GitLab仓库（可能是GitHub等），尝试通过文件夹名称匹配
      if (this.apiService) {
        try {
          const folderName = workspaceFolder.name;
          const checkResult = await this.apiService.repos.checkByRepoName(folderName);

          if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
            // 服务器已有同名仓库索引，直接允许
            return {
              allowed: true,
            };
          }
        } catch (error) {
          console.error('[PermissionChecker] Failed to check repo by folder name:', error);
        }
      }
      // 服务器没有匹配的仓库，拒绝索引
      return {
        allowed: false,
        reason: `服务器上没有名为 "${workspaceFolder.name}" 的仓库索引。请先在服务器上创建索引。`,
      };
    }

    // 4. 检查GitLab域名是否在允许列表中
    if (this.allowedGitLabDomains.length > 0) {
      const isAllowedDomain = this.allowedGitLabDomains.some(domain =>
        gitlabInfo.domain.includes(domain)
      );

      if (!isAllowedDomain) {
        return {
          allowed: false,
          reason: `GitLab域名 "${gitlabInfo.domain}" 不在允许列表中。允许的域名：${this.allowedGitLabDomains.join(', ')}`,
          gitlabUrl: gitInfo.remoteUrl,
        };
      }
    }

    // 5. 检查服务器是否已有该GitLab仓库的索引（通过GitLab URL精确匹配）
    if (this.apiService) {
      try {
        const checkResult = await this.apiService.repos.checkByGitLabUrl(gitInfo.remoteUrl);

        if (checkResult.exists && checkResult.repo) {
          // 服务器已有该GitLab仓库的索引，直接允许
          return {
            allowed: true,
            gitlabUrl: gitInfo.remoteUrl,
            projectPath: gitlabInfo.projectPath,
          };
        }
      } catch (error) {
        console.error('[PermissionChecker] Failed to check repo by GitLab URL:', error);
      }

      // 6. 如果GitLab URL没匹配，尝试通过仓库名匹配（去后缀、大小写不敏感）
      try {
        const repoName = gitlabInfo.projectPath.split('/').pop() || '';
        const checkResult = await this.apiService.repos.checkByRepoName(repoName);

        if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
          // 服务器已有同名仓库索引，允许增量索引
          return {
            allowed: true,
            gitlabUrl: gitInfo.remoteUrl,
            projectPath: gitlabInfo.projectPath,
          };
        }
      } catch (error) {
        console.error('[PermissionChecker] Failed to check repo by name:', error);
      }

      // 7. 尝试通过文件夹名称匹配
      try {
        const folderName = workspaceFolder.name;
        const checkResult = await this.apiService.repos.checkByRepoName(folderName);

        if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
          // 服务器已有同名仓库索引，允许增量索引
          return {
            allowed: true,
            gitlabUrl: gitInfo.remoteUrl,
            projectPath: gitlabInfo.projectPath,
          };
        }
      } catch (error) {
        console.error('[PermissionChecker] Failed to check repo by folder name:', error);
      }
    }

    // 8. 服务器没有匹配的仓库，拒绝索引
    return {
      allowed: false,
      reason: `服务器上没有该仓库的索引。GitLab URL: ${gitInfo.remoteUrl}，请先在服务器上创建索引。`,
    };
  }

  /**
   * 获取Git仓库信息
   */
  private async getGitInfo(workspacePath: string): Promise<{
    isGitRepo: boolean;
    remoteUrl?: string;
  }> {
    try {
      // 检查是否为Git仓库
      await execAsync('git rev-parse --git-dir', { cwd: workspacePath });

      // 获取远程仓库URL
      const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
      const remoteUrl = stdout.trim();

      return {
        isGitRepo: true,
        remoteUrl: remoteUrl || undefined,
      };
    } catch (error) {
      return {
        isGitRepo: false,
      };
    }
  }

  /**
   * 解析GitLab URL
   */
  private parseGitLabUrl(remoteUrl: string): {
    domain: string;
    projectPath: string;
  } | null {
    // 支持HTTPS和SSH格式
    // HTTPS: https://gitlab.com/group/project.git
    // SSH: git@gitlab.com:group/project.git

    let domain = '';
    let projectPath = '';

    // HTTPS格式
    const httpsMatch = remoteUrl.match(/https?:\/\/([^\/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      domain = httpsMatch[1];
      projectPath = httpsMatch[2];
    } else {
      // SSH格式
      const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
      if (sshMatch) {
        domain = sshMatch[1];
        projectPath = sshMatch[2];
      }
    }

    if (!domain || !projectPath) {
      return null;
    }

    // 检查是否为GitLab（域名包含gitlab）
    if (!domain.toLowerCase().includes('gitlab')) {
      return null;
    }

    return { domain, projectPath };
  }

  /**
   * 检查工作区是否在允许列表中
   */
  isWorkspaceAllowed(workspaceUri: string): boolean {
    const config = vscode.workspace.getConfiguration('codelens');
    const allowedWorkspaces = config.get<string[]>('allowedWorkspaces', []);
    return allowedWorkspaces.includes(workspaceUri);
  }
}
