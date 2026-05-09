import * as vscode from 'vscode';
import { QAWebviewPanel, CallGraphWebviewPanel } from '../views';

export function registerQACommands(
  context: vscode.ExtensionContext,
  qaWebviewPanel: QAWebviewPanel,
  callGraphWebviewPanel: CallGraphWebviewPanel
) {
  // Ask AI command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.askAI', () => {
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
