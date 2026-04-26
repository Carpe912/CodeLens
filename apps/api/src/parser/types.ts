export type CodeChunk = {
  symbolName: string;
  symbolType: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'component';
  lineStart: number;
  lineEnd: number;
  code: string;
  filePath: string;
  language: 'typescript' | 'javascript' | 'vue';
  imports: string[];
  exports: string[];
  calls: string[];
};

export type ParseResult = {
  filePath: string;
  language: 'typescript' | 'javascript' | 'vue';
  chunks: CodeChunk[];
  imports: Array<{ source: string; specifiers: string[] }>;
  exports: string[];
};
