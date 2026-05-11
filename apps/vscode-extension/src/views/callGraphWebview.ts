import * as vscode from 'vscode';
import { APIService } from '../api';

export class CallGraphWebviewPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private apiService: APIService
  ) {}

  async show(repoId: number, symbolName: string) {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'codelensCallGraph',
        `Call Graph: ${symbolName}`,
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.webview.html = this.getWebviewContent();

      this.panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
          case 'openFile':
            await this.handleOpenFile(message.filePath, message.lineNumber);
            break;
          case 'loadCallGraph':
            await this.loadCallGraph(message.repoId, message.symbolName);
            break;
        }
      });

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    // Load call graph data
    await this.loadCallGraph(repoId, symbolName);
  }

  private async loadCallGraph(repoId: number, symbolName: string) {
    try {
      this.panel?.webview.postMessage({ command: 'loading' });

      const callGraph = await this.apiService.callGraph.getCallGraph(repoId, symbolName);

      this.panel?.webview.postMessage({
        command: 'renderGraph',
        data: callGraph,
      });
    } catch (error: any) {
      this.panel?.webview.postMessage({
        command: 'error',
        message: error.message || 'Failed to load call graph',
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
      <title>Call Graph</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 0;
          margin: 0;
          overflow: hidden;
        }
        #container {
          width: 100vw;
          height: 100vh;
          display: flex;
          flex-direction: column;
        }
        #graph {
          flex: 1;
          position: relative;
          overflow: auto;
          padding: 20px;
        }
        .loading {
          text-align: center;
          padding: 40px;
          color: var(--vscode-descriptionForeground);
        }
        .error {
          background: var(--vscode-inputValidation-errorBackground);
          border: 1px solid var(--vscode-inputValidation-errorBorder);
          color: var(--vscode-inputValidation-errorForeground);
          padding: 20px;
          margin: 20px;
          border-radius: 4px;
        }
        .graph-container {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 400px;
        }
        .node {
          background: var(--vscode-editor-background);
          border: 2px solid var(--vscode-panel-border);
          border-radius: 8px;
          padding: 12px 16px;
          margin: 10px;
          cursor: pointer;
          display: inline-block;
          transition: all 0.2s;
        }
        .node:hover {
          border-color: var(--vscode-focusBorder);
          transform: scale(1.05);
        }
        .node.target {
          border-color: var(--vscode-textLink-activeForeground);
          background: var(--vscode-textCodeBlock-background);
          font-weight: bold;
        }
        .node.caller {
          border-color: #4CAF50;
        }
        .node.callee {
          border-color: #2196F3;
        }
        .node-name {
          font-weight: 500;
          margin-bottom: 4px;
        }
        .node-info {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
        }
        .section {
          margin: 20px;
        }
        .section-title {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 12px;
          color: var(--vscode-foreground);
        }
        .nodes-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 10px;
        }
        .legend {
          padding: 16px;
          background: var(--vscode-textCodeBlock-background);
          border-bottom: 1px solid var(--vscode-panel-border);
          display: flex;
          gap: 20px;
          align-items: center;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
        }
        .legend-box {
          width: 16px;
          height: 16px;
          border-radius: 4px;
          border: 2px solid;
        }
      </style>
    </head>
    <body>
      <div id="container">
        <div class="legend">
          <div class="legend-item">
            <div class="legend-box" style="border-color: var(--vscode-textLink-activeForeground);"></div>
            <span>Target Function</span>
          </div>
          <div class="legend-item">
            <div class="legend-box" style="border-color: #4CAF50;"></div>
            <span>Called By (Callers)</span>
          </div>
          <div class="legend-item">
            <div class="legend-box" style="border-color: #2196F3;"></div>
            <span>Calls (Callees)</span>
          </div>
        </div>
        <div id="graph">
          <div class="loading">Loading call graph...</div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        const graphContainer = document.getElementById('graph');

        window.addEventListener('message', (event) => {
          const message = event.data;

          switch (message.command) {
            case 'loading':
              graphContainer.innerHTML = '<div class="loading">🔄 Loading call graph...</div>';
              break;

            case 'error':
              graphContainer.innerHTML = \`<div class="error">\${message.message}</div>\`;
              break;

            case 'renderGraph':
              renderGraph(message.data);
              break;
          }
        });

        function renderGraph(data) {
          let html = '';

          // Target function
          html += '<div class="section">';
          html += '<div class="section-title">Target Function</div>';
          html += renderNode(data.target, 'target');
          html += '</div>';

          // Called by (callers)
          if (data.calledBy && data.calledBy.length > 0) {
            html += '<div class="section">';
            html += \`<div class="section-title">Called By (\${data.calledBy.length})</div>\`;
            html += '<div class="nodes-grid">';
            data.calledBy.forEach(node => {
              html += renderNode(node, 'caller');
            });
            html += '</div>';
            html += '</div>';
          }

          // Calls (callees)
          if (data.calls && data.calls.length > 0) {
            html += '<div class="section">';
            html += \`<div class="section-title">Calls (\${data.calls.length})</div>\`;
            html += '<div class="nodes-grid">';
            data.calls.forEach(node => {
              html += renderNode(node, 'callee');
            });
            html += '</div>';
            html += '</div>';
          }

          if (data.calledBy.length === 0 && data.calls.length === 0) {
            html += '<div class="section">';
            html += '<div style="text-align: center; color: var(--vscode-descriptionForeground); padding: 40px;">No call relationships found</div>';
            html += '</div>';
          }

          graphContainer.innerHTML = html;
        }

        function renderNode(node, type) {
          return \`
            <div class="node \${type}" onclick="openFile('\${node.file_path}', \${node.line_start})">
              <div class="node-name">\${escapeHtml(node.symbol_name)}</div>
              <div class="node-info">\${node.symbol_type} • \${node.file_path}:\${node.line_start}</div>
            </div>
          \`;
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
