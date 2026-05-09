import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import archiver from 'archiver';
import { APIService } from '../api';
import { RepoRegistry } from '../state';
import { PermissionChecker } from '../utils/permissionChecker';

export class WorkspaceIndexer {
  private permissionChecker: PermissionChecker;

  constructor(
    private apiService: APIService,
    private repoRegistry: RepoRegistry,
    private statusBarItem: vscode.StatusBarItem
  ) {
    this.permissionChecker = new PermissionChecker();
  }

  async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();

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
    const repoId = this.repoRegistry.getRepoId(workspaceUri);

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
