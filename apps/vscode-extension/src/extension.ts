import * as vscode from 'vscode';
import { APIService } from './api';
import { RepoRegistry, SearchCache, SearchHistory } from './state';
import { WorkspaceIndexer, FileWatcher } from './indexing';
import { SearchTreeDataProvider, QAWebviewPanel, CallGraphWebviewPanel, RepoTreeDataProvider } from './views';
import { registerIndexingCommands, registerSearchCommands, registerQACommands } from './commands';
import { getEnterpriseConfig } from './config/enterprise';

let fileWatcher: FileWatcher | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[CodeLens] Extension activating...');

  // Disable SSL certificate validation for self-signed certificates
  // This is necessary when using IP addresses with SSL certificates issued for domain names
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  // Use enterprise configuration
  const enterpriseConfig = getEnterpriseConfig();
  const apiUrl = enterpriseConfig.defaultApiUrl;

  console.log('[CodeLens] API base URL:', apiUrl);

  // Initialize API service
  const apiService = new APIService(apiUrl);

  // Check API health
  console.log('[CodeLens] Starting health check...');
  const isHealthy = await apiService.healthCheck();
  console.log('[CodeLens] Health check result:', isHealthy);

  if (!isHealthy) {
    const action = await vscode.window.showWarningMessage(
      'CodeLens API服务器无法访问。请检查网络连接或联系管理员。',
      '打开设置',
      '查看日志',
      '忽略'
    );

    if (action === '打开设置') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'codelens.apiUrl');
    } else if (action === '查看日志') {
      vscode.commands.executeCommand('workbench.action.toggleDevTools');
    }
  }

  // Initialize state management
  const repoRegistry = new RepoRegistry(context);
  const searchCache = new SearchCache();
  const searchHistory = new SearchHistory(context);

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  // Initialize indexing
  const workspaceIndexer = new WorkspaceIndexer(apiService, repoRegistry, statusBarItem);

  // Initialize file watcher
  fileWatcher = new FileWatcher(apiService, repoRegistry);
  fileWatcher.start();
  context.subscriptions.push({
    dispose: () => fileWatcher?.dispose(),
  });

  // Initialize views
  const searchTreeDataProvider = new SearchTreeDataProvider();
  const searchTreeView = vscode.window.createTreeView('codelensSearch', {
    treeDataProvider: searchTreeDataProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(searchTreeView);

  const repoTreeDataProvider = new RepoTreeDataProvider(repoRegistry, apiService);
  const repoTreeView = vscode.window.createTreeView('codelensRepos', {
    treeDataProvider: repoTreeDataProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(repoTreeView);
  context.subscriptions.push(
    repoTreeView.onDidChangeVisibility(async (e) => {
      if (e.visible) {
        await repoTreeDataProvider.refresh();
      }
    })
  );

  const qaWebviewPanel = new QAWebviewPanel(context, apiService, repoRegistry);
  const callGraphWebviewPanel = new CallGraphWebviewPanel(context, apiService);

  // Register commands
  registerIndexingCommands(context, workspaceIndexer, repoTreeDataProvider);
  registerSearchCommands(context, apiService, repoRegistry, searchCache, searchTreeDataProvider);
  registerQACommands(context, qaWebviewPanel, callGraphWebviewPanel, repoRegistry);

  // Register refresh repo view command
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.refreshRepoView', async () => {
      await repoTreeDataProvider.refresh();
    })
  );

  // Register command to notify search view when repo becomes ready
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.notifySearchViewRepoReady', () => {
      searchTreeDataProvider.setStatusMessage('✅ 工作区已索引完成，现在可以搜索了！');
    })
  );

  // Auto-index workspace if enabled
  const workspaceConfig = vscode.workspace.getConfiguration('codelens');
  const autoIndex = workspaceConfig.get<boolean>('autoIndex', true);
  if (autoIndex && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const repoInfo = repoRegistry.getRepoInfo(workspaceFolder.uri.toString());

    if (repoInfo && repoInfo.status === 'ready') {
      statusBarItem.text = '$(check) CodeLens: 就绪';
      statusBarItem.show();
      setTimeout(() => statusBarItem.hide(), 3000);
    } else if (repoInfo && repoInfo.status === 'indexing') {
      // Resume monitoring if indexing was in progress
      vscode.window.showInformationMessage('正在恢复工作区索引...');
    }
  }

  console.log('[CodeLens] 扩展激活成功');
}

export function deactivate() {
  console.log('[CodeLens] 扩展停用中...');
  fileWatcher?.dispose();
}
