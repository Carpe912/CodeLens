import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import archiver from 'archiver';
import { APIService } from '../api';
import { RepoRegistry } from '../state';
import { PermissionChecker } from '../utils/permissionChecker';
import { getGitRemoteUrl, getCurrentBranch } from '../utils/gitlabHelper';

export class WorkspaceIndexer {
  private permissionChecker: PermissionChecker;

  constructor(
    private apiService: APIService,
    private repoRegistry: RepoRegistry,
    private statusBarItem: vscode.StatusBarItem
  ) {
    this.permissionChecker = new PermissionChecker(apiService);
  }

  async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();
    const workspacePath = workspaceFolder.uri.fsPath;

    // Check permission first
    const config = vscode.workspace.getConfiguration('codelens');
    const enablePermissionCheck = config.get<boolean>('enablePermissionCheck', true);

    if (enablePermissionCheck) {
      // Check if workspace is in allowed list
      if (!this.permissionChecker.isWorkspaceAllowed(workspaceUri)) {
        // Perform permission check
        const permissionResult = await this.permissionChecker.checkWorkspacePermission(workspaceFolder);

        if (!permissionResult.allowed) {
          vscode.window.showErrorMessage(
            `无法索引工作区: ${permissionResult.reason || '权限被拒绝'}`,
            '查看设置'
          ).then((action) => {
            if (action === '查看设置') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'codelens');
            }
          });
          return;
        }

