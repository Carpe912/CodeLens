import * as vscode from 'vscode';
import { APIService } from '../api';
import { RepoRegistry } from '../state';
import { SearchCache } from '../state/cache';

export class CodeLensHoverProvider implements vscode.HoverProvider {
  constructor(
    private apiService: APIService,
    private repoRegistry: RepoRegistry,
    private searchCache: SearchCache
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const config = vscode.workspace.getConfiguration('codelens');
    if (!config.get('enableHover', true)) {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const repoInfo = this.repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
    if (!repoInfo || repoInfo.status !== 'ready') {
      return undefined;
    }

    // Get word at position
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);
    if (!word || word.length < 2) {
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    try {
      // Check cache first
      const cacheKey = this.searchCache.generateKey(repoInfo.repoId, word);
      let results = this.searchCache.get<any[]>(cacheKey);

      if (!results) {
        // Search for symbol
        results = await this.apiService.search.search(repoInfo.repoId, word);
        this.searchCache.set(cacheKey, results);
      }

      if (!results || results.length === 0) {
        return undefined;
      }

      // Find exact match or best match
      const exactMatch = results.find((r: any) => r.symbolName === word);
      const bestMatch = exactMatch || results[0];

      // Build hover content
      const markdown = new vscode.MarkdownString();
      markdown.isTrusted = true;
      markdown.supportHtml = true;

      // Add symbol name and type
      markdown.appendMarkdown(`### ${bestMatch.symbolName}\n\n`);
      markdown.appendMarkdown(`**Type:** \`${bestMatch.symbolType}\`\n\n`);
      markdown.appendMarkdown(`**File:** ${bestMatch.filePath}:${bestMatch.lineStart}\n\n`);

      // Add code snippet
      markdown.appendMarkdown('---\n\n');
      const language = this.getLanguageFromPath(bestMatch.filePath);
      markdown.appendCodeblock(bestMatch.content, language);

      // Add action links
      markdown.appendMarkdown('\n\n---\n\n');
      const callGraphArgs = encodeURIComponent(JSON.stringify([repoInfo.repoId, word]));
      markdown.appendMarkdown(
        `[$(graph) View Call Graph](command:codelens.showCallGraph?${callGraphArgs} "Show call graph")`
      );

      return new vscode.Hover(markdown, wordRange);
    } catch (error) {
      console.error('[HoverProvider] Error providing hover:', error);
      return undefined;
    }
  }

  private getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      vue: 'vue',
      py: 'python',
      go: 'go',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
    };
    return languageMap[ext || ''] || 'text';
  }
}
