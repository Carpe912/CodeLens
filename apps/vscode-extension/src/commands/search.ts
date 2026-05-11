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

      const workspaceUri = workspaceFolder.uri.toString();
      console.log('[Search] Workspace URI:', workspaceUri);
      console.log('[Search] Workspace name:', workspaceFolder.name);

      let repoInfo = repoRegistry.getRepoInfo(workspaceUri);
      console.log('[Search] Repo info from registry:', repoInfo);

      // If not found in registry, try to get from API
      if (!repoInfo) {
        console.log('[Search] Not found in registry, fetching from API...');
        try {
          const remoteRepos = await apiService.repos.listRepos();
          console.log('[Search] Remote repos count:', remoteRepos.length);
          console.log('[Search] Remote repos:', remoteRepos.map((r: any) => ({ id: r.id, name: r.name, status: r.status })));

          // Try to match by folder name
          const folderName = workspaceFolder.name.toLowerCase();
          console.log('[Search] Looking for folder name:', folderName);

          const matchedRepo = remoteRepos.find((repo: any) => {
            const repoNameLower = repo.name.toLowerCase();
            const matches = repoNameLower.includes(folderName) || folderName.includes(repoNameLower);
            console.log(`[Search] Comparing "${repoNameLower}" with "${folderName}": ${matches}`);
            return matches;
          });

          console.log('[Search] Matched repo:', matchedRepo);

          if (matchedRepo) {
            console.log('[Search] Getting progress for repo:', matchedRepo.id);
            const progress = await apiService.repos.getProgress(matchedRepo.id).catch((err) => {
              console.error('[Search] Failed to get progress:', err);
              return null;
            });
            console.log('[Search] Progress data:', progress);

            repoRegistry.registerRepo(workspaceUri, matchedRepo.id, matchedRepo.name, {
              status: progress?.status || matchedRepo.status,
              totalFiles: progress?.progress?.total,
              processedFiles: progress?.progress?.processed,
              percentComplete: progress?.progress?.percentComplete,
            });
            repoInfo = repoRegistry.getRepoInfo(workspaceUri);
            console.log('[Search] Registered repo info:', repoInfo);
          }
        } catch (error) {
          console.error('[Search] Failed to fetch remote repos:', error);
        }
      }

      if (!repoInfo) {
        console.error('[Search] No repo info found after all attempts');
        vscode.window.showErrorMessage('工作区尚未索引。请先索引工作区。');
        return;
      }

      console.log('[Search] Final repo info status:', repoInfo.status);

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

        // Get the actual result count from the tree data provider
        const resultCount = searchTreeDataProvider.getResultCount();

        if (resultCount === 0) {
          vscode.window.showInformationMessage('未找到结果');
        } else {
          vscode.window.showInformationMessage(`找到 ${resultCount} 个结果`);
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

  // Clear search command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.clearSearch', () => {
      searchTreeDataProvider.clear();
      vscode.window.showInformationMessage('已清空搜索结果');
    })
  );

  // Open file command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.openFile', async (filePath: string, lineNumber: number) => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('未打开工作区文件夹');
          return;
        }

        // Remove leading slash if present
        let normalizedPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;

        // Check if the path starts with the workspace folder name (duplicate)
        const workspaceName = workspaceFolder.name;
        if (normalizedPath.startsWith(workspaceName + '/')) {
          normalizedPath = normalizedPath.substring(workspaceName.length + 1);
        }

        const uri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedPath);
        console.log('[OpenFile] Workspace folder:', workspaceFolder.uri.fsPath);
        console.log('[OpenFile] Original path:', filePath);
        console.log('[OpenFile] Normalized path:', normalizedPath);
        console.log('[OpenFile] Final URI:', uri.fsPath);

        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

        const position = new vscode.Position(Math.max(0, lineNumber - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (error: any) {
        console.error('[OpenFile] Error:', error);
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
          const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ref.file_path);
          const pos = new vscode.Position(ref.line_start - 1, 0);
          return new vscode.Location(fileUri, pos);
        });

        // Show references
        await vscode.commands.executeCommand('editor.action.showReferences', uri, position, locations);
      }
    )
  );
}
