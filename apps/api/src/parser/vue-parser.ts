import { parse as parseVue } from '@vue/compiler-sfc';
import { parseTsFile } from './ts-parser.js';
import type { ParseResult } from './types.js';

export function parseVueFile(filePath: string, code: string): ParseResult {
  const { descriptor } = parseVue(code, { filename: filePath });

  if (!descriptor.script && !descriptor.scriptSetup) {
    return {
      filePath,
      language: 'vue',
      chunks: [],
      imports: [],
      exports: [],
    };
  }

  const scriptContent = descriptor.scriptSetup?.content || descriptor.script?.content || '';
  const scriptLang = descriptor.scriptSetup?.lang || descriptor.script?.lang || 'js';

  if (scriptLang === 'ts' || scriptLang === 'typescript') {
    const result = parseTsFile(filePath, scriptContent);
    result.language = 'vue';
    return result;
  }

  return {
    filePath,
    language: 'vue',
    chunks: [],
    imports: [],
    exports: [],
  };
}
