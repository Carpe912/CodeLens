import * as vscode from 'vscode';
import { APIService } from '../api';
import { RepoRegistry, SearchCache } from '../state';
import { SearchTreeDataProvider } from '../views';

export function registerSearchCommands(
  context: vscode.ExtensionContext,
  apiService: APIService,
  repoRegistry: RepoRegistry,
  searchCache: SearchCache,
  searchTreeDataProvider: SearchTreeDataProvider
) {
  // Search command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.search', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('未打开工作区文件夹');
        return;
      }

      const repoInfo = repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
      if (!repoInfo) {
        vscode.window.showErrorMessage('工作区尚未索引。请先索引工作区。');
        return;
      }

      if (repoInfo.status !== 'ready') {
        vscode.window.showErrorMessage(`工作区状态为 ${repoInfo.status}。请等待索引完成。`);
        return;
      }

      const query = await vscode.window.showInputBox({
        prompt: '输入搜索关键词',
        placeHolder: '例如：authentication, handleLogin, UserService',
      });

      if (!query) {
        return;
      }

      try {
        // Check cache first
        const cacheKey = searchCache.generateKey(repoInfo.repoId, query);
        let results = searchCache.get<any[]>(cacheKey);

        if (!results) {
          // Perform search
          results = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: '搜索中...',
              cancellable: false,
            },
            async () => {
              return await apiService.search.search(repoInfo.repoId, query);
            }
          );

          // Cache results
          searchCache.set(cacheKey, results);
        }

        // Update tree view
        searchTreeDataProvider.setResults(query, results);

        if (results.length === 0) {
          vscode.window.showInformationMessage('未找到结果');
        } else {
          vscode.window.showInformationMessage(`找到 ${results.length} 个结果`);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`搜索失败: ${error.message}`);
      }
    })
  );

  // Refresh search command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.refreshSearch', () => {
      searchTreeDataProvider.refresh();
    })
  );

  // Open file command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.openFile', async (filePath: string, lineNumber: number) => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          return;
        }

        const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);

        const position = new vscode.Position(Math.max(0, lineNumber - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (error: any) {
        vscode.window.showErrorMessage(`打开文件失败: ${error.message}`);
      }
    })
  );

  // Show references command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codelens.showReferences',
      async (uri: vscode.Uri, position: vscode.Position, references: any[]) => {
        // Convert references to locations
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          return;
        }

        const locations: vscode.Location[] = references.map((ref) => {
          const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ref.filePath);
          const pos = new vscode.Position(ref.lineStart - 1, 0);
          return new vscode.Location(fileUri, pos);
        });

        // Show references
        await vscode.commands.executeCommand('editor.action.showReferences', uri, position, locations);
      }
    )
  );
}
