import * as vscode from 'vscode';
import { APIService } from './api';
import { RepoRegistry, SearchCache } from './state';
import { WorkspaceIndexer, FileWatcher } from './indexing';
import { CodeLensCodeLensProvider, CodeLensHoverProvider } from './providers';
import { SearchTreeDataProvider, QAWebviewPanel, CallGraphWebviewPanel, RepoTreeDataProvider } from './views';
import { registerIndexingCommands, registerSearchCommands, registerQACommands } from './commands';
import { getEnterpriseConfig } from './config/enterprise';

let fileWatcher: FileWatcher | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[CodeLens] Extension activating...');

  // Use enterprise configuration
  const enterpriseConfig = getEnterpriseConfig();
  const apiUrl = enterpriseConfig.defaultApiUrl;

  // Initialize API service
  const apiService = new APIService(apiUrl);

  // Check API health
  const isHealthy = await apiService.healthCheck();
  if (!isHealthy) {
    vscode.window.showWarningMessage(
      'CodeLens API服务器无法访问。请联系管理员检查服务器状态。',
      '确定'
    ).then(() => {
    });
  }

  // Initialize state management
  const repoRegistry = new RepoRegistry(context);
  const searchCache = new SearchCache();

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

  // Initialize providers
  const codeLensProvider = new CodeLensCodeLensProvider(apiService, repoRegistry);
  const hoverProvider = new CodeLensHoverProvider(apiService, repoRegistry, searchCache);

  // Register providers (only for frontend languages)
  const supportedLanguages = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'vue' },
  ];

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(supportedLanguages, codeLensProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(supportedLanguages, hoverProvider)
  );

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
  registerQACommands(context, qaWebviewPanel, callGraphWebviewPanel);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codelens.enableCodeLens')) {
        codeLensProvider.refresh();
      }
    })
  );

  // Auto-index workspace if enabled
  const config = vscode.workspace.getConfiguration('codelens');
  const autoIndex = config.get<boolean>('autoIndex', true);
  if (autoIndex && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    const repoInfo = repoRegistry.getRepoInfo(workspaceFolder.uri.toString());

    if (!repoInfo) {
      // Workspace not indexed yet, ask user
      const action = await vscode.window.showInformationMessage(
        '是否为此工作区建立智能代码搜索索引？',
        '立即索引',
        '暂不索引',
        '不再提示'
      );

      if (action === '立即索引') {
        await workspaceIndexer.indexWorkspace(workspaceFolder);
      } else if (action === '不再提示') {
        // Mark as indexed with a dummy repo to prevent future prompts
        repoRegistry.registerRepo(workspaceFolder.uri.toString(), -1, workspaceFolder.name);
        repoRegistry.updateStatus(workspaceFolder.uri.toString(), 'failed');
      }
    } else if (repoInfo.status === 'ready') {
      statusBarItem.text = '$(check) CodeLens: 就绪';
      statusBarItem.show();
      setTimeout(() => statusBarItem.hide(), 3000);
    } else if (repoInfo.status === 'indexing') {
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
