import { parseTsFile } from './ts-parser.js';
import { parseVueFile } from './vue-parser.js';
import type { ParseResult } from './types.js';

export * from './types.js';

export function parseFile(filePath: string, code: string): ParseResult | null {
  if (filePath.endsWith('.vue')) {
    return parseVueFile(filePath, code);
  }

  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
    return parseTsFile(filePath, code);
  }

  return null;
}
