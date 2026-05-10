import * as vscode from 'vscode';
import { APIService } from '../api';
import { RepoRegistry } from '../state';

export class QAWebviewPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private apiService: APIService,
    private repoRegistry: RepoRegistry
  ) {}

  show(initialQuery?: string) {
    if (this.panel) {
      this.panel.reveal();
      if (initialQuery) {
        this.askQuestion(initialQuery);
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codelensQA',
      'CodeLens Q&A',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getWebviewContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ask':
          await this.handleAskQuestion(message.query, false);
          break;
        case 'analyzeRootCause':
          await this.handleAskQuestion(message.query, true);
          break;
        case 'search':
          await this.handleSearch(message.query);
          break;
        case 'openFile':
          await this.handleOpenFile(message.filePath, message.lineNumber);
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // If initial query provided, ask it
    if (initialQuery) {
      setTimeout(() => this.askQuestion(initialQuery), 500);
    }
  }

  askQuestion(query: string) {
    if (this.panel) {
      this.panel.webview.postMessage({
        command: 'setQuery',
        query,
      });
      this.handleAskQuestion(query, false);
    }
  }

  private async handleAskQuestion(query: string, isRootCause: boolean = false) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: 'No workspace folder open',
      });
      return;
    }

    const repoInfo = this.repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
    if (!repoInfo) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: 'Workspace not indexed. Please index the workspace first.',
      });
      return;
    }

    if (repoInfo.status !== 'ready') {
      this.panel?.webview.postMessage({
        command: 'error',
        message: `Workspace is ${repoInfo.status}. Please wait for indexing to complete.`,
      });
      return;
    }

    // Show loading
    this.panel?.webview.postMessage({ command: 'loading' });

    try {
      const response = isRootCause
        ? await this.apiService.ask.analyzeRootCause(repoInfo.repoId, query)
        : await this.apiService.ask.ask(repoInfo.repoId, query, true);

      this.panel?.webview.postMessage({
        command: 'answer',
        data: response,
        isRootCause,
      });
    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: error.message || 'Failed to get answer',
      });
    }
  }

  private async handleSearch(query: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: 'No workspace folder open',
      });
      return;
    }

    const repoInfo = this.repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
    if (!repoInfo) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: 'Workspace not indexed. Please index the workspace first.',
      });
      return;
    }

    if (repoInfo.status !== 'ready') {
      this.panel?.webview.postMessage({
        command: 'error',
        message: `Workspace is ${repoInfo.status}. Please wait for indexing to complete.`,
      });
      return;
    }

    // Show loading
    this.panel?.webview.postMessage({ command: 'loading' });

    try {
      const response = await this.apiService.search.search(repoInfo.repoId, query);

      this.panel?.webview.postMessage({
        command: 'searchResults',
        data: response,
      });
    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: error.message || 'Failed to search',
      });
    }
  }

  private async handleOpenFile(filePath: string, lineNumber: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

      const position = new vscode.Position(Math.max(0, lineNumber - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
    }
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CodeLens Q&A</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 20px;
          margin: 0;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
        }
        .input-section {
          margin-bottom: 20px;
        }
        textarea {
          width: 100%;
          min-height: 80px;
          padding: 10px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          font-family: var(--vscode-font-family);
          font-size: 14px;
          resize: vertical;
        }
        button {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          margin-top: 10px;
        }
        button:hover {
          background: var(--vscode-button-hoverBackground);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .button-group {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }
        .button-group button {
          flex: 1;
          margin-top: 0;
        }
        button.secondary {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .loading {
          text-align: center;
          padding: 20px;
          color: var(--vscode-descriptionForeground);
        }
        .error {
          background: var(--vscode-inputValidation-errorBackground);
          border: 1px solid var(--vscode-inputValidation-errorBorder);
          color: var(--vscode-inputValidation-errorForeground);
          padding: 12px;
          border-radius: 4px;
          margin: 10px 0;
        }
        .answer-section {
          margin-top: 20px;
        }
        .answer {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          padding: 16px;
          border-radius: 4px;
          margin-bottom: 20px;
        }
        .evidence-section {
          margin-top: 20px;
        }
        .evidence-item {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 10px;
          cursor: pointer;
        }
        .evidence-item:hover {
          border-color: var(--vscode-focusBorder);
        }
        .evidence-header {
          font-weight: bold;
          margin-bottom: 8px;
          color: var(--vscode-textLink-foreground);
        }
        .evidence-code {
          background: var(--vscode-textCodeBlock-background);
          padding: 8px;
          border-radius: 4px;
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
          overflow-x: auto;
          white-space: pre-wrap;
        }
        h3 {
          margin-top: 0;
          color: var(--vscode-foreground);
        }
        .search-results {
          margin-top: 20px;
        }
        .search-result-item {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 10px;
        }
        .result-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .result-number {
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: bold;
        }
        .file-link {
          color: var(--vscode-textLink-foreground);
          text-decoration: none;
          flex: 1;
        }
        .file-link:hover {
          text-decoration: underline;
        }
        .score {
          color: var(--vscode-descriptionForeground);
          font-size: 12px;
        }
        .code-snippet {
          background: var(--vscode-textCodeBlock-background);
          padding: 8px;
          border-radius: 4px;
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
          overflow-x: auto;
          white-space: pre-wrap;
          margin: 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="input-section">
          <h3>Ask a question about your code</h3>
          <textarea id="queryInput" placeholder="e.g., How does authentication work in this codebase?"></textarea>
          <div class="button-group">
            <button id="searchButton" class="secondary">🔎 搜索</button>
            <button id="askButton">💬 普通问答</button>
            <button id="rootCauseButton" class="secondary">🔍 根因分析</button>
          </div>
        </div>
        <div id="resultSection"></div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('queryInput');
        const askButton = document.getElementById('askButton');
        const rootCauseButton = document.getElementById('rootCauseButton');
        const searchButton = document.getElementById('searchButton');
        const resultSection = document.getElementById('resultSection');

        askButton.addEventListener('click', () => {
          const query = queryInput.value.trim();
          if (query) {
            vscode.postMessage({ command: 'ask', query });
          }
        });

        rootCauseButton.addEventListener('click', () => {
          const query = queryInput.value.trim();
          if (query) {
            vscode.postMessage({ command: 'analyzeRootCause', query });
          }
        });

        searchButton.addEventListener('click', () => {
          const query = queryInput.value.trim();
          if (query) {
            vscode.postMessage({ command: 'search', query });
          }
        });

        queryInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            askButton.click();
          }
        });

        window.addEventListener('message', (event) => {
          const message = event.data;

          switch (message.command) {
            case 'setQuery':
              queryInput.value = message.query;
              break;

            case 'loading':
              askButton.disabled = true;
              rootCauseButton.disabled = true;
              searchButton.disabled = true;
              resultSection.innerHTML = '<div class="loading">🤔 Thinking...</div>';
              break;

            case 'error':
              askButton.disabled = false;
              rootCauseButton.disabled = false;
              searchButton.disabled = false;
              resultSection.innerHTML = \`<div class="error">\${message.message}</div>\`;
              break;

            case 'answer':
              askButton.disabled = false;
              rootCauseButton.disabled = false;
              searchButton.disabled = false;
              renderAnswer(message.data, message.isRootCause);
              break;

            case 'searchResults':
              askButton.disabled = false;
              rootCauseButton.disabled = false;
              searchButton.disabled = false;
              renderSearchResults(message.data);
              break;
          }
        });

        function renderAnswer(data, isRootCause) {
          let html = '<div class="answer-section">';

          // Render answer with mode indicator
          html += '<div class="answer">';
          html += isRootCause ? '<h3>🔍 根因分析结果</h3>' : '<h3>💬 回答</h3>';
          html += \`<div>\${escapeHtml(data.answer)}</div>\`;
          html += '</div>';

          // Render evidence
          if (data.evidence && data.evidence.length > 0) {
            html += '<div class="evidence-section">';
            html += \`<h3>证据 (\${data.evidence.length} 个结果)</h3>\`;

            data.evidence.forEach((item, index) => {
              html += \`<div class="evidence-item" onclick="openFile('\${item.filePath}', \${item.lineStart})">\`;
              html += \`<div class="evidence-header">\${item.symbolName} (\${item.symbolType}) - \${item.filePath}:\${item.lineStart}</div>\`;
              html += \`<div class="evidence-code">\${escapeHtml(item.content.substring(0, 200))}\${item.content.length > 200 ? '...' : ''}</div>\`;
              html += '</div>';
            });

            html += '</div>';
          }

          html += '</div>';
          resultSection.innerHTML = html;
        }

        function renderSearchResults(results) {
          let html = '<div class="answer-section">';
          html += '<div class="answer">';
          html += '<h3>🔎 搜索结果</h3>';

          if (results && results.length > 0) {
            html += \`<p>找到 \${results.length} 个结果：</p>\`;
            html += '<div class="evidence-section">';

            results.forEach((item, index) => {
              html += \`<div class="evidence-item" onclick="openFile('\${item.filePath}', \${item.lineStart})">\`;
              html += \`<div class="evidence-header">\${item.symbolName} (\${item.symbolType}) - \${item.filePath}:\${item.lineStart}</div>\`;
              html += \`<div class="evidence-code">\${escapeHtml(item.content.substring(0, 200))}\${item.content.length > 200 ? '...' : ''}</div>\`;
              html += '</div>';
            });

            html += '</div>';
          } else {
            html += '<p>未找到相关结果</p>';
          }

          html += '</div>';
          html += '</div>';
          resultSection.innerHTML = html;
        }

        function openFile(filePath, lineNumber) {
          vscode.postMessage({ command: 'openFile', filePath, lineNumber });
        }

        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
      </script>
    </body>
    </html>`;
  }
}
