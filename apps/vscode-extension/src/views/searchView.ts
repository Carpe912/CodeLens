import * as vscode from 'vscode';
import { SearchResult } from '../types';

export class StatusMessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'statusMessage';
  }
}

export class ActionButtonItem extends vscode.TreeItem {
  constructor(
    label: string,
    command: string,
    icon: string,
    description?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.description = description;
    this.command = {
      command: command,
      title: label,
    };
    this.contextValue = 'actionButton';
  }
}

export class SearchResultItem extends vscode.TreeItem {
  constructor(
    public readonly result: SearchResult,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(`${result.symbol_name} (${result.symbol_type})`, collapsibleState);

    this.description = `${result.file_path}:${result.line_start}`;
    this.tooltip = result.content ? result.content.substring(0, 200) : '';

    // Set icon based on symbol type
    this.iconPath = new vscode.ThemeIcon(this.getIconForSymbolType(result.symbol_type));

    // Command to open file when clicked
    this.command = {
      command: 'codelens.openFile',
      title: 'Open File',
      arguments: [result.file_path, result.line_start],
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

export class SearchTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: SearchResult[] = [];
  private currentQuery: string = '';
  private statusMessage: string = '';

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.results = [];
    this.currentQuery = '';
    this.statusMessage = '';
    this.refresh();
  }

  setStatusMessage(message: string): void {
    this.statusMessage = message;
    this.results = [];
    this.currentQuery = '';
    this.refresh();
  }

  setResults(query: string, results: SearchResult[] | any): void {
    this.currentQuery = query;
    this.statusMessage = '';

    // Handle API response format - might be wrapped in an object
    if (!Array.isArray(results)) {
      console.log('[SearchView] Results is not an array, type:', typeof results);
      console.log('[SearchView] Results keys:', results ? Object.keys(results) : 'null');

      // If results is an object with a data property, extract it
      if (results && typeof results === 'object') {
        if ('hits' in results) {
          this.results = Array.isArray(results.hits) ? results.hits : [];
        } else if ('data' in results) {
          this.results = Array.isArray(results.data) ? results.data : [];
        } else if ('results' in results) {
          this.results = Array.isArray(results.results) ? results.results : [];
        } else if ('items' in results) {
          this.results = Array.isArray(results.items) ? results.items : [];
        } else {
          // Maybe the object itself is the result with properties
          console.error('[SearchView] Unexpected results format, keys:', Object.keys(results).slice(0, 10));
          this.results = [];
        }
      } else {
        this.results = [];
      }
    } else {
      this.results = results;
    }

    console.log('[SearchView] Final results array length:', this.results.length);
    if (this.results.length > 0) {
      console.log('[SearchView] First result sample:', this.results[0]);
      console.log('[SearchView] First result keys:', Object.keys(this.results[0]));
    }
    this.refresh();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      // No children for search results or status messages
      return [];
    }

    // Show status message if set
    if (this.statusMessage) {
      return [
        new StatusMessageItem(this.statusMessage),
        new ActionButtonItem('开始搜索', 'codelens.search', 'search', '搜索代码符号'),
        new ActionButtonItem('打开AI问答', 'codelens.askAI', 'comment-discussion', '询问AI关于代码的问题'),
      ];
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