        // Show permission info if GitLab project
        if (permissionResult.gitlabUrl) {
          vscode.window.showInformationMessage(
            `已验证权限: ${permissionResult.projectPath || permissionResult.gitlabUrl}`
          );
        }
      }
    }

    // Try to get GitLab URL
    const gitlabUrl = await getGitRemoteUrl(workspacePath);

    if (gitlabUrl) {
      // GitLab repository - use multi-branch indexing
      await this.indexFromGitLab(workspaceFolder, gitlabUrl);
    } else {
      // Non-GitLab repository - use ZIP upload
      await this.indexFromZip(workspaceFolder);
    }
  }

  /**
   * 从GitLab索引（支持多分支）
   */
  private async indexFromGitLab(workspaceFolder: vscode.WorkspaceFolder, gitlabUrl: string): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();
    const workspacePath = workspaceFolder.uri.fsPath;
    const config = vscode.workspace.getConfiguration('codelens');
    const gitlabToken = config.get<string>('gitlabToken');

    try {
      // 获取当前分支
      const currentBranch = await getCurrentBranch(workspacePath);
      console.log(`[WorkspaceIndexer] Current branch: ${currentBranch}`);

      // 检查后端是否已索引
      const checkResult = await this.apiService.repos.checkByGitLabUrl(gitlabUrl, currentBranch);

      if (checkResult.exists && checkResult.repo) {
        // 当前分支已索引
        const repo = checkResult.repo;
        this.repoRegistry.registerRepo(workspaceUri, repo.id, repo.name);

        if (repo.status === 'ready') {
          vscode.window.showInformationMessage(
            `分支 "${currentBranch}" 已索引，可直接使用`
          );
          this.repoRegistry.updateStatus(workspaceUri, 'ready');
          this.statusBarItem.text = '$(check) CodeLens: 就绪';
          setTimeout(() => this.statusBarItem.hide(), 3000);
        } else if (repo.status === 'indexing') {
          vscode.window.showInformationMessage(
            `分支 "${currentBranch}" 正在索引中，请稍候...`
          );
          await this.monitorProgress(repo.id, workspaceUri);
        }
        return;
      }

      if (checkResult.hasBaseBranch && checkResult.baseBranch) {
        // 基础分支已索引，询问是否为当前分支创建索引
        const baseBranch = checkResult.baseBranch;
        const action = await vscode.window.showInformationMessage(
          `检测到基础分支 "${baseBranch.branch}" 已索引。`,
          `使用基础分支索引`,
          `为 "${currentBranch}" 创建独立索引`,
          '取消'
        );

        if (action === '使用基础分支索引') {
          // 使用基础分支索引
          this.repoRegistry.registerRepo(workspaceUri, baseBranch.id, baseBranch.name);
          this.repoRegistry.updateStatus(workspaceUri, 'ready');
          this.statusBarItem.text = '$(check) CodeLens: 就绪';
          vscode.window.showInformationMessage(`已使用基础分支 "${baseBranch.branch}" 的索引`);
          setTimeout(() => this.statusBarItem.hide(), 3000);
        } else if (action === `为 "${currentBranch}" 创建独立索引`) {
          // 创建分支索引
          await this.createBranchIndex(workspaceFolder, gitlabUrl, currentBranch, gitlabToken);
        }
        return;
      }

      // 没有任何索引，询问是否创建基础分支索引
      const action = await vscode.window.showInformationMessage(
        `此仓库尚未索引。是否从GitLab克隆默认分支并索引？\n（其他用户将共享此索引）`,
        '是',
        '否'
      );

      if (action === '是') {
        await this.createBaseBranchIndex(workspaceFolder, gitlabUrl, gitlabToken);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`从GitLab索引失败: ${error.message}`);
    }
  }

  /**
   * 创建基础分支索引
   */
  private async createBaseBranchIndex(
    workspaceFolder: vscode.WorkspaceFolder,
    gitlabUrl: string,
    gitlabToken?: string
  ): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();

    try {
      this.statusBarItem.text = '$(sync~spin) CodeLens: 创建基础分支索引...';
      this.statusBarItem.show();

      const result = await this.apiService.repos.createFromGitLab(gitlabUrl, gitlabToken);

      this.repoRegistry.registerRepo(workspaceUri, result.repoId, workspaceFolder.name);

      vscode.window.showInformationMessage(
        `正在索引基础分支 "${result.branch}"，这可能需要几分钟...`
      );

      await this.monitorProgress(result.repoId, workspaceUri);

      // 索引完成后，询问是否为当前分支创建索引
      const workspacePath = workspaceFolder.uri.fsPath;
      const currentBranch = await getCurrentBranch(workspacePath);

      if (currentBranch !== result.branch) {
        const action = await vscode.window.showInformationMessage(
          `基础分支 "${result.branch}" 索引完成。是否为当前分支 "${currentBranch}" 创建独立索引？`,
          '是',
          '否'
        );

        if (action === '是') {
          await this.createBranchIndex(workspaceFolder, gitlabUrl, currentBranch, gitlabToken);
        }
      }
    } catch (error: any) {
      this.statusBarItem.text = '$(error) CodeLens: 索引失败';
      vscode.window.showErrorMessage(`创建基础分支索引失败: ${error.message}`);
      setTimeout(() => this.statusBarItem.hide(), 5000);
    }
  }

  /**
   * 创建分支索引
   */
  private async createBranchIndex(
    workspaceFolder: vscode.WorkspaceFolder,
    gitlabUrl: string,
    branch: string,
    gitlabToken?: string
  ): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();

    try {
      this.statusBarItem.text = `$(sync~spin) CodeLens: 创建分支 "${branch}" 索引...`;
      this.statusBarItem.show();

      const result = await this.apiService.repos.createBranchIndex(gitlabUrl, branch, gitlabToken);

      this.repoRegistry.registerRepo(workspaceUri, result.repoId, workspaceFolder.name);

      vscode.window.showInformationMessage(
        `正在为分支 "${branch}" 创建索引（仅索引与 "${result.baseBranch}" 的差异）...`
      );

      await this.monitorProgress(result.repoId, workspaceUri);
    } catch (error: any) {
      this.statusBarItem.text = '$(error) CodeLens: 索引失败';
      vscode.window.showErrorMessage(`创建分支索引失败: ${error.message}`);
      setTimeout(() => this.statusBarItem.hide(), 5000);
    }
  }

  /**
   * 从ZIP索引（非GitLab仓库）
   */
  private async indexFromZip(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();

    // Check if already indexed
    const existingRepoInfo = this.repoRegistry.getRepoInfo(workspaceUri);
    if (existingRepoInfo) {
      if (existingRepoInfo.status === 'ready') {
        const action = await vscode.window.showInformationMessage(
          '工作区已索引',
          '重新索引',
          '取消'
        );
        if (action === '重新索引') {
          await this.reindexWorkspace(workspaceFolder);
        }
        return;
      } else if (existingRepoInfo.status === 'indexing') {
        vscode.window.showInformationMessage('工作区正在索引中');
        return;
      }
    }

    try {
      // Create ZIP of workspace
      this.statusBarItem.text = '$(sync~spin) CodeLens: 创建压缩包...';
      this.statusBarItem.show();

      const zipPath = await this.createWorkspaceZip(workspaceFolder);

      // Upload ZIP
      this.statusBarItem.text = '$(sync~spin) CodeLens: 上传中...';
      const { repoId } = await this.apiService.repos.uploadZip(zipPath);

      // Register in state
      this.repoRegistry.registerRepo(workspaceUri, repoId, workspaceFolder.name);

      // Clean up ZIP file
      fs.unlinkSync(zipPath);

      // Monitor progress
      await this.monitorProgress(repoId, workspaceUri);
    } catch (error: any) {
      this.statusBarItem.text = '$(error) CodeLens: 索引失败';
      vscode.window.showErrorMessage(`索引工作区失败: ${error.message}`);
      this.repoRegistry.updateStatus(workspaceUri, 'failed');
      setTimeout(() => this.statusBarItem.hide(), 5000);
    }
  }

  async reindexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();
    let repoId = this.repoRegistry.getRepoId(workspaceUri);

    if (!repoId) {
      repoId = await this.restoreRepoFromServer(workspaceFolder);
    }

    if (!repoId) {
      vscode.window.showErrorMessage('工作区尚未索引');
      return;
    }

    try {
      this.repoRegistry.updateStatus(workspaceUri, 'indexing');
      await this.apiService.repos.reindex(repoId);
      await this.monitorProgress(repoId, workspaceUri);
    } catch (error: any) {
      vscode.window.showErrorMessage(`重新索引工作区失败: ${error.message}`);
      this.repoRegistry.updateStatus(workspaceUri, 'failed');
    }
  }

  /**
   * 增量索引（手动触发）
   */
  async incrementalIndex(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();
    const workspacePath = workspaceFolder.uri.fsPath;
    let repoId = this.repoRegistry.getRepoId(workspaceUri);

    if (!repoId) {
      repoId = await this.restoreRepoFromServer(workspaceFolder);
    }

    if (!repoId) {
      vscode.window.showErrorMessage('工作区尚未索引，请先索引工作区');
      return;
    }

    try {
      // 获取Git远程URL
      const gitlabUrl = await getGitRemoteUrl(workspacePath);

      if (!gitlabUrl) {
        vscode.window.showErrorMessage('无法获取Git远程仓库地址，增量索引仅支持GitLab仓库');
        return;
      }

      // 获取当前分支
      const currentBranch = await getCurrentBranch(workspacePath);

      // 检查是否有基础分支
      const checkResult = await this.apiService.repos.checkByGitLabUrl(gitlabUrl);

      if (!checkResult.hasBaseBranch || !checkResult.baseBranch) {
        vscode.window.showErrorMessage('未找到基础分支索引，无法进行增量索引');
        return;
      }

      const baseBranch = checkResult.baseBranch.branch;

      // 获取差异文件
      this.statusBarItem.text = '$(sync~spin) CodeLens: 检测变更文件...';
      this.statusBarItem.show();

      const { getDiffFromBaseBranch } = await import('../utils/gitlabHelper');
      const changedFiles = await getDiffFromBaseBranch(workspacePath, baseBranch);

      if (changedFiles.length === 0) {
        vscode.window.showInformationMessage(`当前分支 "${currentBranch}" 与基础分支 "${baseBranch}" 无差异`);
        this.statusBarItem.hide();
        return;
      }

      // 询问用户是否继续
      const action = await vscode.window.showInformationMessage(
        `检测到 ${changedFiles.length} 个变更文件。是否进行增量索引？`,
        '是',
        '否'
      );

      if (action !== '是') {
        this.statusBarItem.hide();
        return;
      }

      // 执行增量索引
      this.statusBarItem.text = `$(sync~spin) CodeLens: 增量索引 ${changedFiles.length} 个文件...`;

      await this.apiService.repos.incrementalIndex(repoId, changedFiles);

      this.statusBarItem.text = '$(check) CodeLens: 增量索引完成';
      vscode.window.showInformationMessage(`增量索引完成，已更新 ${changedFiles.length} 个文件`);

      setTimeout(() => this.statusBarItem.hide(), 3000);
    } catch (error: any) {
      this.statusBarItem.text = '$(error) CodeLens: 增量索引失败';
      vscode.window.showErrorMessage(`增量索引失败: ${error.message}`);
      setTimeout(() => this.statusBarItem.hide(), 5000);
    }
  }

  private async restoreRepoFromServer(workspaceFolder: vscode.WorkspaceFolder): Promise<number | undefined> {
    const workspaceUri = workspaceFolder.uri.toString();
    const workspacePath = workspaceFolder.uri.fsPath;
    const candidateNames = Array.from(new Set([
      workspaceFolder.name,
      path.basename(workspacePath),
    ].filter(Boolean)));

    const gitlabUrl = await getGitRemoteUrl(workspacePath);
    if (gitlabUrl) {
      try {
        const currentBranch = await getCurrentBranch(workspacePath);
        const checkResult = await this.apiService.repos.checkByGitLabUrl(gitlabUrl, currentBranch);

        if (checkResult.exists && checkResult.repo) {
          const repo = checkResult.repo;
          this.repoRegistry.registerRepo(workspaceUri, repo.id, repo.name);
          this.repoRegistry.updateStatus(workspaceUri, repo.status === 'ready' ? 'ready' : 'indexing');
          return repo.id;
        }
      } catch (error) {
        console.error('[WorkspaceIndexer] Failed to restore GitLab repo from server:', error);
      }
    }

    for (const candidate of candidateNames) {
      try {
        const checkResult = await this.apiService.repos.checkByRepoName(candidate);
        if (checkResult.exists && checkResult.repos && checkResult.repos.length > 0) {
          const repo = checkResult.repos[0];
          this.repoRegistry.registerRepo(workspaceUri, repo.id, repo.name || candidate);
          this.repoRegistry.updateStatus(workspaceUri, repo.status === 'ready' ? 'ready' : 'indexing');
          return repo.id;
        }
      } catch (error) {
        console.error('[WorkspaceIndexer] Failed to restore repo from server by name:', error);
      }
    }

    return undefined;
  }

  private async createWorkspaceZip(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const workspacePath = workspaceFolder.uri.fsPath;
    const zipPath = path.join('/tmp', `codelens-${Date.now()}-${workspaceFolder.name}.zip`);

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve(zipPath));
      archive.on('error', (err: Error) => reject(err));

      archive.pipe(output);

      // Add files to archive, excluding common directories
      const excludePatterns = [
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        'coverage',
        '.vscode',
        '.idea',
        '*.log',
        '.DS_Store',
      ];

      const shouldExclude = (filePath: string): boolean => {
        const relativePath = path.relative(workspacePath, filePath);
        return excludePatterns.some((pattern) => {
          if (pattern.includes('*')) {
            return relativePath.includes(pattern.replace('*', ''));
          }
          return relativePath.split(path.sep).includes(pattern);
        });
      };

      const addDirectory = (dirPath: string) => {
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);

          if (shouldExclude(filePath)) {
            continue;
          }

          if (stat.isDirectory()) {
            addDirectory(filePath);
          } else if (stat.isFile()) {
            const relativePath = path.relative(workspacePath, filePath);
            archive.file(filePath, { name: relativePath });
          }
        }
      };

      addDirectory(workspacePath);
      archive.finalize();
    });
  }

  private async monitorProgress(repoId: number, workspaceUri: string): Promise<void> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在索引工作区',
        cancellable: false,
      },
      async (progress) => {
        let lastPercent = 0;

        while (true) {
          try {
            const progressData = await this.apiService.repos.getProgress(repoId);

            if (progressData.status === 'ready') {
              this.repoRegistry.updateStatus(workspaceUri, 'ready');
              this.statusBarItem.text = '$(check) CodeLens: 就绪';
              vscode.window.showInformationMessage('工作区索引完成！');
              setTimeout(() => this.statusBarItem.hide(), 3000);
              break;
            }

            if (progressData.status === 'failed') {
              this.repoRegistry.updateStatus(workspaceUri, 'failed');
              this.statusBarItem.text = '$(error) CodeLens: 失败';
              vscode.window.showErrorMessage('工作区索引失败');
              setTimeout(() => this.statusBarItem.hide(), 5000);
              break;
            }

            if (progressData.progress) {
              const percent = progressData.progress.percentComplete;
              const increment = percent - lastPercent;
              lastPercent = percent;

              const phase = progressData.progress.phase || 'basic';
              const phaseText = phase === 'basic' ? '基础' : '增强';
              progress.report({
                message: `${percent.toFixed(0)}% 完成（${phaseText}阶段）`,
                increment,
              });

              this.statusBarItem.text = `$(sync~spin) CodeLens: 索引中 ${percent.toFixed(0)}%`;
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error: any) {
            vscode.window.showErrorMessage(`监控进度时出错: ${error.message}`);
            break;
          }
        }
      }
    );
  }
}
