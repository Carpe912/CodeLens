import * as vscode from 'vscode';
import { APIService } from '../api';
import { RepoRegistry } from '../state';

export class CodeLensCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private apiService: APIService,
    private repoRegistry: RepoRegistry
  ) {}

  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('codelens');
    if (!config.get('enableCodeLens', true)) {
      return [];
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }

    const repoInfo = this.repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
    if (!repoInfo || repoInfo.status !== 'ready') {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];

    try {
      // Get document symbols (functions, classes, methods)
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (!symbols || token.isCancellationRequested) {
        return [];
      }

      // Process each symbol
      for (const symbol of symbols) {
        await this.processSymbol(symbol, document, repoInfo.repoId, codeLenses, token);
      }
    } catch (error) {
      console.error('[CodeLensProvider] Error providing code lenses:', error);
    }

    return codeLenses;
  }

  private async processSymbol(
    symbol: vscode.DocumentSymbol,
    document: vscode.TextDocument,
    repoId: number,
    codeLenses: vscode.CodeLens[],
    token: vscode.CancellationToken
  ) {
    // Only process functions, methods, and classes
    const relevantKinds = [
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
    ];

    if (!relevantKinds.includes(symbol.kind)) {
      // Process children
      for (const child of symbol.children) {
        await this.processSymbol(child, document, repoId, codeLenses, token);
      }
      return;
    }

    if (token.isCancellationRequested) {
      return;
    }

    try {
      // Get call graph data for this symbol
      const callGraph = await this.apiService.callGraph.getCallGraph(repoId, symbol.name);

      const range = symbol.range;

      // Add "X references" CodeLens
      if (callGraph.calledBy && callGraph.calledBy.length > 0) {
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: `$(references) ${callGraph.calledBy.length} reference${callGraph.calledBy.length > 1 ? 's' : ''}`,
            command: 'codelens.showReferences',
            arguments: [document.uri, range.start, callGraph.calledBy],
          })
        );
      }

      // Add "Calls X functions" CodeLens
      if (callGraph.calls && callGraph.calls.length > 0) {
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: `$(call-outgoing) Calls ${callGraph.calls.length} function${callGraph.calls.length > 1 ? 's' : ''}`,
            command: 'codelens.showCallGraph',
            arguments: [repoId, symbol.name],
          })
        );
      }
    } catch (error) {
      // Silently fail for individual symbols
      console.debug(`[CodeLensProvider] Failed to get call graph for ${symbol.name}:`, error);
    }

    // Process children
    for (const child of symbol.children) {
      await this.processSymbol(child, document, repoId, codeLenses, token);
    }
  }
}
