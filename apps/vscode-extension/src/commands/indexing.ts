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
