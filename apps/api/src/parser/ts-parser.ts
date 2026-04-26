import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { CodeChunk, ParseResult } from './types.js';

export function parseTsFile(filePath: string, code: string): ParseResult {
  const chunks: CodeChunk[] = [];
  const imports: Array<{ source: string; specifiers: string[] }> = [];
  const exports: string[] = [];

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const specifiers = path.node.specifiers.map((spec) => {
        if (spec.type === 'ImportDefaultSpecifier') {
          return spec.local.name;
        }
        if (spec.type === 'ImportSpecifier') {
          return spec.imported.type === 'Identifier' ? spec.imported.name : '';
        }
        return '';
      }).filter(Boolean);
      imports.push({ source, specifiers });
    },

    FunctionDeclaration(path) {
      const node = path.node;
      if (!node.id || !node.loc) return;

      const calls: string[] = [];
      path.traverse({
        CallExpression(callPath) {
          const callee = callPath.node.callee;
          if (callee.type === 'Identifier') {
            calls.push(callee.name);
          } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
            calls.push(callee.property.name);
          }
        },
      });

      chunks.push({
        symbolName: node.id.name,
        symbolType: 'function',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls,
      });
    },

    ClassDeclaration(path) {
      const node = path.node;
      if (!node.id || !node.loc) return;

      chunks.push({
        symbolName: node.id.name,
        symbolType: 'class',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls: [],
      });
    },

    ExportNamedDeclaration(path) {
      const node = path.node;
      if (node.declaration) {
        if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          exports.push(node.declaration.id.name);
        } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
          exports.push(node.declaration.id.name);
        } else if (node.declaration.type === 'VariableDeclaration') {
          node.declaration.declarations.forEach((decl) => {
            if (decl.id.type === 'Identifier') {
              exports.push(decl.id.name);
            }
          });
        }
      }
    },

    ExportDefaultDeclaration(path) {
      const node = path.node;
      if (node.declaration.type === 'Identifier') {
        exports.push(node.declaration.name);
      } else if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        exports.push(node.declaration.id.name);
      } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
        exports.push(node.declaration.id.name);
      }
    },
  });

  return {
    filePath,
    language: 'typescript',
    chunks,
    imports,
    exports,
  };
}
