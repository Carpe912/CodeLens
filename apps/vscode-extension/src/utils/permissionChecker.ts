import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  gitlabUrl?: string;
  projectPath?: string;
}

export class PermissionChecker {
  private allowedGitLabDomains: string[];
  private gitlabToken?: string;

  constructor() {
    const config = vscode.workspace.getConfiguration('codelens');
    this.allowedGitLabDomains = config.get<string[]>('allowedGitLabDomains', []);
    this.gitlabToken = config.get<string>('gitlabToken');
  }

  /**
   * 检查工作区是否有索引权限
   */
  async checkWorkspacePermission(workspaceFolder: vscode.WorkspaceFolder): Promise<PermissionCheckResult> {
    // 1. 检查是否为Git仓库
    const gitInfo = await this.getGitInfo(workspaceFolder.uri.fsPath);
    if (!gitInfo.isGitRepo) {
      // 非Git仓库，询问用户是否允许索引
      return await this.askUserPermission(workspaceFolder, 'non-git');
    }

    // 2. 检查是否为GitLab仓库
    if (!gitInfo.remoteUrl) {
      // 本地Git仓库，无远程地址
      return await this.askUserPermission(workspaceFolder, 'local-git');
    }

    // 3. 解析GitLab URL
    const gitlabInfo = this.parseGitLabUrl(gitInfo.remoteUrl);
    if (!gitlabInfo) {
      // 非GitLab仓库（可能是GitHub等）
      return await this.askUserPermission(workspaceFolder, 'non-gitlab');
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

    // 5. 如果配置了GitLab Token，验证用户是否有该仓库的访问权限
    if (this.gitlabToken) {
      const hasAccess = await this.checkGitLabAccess(gitlabInfo);
      if (!hasAccess) {
        return {
          allowed: false,
          reason: `您没有访问 GitLab 项目 "${gitlabInfo.projectPath}" 的权限`,
          gitlabUrl: gitInfo.remoteUrl,
          projectPath: gitlabInfo.projectPath,
        };
      }
    }

    // 6. 所有检查通过
    return {
      allowed: true,
      gitlabUrl: gitInfo.remoteUrl,
      projectPath: gitlabInfo.projectPath,
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
   * 检查用户是否有GitLab项目访问权限
   */
  private async checkGitLabAccess(gitlabInfo: {
    domain: string;
    projectPath: string;
  }): Promise<boolean> {
    if (!this.gitlabToken) {
      return true; // 没有配置token，跳过检查
    }

    try {
      // 使用GitLab API检查项目访问权限
      const encodedPath = encodeURIComponent(gitlabInfo.projectPath);
      const apiUrl = `https://${gitlabInfo.domain}/api/v4/projects/${encodedPath}`;

      const response = await fetch(apiUrl, {
        headers: {
          'PRIVATE-TOKEN': this.gitlabToken,
        },
      });

      // 200: 有权限访问
      // 404: 项目不存在或无权限
      // 401: Token无效
      return response.ok;
    } catch (error) {
      console.error('[PermissionChecker] Failed to check GitLab access:', error);
      return false;
    }
  }

  /**
   * 询问用户是否允许索引
   */
  private async askUserPermission(
    workspaceFolder: vscode.WorkspaceFolder,
    reason: 'non-git' | 'local-git' | 'non-gitlab'
  ): Promise<PermissionCheckResult> {
    let message = '';

    switch (reason) {
      case 'non-git':
        message = `"${workspaceFolder.name}" 不是Git仓库。是否允许索引此工作区？`;
        break;
      case 'local-git':
        message = `"${workspaceFolder.name}" 是本地Git仓库（无远程地址）。是否允许索引？`;
        break;
      case 'non-gitlab':
        message = `"${workspaceFolder.name}" 不是GitLab仓库。是否允许索引？`;
        break;
    }

    const action = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      '允许',
      '拒绝',
      '总是允许此工作区'
    );

    if (action === '允许') {
      return { allowed: true };
    } else if (action === '总是允许此工作区') {
      // 保存到工作区设置
      await this.addToAllowedWorkspaces(workspaceFolder.uri.toString());
      return { allowed: true };
    } else {
      return {
        allowed: false,
        reason: '用户拒绝索引此工作区',
      };
    }
  }

  /**
   * 添加到允许的工作区列表
   */
  private async addToAllowedWorkspaces(workspaceUri: string) {
    const config = vscode.workspace.getConfiguration('codelens');
    const allowedWorkspaces = config.get<string[]>('allowedWorkspaces', []);

    if (!allowedWorkspaces.includes(workspaceUri)) {
      allowedWorkspaces.push(workspaceUri);
      await config.update('allowedWorkspaces', allowedWorkspaces, vscode.ConfigurationTarget.Global);
    }
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
