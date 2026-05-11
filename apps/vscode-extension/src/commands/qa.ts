import * as vscode from 'vscode';
import { QAWebviewPanel, CallGraphWebviewPanel } from '../views';
import { RepoRegistry } from '../state';

export function registerQACommands(
  context: vscode.ExtensionContext,
  qaWebviewPanel: QAWebviewPanel,
  callGraphWebviewPanel: CallGraphWebviewPanel,
  repoRegistry: RepoRegistry
) {
  // Ask AI command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.askAI', () => {
      // Check if workspace is indexed
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未打开工作区文件夹');
        return;
      }

      const workspaceUri = workspaceFolder.uri.toString();
      const repoInfo = repoRegistry.getRepoInfo(workspaceUri);

      if (!repoInfo) {
        vscode.window.showErrorMessage('工作区尚未索引。请先索引工作区。');
        return;
      }

      if (repoInfo.status !== 'ready') {
        vscode.window.showErrorMessage(`工作区状态为 ${repoInfo.status}。请等待索引完成。`);
        return;
      }

      // If indexed, show the panel
      qaWebviewPanel.show();
    })
  );

  // Ask about selection command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.askAboutSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('没有活动的编辑器');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showErrorMessage('未选中任何文本');
        return;
      }

      const query = `解释这段代码:\n\n${selection}`;
      qaWebviewPanel.show(query);
    })
  );

  // Show call graph command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.showCallGraph', async (repoId: number, symbolName: string) => {
      await callGraphWebviewPanel.show(repoId, symbolName);
    })
  );
}
