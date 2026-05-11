import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { APIService } from '../api';
import { RepoRegistry } from '../state';

export class QAWebviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private md: MarkdownIt;

  constructor(
    private context: vscode.ExtensionContext,
    private apiService: APIService,
    private repoRegistry: RepoRegistry
  ) {
    // 初始化 markdown-it
    this.md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
    });
  }

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

      // 将 markdown 转换为 HTML
      const answerHtml = this.md.render(response.answer);

      this.panel?.webview.postMessage({
        command: 'answer',
        data: {
          ...response,
          answerHtml, // 添加渲染后的 HTML
        },
        isRootCause,
      });
    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: error.message || 'Failed to get answer',
      });
    }
  }

  private async handleOpenFile(filePath: string, lineNumber: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
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
      console.log('[QAWebview] Opening file:', uri.fsPath);

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

      const position = new vscode.Position(Math.max(0, lineNumber - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (error: any) {
      console.error('[QAWebview] Error opening file:', error);
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
          padding: 0;
          margin: 0;
          height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .container {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .result-section {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        .input-section {
          padding: 16px;
          background: var(--vscode-editor-background);
        }
        .input-container {
          border: 1px solid var(--vscode-panel-border);
          border-radius: 6px;
          background: var(--vscode-input-background);
          transition: border-color 0.2s;
        }
        .input-container.focused {
          border-color: var(--vscode-focusBorder);
        }
        textarea {
          width: 100%;
          min-height: 80px;
          max-height: 200px;
          padding: 12px;
          background: transparent;
          color: var(--vscode-input-foreground);
          border: none;
          font-family: var(--vscode-font-family);
          font-size: 13px;
          resize: vertical;
          box-sizing: border-box;
          outline: none;
        }
        .input-divider {
          height: 1px;
          background: var(--vscode-panel-border);
          opacity: 0.3;
        }
        .input-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 10px;
        }
        .mode-selector {
          display: flex;
          align-items: center;
        }
        .mode-selector label {
          display: none;
        }
        .mode-select {
          background: transparent;
          color: var(--vscode-descriptionForeground);
          border: none;
          padding: 0;
          font-size: 12px;
          cursor: pointer;
          outline: none;
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
        }
        .mode-select:hover {
          color: var(--vscode-foreground);
        }
        .mode-select:focus {
          color: var(--vscode-foreground);
        }
        .submit-button {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          width: 28px;
          height: 28px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background-color 0.2s;
          flex-shrink: 0;
        }
        .submit-button:hover:not(:disabled) {
          background: var(--vscode-button-hoverBackground);
        }
        .submit-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .welcome-message {
          text-align: center;
          padding: 60px 40px;
          color: var(--vscode-descriptionForeground);
        }
        .welcome-message h2 {
          margin: 0 0 12px 0;
          color: var(--vscode-foreground);
          font-size: 20px;
          font-weight: 500;
        }
        .welcome-message p {
          margin: 8px 0;
          font-size: 14px;
          line-height: 1.6;
        }
        .loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          color: var(--vscode-foreground);
        }
        .loading-spinner {
          width: 40px;
          height: 40px;
          margin-bottom: 16px;
          border: 3px solid var(--vscode-panel-border);
          border-top-color: var(--vscode-textLink-foreground);
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .loading-text {
          font-size: 14px;
          font-weight: 500;
          color: var(--vscode-foreground);
          margin-bottom: 8px;
        }
        .loading-hint {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          opacity: 0.8;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        .loading-dots {
          display: inline-block;
          animation: pulse 1.5s ease-in-out infinite;
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
          margin-top: 0;
        }
        .question-section {
          background: transparent;
          border-left: 3px solid var(--vscode-textLink-foreground);
          padding: 12px 16px;
          margin-bottom: 20px;
        }
        .question-header {
          font-size: 11px;
          font-weight: 600;
          color: var(--vscode-descriptionForeground);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }
        .question-text {
          font-size: 14px;
          line-height: 1.6;
          color: var(--vscode-foreground);
          font-weight: 500;
        }
        .answer {
          background: transparent;
          border-left: 3px solid var(--vscode-charts-green);
          padding: 12px 16px;
          margin-bottom: 20px;
        }
        .answer h3 {
          margin: 0 0 12px 0;
          font-size: 11px;
          font-weight: 600;
          color: var(--vscode-descriptionForeground);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .answer-content {
          color: var(--vscode-foreground);
          line-height: 1.6;
        }
        .evidence-section {
          margin-top: 20px;
        }
        .evidence-section h3 {
          margin: 0 0 12px 0;
          font-size: 15px;
          font-weight: 500;
        }
        .evidence-item {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 10px;
          transition: border-color 0.2s;
        }
        .evidence-item:hover {
          border-color: var(--vscode-focusBorder);
        }
        .evidence-header {
          display: flex;
          align-items: center;
          font-weight: 500;
          color: var(--vscode-textLink-foreground);
          font-size: 13px;
          cursor: pointer;
          user-select: none;
        }
        .evidence-toggle {
          margin-right: 8px;
          font-size: 10px;
          transition: transform 0.2s;
        }
        .evidence-item.collapsed .evidence-toggle {
          transform: rotate(0deg);
        }
        .evidence-item.expanded .evidence-toggle {
          transform: rotate(90deg);
        }
        .evidence-content {
          margin-top: 8px;
        }
        .evidence-item.collapsed .evidence-content {
          display: none;
        }
        .evidence-item.expanded .evidence-content {
          display: block;
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
        .evidence-file-link {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
          margin-top: 4px;
          cursor: pointer;
        }
        .evidence-file-link:hover {
          color: var(--vscode-textLink-activeForeground);
          text-decoration: underline;
        }
        .answer-content h1, .answer-content h2, .answer-content h3 {
          margin: 16px 0 8px 0;
          font-weight: 500;
        }
        .answer-content h1 { font-size: 18px; }
        .answer-content h2 { font-size: 16px; }
        .answer-content h3 { font-size: 14px; }
        .answer-content p {
          margin: 8px 0;
          line-height: 1.6;
        }
        .answer-content code {
          background: var(--vscode-textCodeBlock-background);
          padding: 2px 6px;
          border-radius: 3px;
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
        }
        .answer-content pre {
          background: var(--vscode-textCodeBlock-background);
          padding: 12px;
          border-radius: 4px;
          overflow-x: auto;
          margin: 8px 0;
        }
        .answer-content pre code {
          background: none;
          padding: 0;
        }
        .answer-content ul, .answer-content ol {
          margin: 8px 0;
          padding-left: 24px;
        }
        .answer-content li {
          margin: 4px 0;
        }
        .answer-content a {
          color: var(--vscode-textLink-foreground);
          text-decoration: none;
        }
        .answer-content a:hover {
          color: var(--vscode-textLink-activeForeground);
          text-decoration: underline;
        }
        .answer-content strong {
          font-weight: 600;
        }
        .answer-content em {
          font-style: italic;
        }
        .answer-content table {
          border-collapse: collapse;
          width: 100%;
          margin: 12px 0;
          font-size: 13px;
        }
        .answer-content table th,
        .answer-content table td {
          border: 1px solid var(--vscode-panel-border);
          padding: 8px 12px;
          text-align: left;
        }
        .answer-content table th {
          background: var(--vscode-editor-background);
          font-weight: 600;
        }
        .answer-content table tr:nth-child(even) {
          background: var(--vscode-editor-background);
        }
        .answer-content blockquote {
          border-left: 3px solid var(--vscode-panel-border);
          padding-left: 12px;
          margin: 8px 0;
          color: var(--vscode-descriptionForeground);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div id="resultSection" class="result-section">
          <div class="welcome-message">
            <h2>💬 CodeLens AI 问答</h2>
            <p>向 AI 提问关于代码的任何问题</p>
            <p>支持普通问答和根因分析两种模式</p>
          </div>
        </div>
        <div class="input-section">
          <div class="input-container" id="inputContainer">
            <textarea id="queryInput" placeholder="例如：这个项目的认证流程是如何工作的？"></textarea>
            <div class="input-divider"></div>
            <div class="input-actions">
              <div class="mode-selector">
                <label for="modeSelect">模式：</label>
                <select id="modeSelect" class="mode-select">
                  <option value="ask">普通问答</option>
                  <option value="rootCause">根因分析</option>
                </select>
              </div>
              <button class="submit-button" id="submitButton" title="发送 (Ctrl/Cmd + Enter)">
                <span>↑</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <script>
        console.log('[QA] Script started');
        const vscode = acquireVsCodeApi();
        console.log('[QA] VSCode API acquired');

        const queryInput = document.getElementById('queryInput');
        const submitButton = document.getElementById('submitButton');
        const resultSection = document.getElementById('resultSection');
        const modeSelect = document.getElementById('modeSelect');
        const inputContainer = document.getElementById('inputContainer');

        console.log('[QA] Elements:', {
          queryInput: !!queryInput,
          submitButton: !!submitButton,
          resultSection: !!resultSection,
          modeSelect: !!modeSelect,
          inputContainer: !!inputContainer
        });

        // Handle input container focus state
        queryInput.addEventListener('focus', () => {
          inputContainer.classList.add('focused');
        });

        queryInput.addEventListener('blur', () => {
          inputContainer.classList.remove('focused');
        });

        // Submit handler
        function handleSubmit() {
          console.log('[QA] Submit button clicked');
          const query = queryInput.value.trim();
          console.log('[QA] Query:', query);
          console.log('[QA] Button disabled:', submitButton.disabled);

          if (!query) {
            console.log('[QA] Query is empty, ignoring');
            return;
          }

          if (submitButton.disabled) {
            console.log('[QA] Button is disabled, ignoring');
            return;
          }

          const mode = modeSelect.value;
          console.log('[QA] Mode:', mode);

          // Show the question in result section
          const modeLabel = mode === 'ask' ? 'You' : 'You';
          resultSection.innerHTML = '<div class="question-section">' +
            '<div class="question-header">' + modeLabel + '</div>' +
            '<div class="question-text">' + escapeHtml(query) + '</div>' +
            '</div>' +
            '<div class="loading">' +
            '<div class="loading-spinner"></div>' +
            '<div class="loading-text">AI 正在思考<span class="loading-dots">...</span></div>' +
            '<div class="loading-hint">分析代码库并生成回答</div>' +
            '</div>';

          // Clear input and disable button
          queryInput.value = '';
          submitButton.disabled = true;

          console.log('[QA] Sending message to extension');
          if (mode === 'ask') {
            vscode.postMessage({ command: 'ask', query });
          } else {
            vscode.postMessage({ command: 'analyzeRootCause', query });
          }
        }

        submitButton.addEventListener('click', handleSubmit);
        console.log('[QA] Submit button event listener attached');

        // Enter to submit (Ctrl/Cmd + Enter)
        queryInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSubmit();
          }
        });

        window.addEventListener('message', (event) => {
          const message = event.data;
          console.log('[QA] Received message:', message.command);

          switch (message.command) {
            case 'setQuery':
              queryInput.value = message.query;
              break;

            case 'loading':
              submitButton.disabled = true;
              resultSection.innerHTML = '<div class="loading">' +
                '<div class="loading-spinner"></div>' +
                '<div class="loading-text">AI 正在思考<span class="loading-dots">...</span></div>' +
                '<div class="loading-hint">分析代码库并生成回答</div>' +
                '</div>';
              break;

            case 'error':
              console.log('[QA] Error received, re-enabling button');
              submitButton.disabled = false;
              // Keep the question and show error below
              const currentContent = resultSection.innerHTML;
              const questionSection = currentContent.match(/<div class="question-section">[\s\S]*?<\\/div>/);
              let errorHtml = '';
              if (questionSection) {
                errorHtml = questionSection[0];
              }

              // Parse error message to make it more friendly
              let errorMessage = message.message;
              if (errorMessage.includes('502') || errorMessage.includes('Bad Gateway')) {
                errorMessage = '❌ 服务器暂时无法访问，请稍后重试或联系管理员检查服务状态';
              } else if (errorMessage.includes('timeout')) {
                errorMessage = '⏱️ 请求超时，请检查网络连接或稍后重试';
              } else if (errorMessage.includes('404')) {
                errorMessage = '❌ API 接口不存在，请联系管理员';
              } else if (errorMessage.includes('500')) {
                errorMessage = '❌ 服务器内部错误，请联系管理员';
              }

              errorHtml += '<div class="error">' + errorMessage + '</div>';
              resultSection.innerHTML = errorHtml;
              break;

            case 'answer':
              console.log('[QA] Answer received, re-enabling button');
              submitButton.disabled = false;
              renderAnswer(message.data, message.isRootCause);
              break;
          }
        });

        function renderAnswer(data, isRootCause) {
          // Keep the question section that was already rendered
          const currentContent = resultSection.innerHTML;
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = currentContent;
          const questionSection = tempDiv.querySelector('.question-section');

          let html = '';
          if (questionSection) {
            html += questionSection.outerHTML;
          }

          html += '<div class="answer-section">';

          // Render answer with mode indicator
          html += '<div class="answer">';
          html += '<h3>Assistant</h3>';
          // 使用服务端渲染好的 HTML
          html += '<div class="answer-content">' + (data.answerHtml || escapeHtml(data.answer)) + '</div>';
          html += '</div>';

          // Render evidence
          if (data.evidence && data.evidence.length > 0) {
            html += '<div class="evidence-section">';
            html += '<h3>📎 相关代码 (' + data.evidence.length + ')</h3>';

            data.evidence.forEach((item, index) => {
              const itemId = 'evidence-' + index;
              html += '<div class="evidence-item collapsed" id="' + itemId + '">';
              html += '<div class="evidence-header" data-target="' + itemId + '">';
              html += '<span class="evidence-toggle">▶</span>';
              html += '<span>' + escapeHtml(item.symbol_name) + ' (' + escapeHtml(item.symbol_type) + ')</span>';
              html += '</div>';
              html += '<div class="evidence-content">';
              html += '<div class="evidence-code">' + escapeHtml(item.content) + '</div>';
              html += '<div class="evidence-file-link" data-file="' + escapeHtml(item.file_path) + '" data-line="' + item.line_start + '">';
              html += '📄 ' + escapeHtml(item.file_path) + ':' + item.line_start;
              html += '</div>';
              html += '</div>';
              html += '</div>';
            });

            html += '</div>';
          }

          html += '</div>';
          resultSection.innerHTML = html;

          // Add event listeners for evidence items
          document.querySelectorAll('.evidence-header').forEach(header => {
            header.addEventListener('click', function() {
              const targetId = this.getAttribute('data-target');
              const item = document.getElementById(targetId);
              if (item) {
                if (item.classList.contains('collapsed')) {
                  item.classList.remove('collapsed');
                  item.classList.add('expanded');
                } else {
                  item.classList.remove('expanded');
                  item.classList.add('collapsed');
                }
              }
            });
          });

          // Add event listeners for file links
          document.querySelectorAll('.evidence-file-link').forEach(link => {
            link.addEventListener('click', function() {
              const filePath = this.getAttribute('data-file');
              const lineNumber = parseInt(this.getAttribute('data-line'));
              vscode.postMessage({ command: 'openFile', filePath, lineNumber });
            });
          });
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
