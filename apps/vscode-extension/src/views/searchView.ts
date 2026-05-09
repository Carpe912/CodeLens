import * as vscode from 'vscode';
import { SearchResult } from '../types';

export class SearchResultItem extends vscode.TreeItem {
  constructor(
    public readonly result: SearchResult,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(`${result.symbolName} (${result.symbolType})`, collapsibleState);

    this.description = `${result.filePath}:${result.lineStart}`;
    this.tooltip = result.content.substring(0, 200);

    // Set icon based on symbol type
    this.iconPath = new vscode.ThemeIcon(this.getIconForSymbolType(result.symbolType));

    // Command to open file when clicked
    this.command = {
      command: 'codelens.openFile',
      title: 'Open File',
      arguments: [result.filePath, result.lineStart],
    };

    // Context value for context menu
    this.contextValue = 'searchResult';
  }

  private getIconForSymbolType(symbolType: string): string {
    const iconMap: Record<string, string> = {
      function: 'symbol-method',
      method: 'symbol-method',
      class: 'symbol-class',
      interface: 'symbol-interface',
      constant: 'symbol-constant',
      variable: 'symbol-variable',
      arrow_function: 'symbol-method',
    };
    return iconMap[symbolType] || 'symbol-misc';
  }
}

export class SearchTreeDataProvider implements vscode.TreeDataProvider<SearchResultItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SearchResultItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: SearchResult[] = [];
  private currentQuery: string = '';

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.results = [];
    this.currentQuery = '';
    this.refresh();
  }

  setResults(query: string, results: SearchResult[]): void {
    this.currentQuery = query;
    this.results = results;
    this.refresh();
  }

  getTreeItem(element: SearchResultItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SearchResultItem): SearchResultItem[] {
    if (element) {
      // No children for search results
      return [];
    }

    // Root level: show search results
    if (this.results.length === 0) {
      return [];
    }

    return this.results.map(
      (result) => new SearchResultItem(result, vscode.TreeItemCollapsibleState.None)
    );
  }

  getCurrentQuery(): string {
    return this.currentQuery;
  }

  getResultCount(): number {
    return this.results.length;
  }
}
