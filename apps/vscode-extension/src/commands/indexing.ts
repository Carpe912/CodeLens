import * as vscode from 'vscode';
import { WorkspaceIndexer } from '../indexing';
import { RepoTreeDataProvider } from '../views';

export function registerIndexingCommands(
  context: vscode.ExtensionContext,
  workspaceIndexer: WorkspaceIndexer,
  repoTreeDataProvider?: RepoTreeDataProvider
) {
  // Index workspace command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.indexWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未打开工作区文件夹');
        return;
      }

      await workspaceIndexer.indexWorkspace(workspaceFolder);
      await repoTreeDataProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.matchWorkspace', async () => {
      if (!repoTreeDataProvider) {
        vscode.window.showWarningMessage('仓库面板未初始化');
        return;
      }

      const result = await repoTreeDataProvider.matchCurrentWorkspace();
      if (result.matched > 0) {
        vscode.window.showInformationMessage(`已匹配到 ${result.matched}/${result.total} 个工作区的远程仓库`);
      } else {
        vscode.window.showWarningMessage('没有找到可匹配的远程仓库');
      }
    })
  );

  // Re-index workspace command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.reindexWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未打开工作区文件夹');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        '这将清除所有已索引数据并重新索引工作区。是否继续？',
        '是',
        '否'
      );

      if (confirm === '是') {
        await workspaceIndexer.reindexWorkspace(workspaceFolder);
        await repoTreeDataProvider?.refresh();
      }
    })
  );

  // Incremental index command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.incrementalIndex', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未打开工作区文件夹');
        return;
      }

      await workspaceIndexer.incrementalIndex(workspaceFolder);
      await repoTreeDataProvider?.refresh();
    })
  );
}
