/**
 * URL Derivation - Trace how URLs are constructed from constants and functions
 *
 * This module analyzes URL construction chains by following dependencies
 * and expanding template strings to understand the complete URL pattern.
 */

import { Pool } from 'pg';

export interface URLDerivationResult {
  pattern: string;
  confidence: number;
  symbolChain: Array<{
    symbol: string;
    file: string;
    line: number;
    value: string;
  }>;
  derivationSteps: Array<{
    step: number;
    description: string;
    from: string;
    to: string;
  }>;
  missingSymbols: string[];
}

interface Symbol {
  id: string;
  name: string;
  value: string;
  type: 'constant' | 'function' | 'template';
  dependsOn: string[];
  returns?: string;
  file: string;
  line: number;
}

/**
 * Derive URL construction chain for a given target URL
 */
export async function deriveURLConstruction(
  db: Pool,
  repoId: number,
  targetUrl: string
): Promise<URLDerivationResult[]> {
  // 1. Build symbol table from database
  const symbolTable = await buildSymbolTable(db, repoId);

  if (Object.keys(symbolTable).length === 0) {
    return [];
  }

  // 2. Find entry points (symbols that might contain the target URL)
  const entryPoints = findEntryPoints(targetUrl, symbolTable);

  if (entryPoints.length === 0) {
    return [];
  }

  // 3. Derive URL for each entry point
  const results: URLDerivationResult[] = [];

  for (const entryPoint of entryPoints.slice(0, 5)) {
    const result = deriveFromEntryPoint(targetUrl, entryPoint, symbolTable);
    if (result.confidence > 0) {
      results.push(result);
    }
  }

  // 4. Sort by confidence
  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Build symbol table from database
 */
async function buildSymbolTable(db: Pool, repoId: number): Promise<Record<string, Symbol>> {
  const symbolTable: Record<string, Symbol> = {};

  // Extract URL-related string constants
  const constantsQuery = `
    SELECT
      sc.id,
      sc.symbol_name,
      sc.string_value,
      sc.line_start,
      f.path as file_path
    FROM string_constants sc
    JOIN files f ON sc.file_id = f.id
    WHERE sc.repo_id = $1
      AND sc.constant_type = 'url_segment'
      AND sc.symbol_name IS NOT NULL
      AND sc.string_value IS NOT NULL
  `;

  const constants = await db.query(constantsQuery, [repoId]);

  for (const row of constants.rows) {
    const symbolId = `const:${row.symbol_name}`;
    const dependsOn = extractDependencies(row.string_value);

    symbolTable[symbolId] = {
      id: symbolId,
      name: row.symbol_name,
      value: row.string_value,
      type: isTemplate(row.string_value) ? 'template' : 'constant',
      dependsOn,
      file: row.file_path,
      line: row.line_start,
    };
  }

  // Extract URL-related functions
  const functionsQuery = `
    SELECT
      fn.id,
      fn.name,
      fn.full_name,
      fn.code,
      fn.line_start,
      f.path as file_path
    FROM functions fn
    JOIN files f ON fn.file_id = f.id
    WHERE fn.repo_id = $1
      AND (
        fn.name ILIKE '%url%'
        OR fn.name ILIKE '%path%'
        OR fn.name ILIKE '%endpoint%'
        OR fn.code ILIKE '%return%/%'
      )
    LIMIT 100
  `;

  const functions = await db.query(functionsQuery, [repoId]);

  for (const row of functions.rows) {
    const symbolId = `func:${row.full_name || row.name}`;
    const returns = extractReturnValue(row.code);

    if (returns) {
      const dependsOn = extractDependencies(returns);

      symbolTable[symbolId] = {
        id: symbolId,
        name: row.full_name || row.name,
        value: row.code,
        type: 'function',
        dependsOn,
        returns,
        file: row.file_path,
        line: row.line_start,
      };
    }
  }

  return symbolTable;
}

/**
 * Find entry points that might contain the target URL
 */
function findEntryPoints(targetUrl: string, symbolTable: Record<string, Symbol>): string[] {
  const targetSegments = extractPathSegments(targetUrl);
  const entryPoints: Array<{ id: string; score: number }> = [];

  for (const [symbolId, symbol] of Object.entries(symbolTable)) {
    // Count matching segments
    const matchCount = targetSegments.filter(seg =>
      symbol.value.toLowerCase().includes(seg.toLowerCase())
    ).length;

    if (matchCount > 0) {
      entryPoints.push({
        id: symbolId,
        score: matchCount / targetSegments.length,
      });
    }
  }

  // Sort by match score
  entryPoints.sort((a, b) => b.score - a.score);

  return entryPoints.map(ep => ep.id);
}

/**
 * Derive URL from a specific entry point
 */
function deriveFromEntryPoint(
  targetUrl: string,
  entryPoint: string,
  symbolTable: Record<string, Symbol>
): URLDerivationResult {
  const symbolChain: URLDerivationResult['symbolChain'] = [];
  const derivationSteps: URLDerivationResult['derivationSteps'] = [];
  const missingSymbols: string[] = [];
  const visited = new Set<string>();

  const entrySymbol = symbolTable[entryPoint];
  if (!entrySymbol) {
    return {
      pattern: '',
      confidence: 0,
      symbolChain: [],
      derivationSteps: [],
      missingSymbols: [entryPoint],
    };
  }

  let currentValue = entrySymbol.value;
  let stepCount = 0;

  // Add entry point to chain
  symbolChain.push({
    symbol: entrySymbol.name,
    file: entrySymbol.file,
    line: entrySymbol.line,
    value: entrySymbol.value,
  });

  derivationSteps.push({
    step: ++stepCount,
    description: `入口点: ${entrySymbol.name}`,
    from: 'ENTRY',
    to: currentValue,
  });

  // Recursively expand dependencies
  function expandValue(value: string, depth: number = 0): string {
    if (depth > 10) return value; // Prevent infinite recursion

    const templateRegex = /\$\{([^}]+)\}|`([^`]*)`/g;
    let expanded = value;
    let match;

    // Extract template string content if wrapped in backticks
    if (value.startsWith('`') && value.endsWith('`')) {
      expanded = value.slice(1, -1);
    }

    // Expand ${...} variables
    const varRegex = /\$\{([^}]+)\}/g;
    while ((match = varRegex.exec(expanded)) !== null) {
      const varName = match[1].trim();
      const symbolId = findSymbolByName(varName, symbolTable);

      if (symbolId && !visited.has(symbolId)) {
        visited.add(symbolId);
        const symbol = symbolTable[symbolId];

        symbolChain.push({
          symbol: symbol.name,
          file: symbol.file,
          line: symbol.line,
          value: symbol.value,
        });

        let replacement = symbol.value;

        // If it's a function, use return value
        if (symbol.type === 'function' && symbol.returns) {
          replacement = symbol.returns;
          derivationSteps.push({
            step: ++stepCount,
            description: `展开函数: ${varName}()`,
            from: match[0],
            to: replacement,
          });
        } else {
          derivationSteps.push({
            step: ++stepCount,
            description: `替换变量: ${varName}`,
            from: match[0],
            to: replacement,
          });
        }

        // Recursively expand
        replacement = expandValue(replacement, depth + 1);
        expanded = expanded.replace(match[0], replacement);
      } else if (!symbolId) {
        // Missing symbol - use placeholder
        missingSymbols.push(varName);
        expanded = expanded.replace(match[0], `:${varName}`);
      }
    }

    return expanded;
  }

  const finalPattern = expandValue(currentValue);

  derivationSteps.push({
    step: ++stepCount,
    description: '最终 URL 模式',
    from: currentValue,
    to: finalPattern,
  });

  // Calculate match confidence
  const confidence = calculateMatchConfidence(targetUrl, finalPattern);

  return {
    pattern: finalPattern,
    confidence,
    symbolChain,
    derivationSteps,
    missingSymbols,
  };
}

/**
 * Extract path segments from URL
 */
function extractPathSegments(url: string): string[] {
  // Remove protocol and domain
  let path = url.replace(/^https?:\/\/[^\/]+/, '');

  // Remove query string and hash
  path = path.split('?')[0].split('#')[0];

  // Split by / and filter out empty segments and IDs
  const segments = path.split('/').filter(seg => {
    if (!seg) return false;

    // Skip pure numeric IDs
    if (/^\d+$/.test(seg)) return false;

    // Skip long hex strings (SHA, tokens, etc.)
    if (/^[0-9a-f]{20,}$/i.test(seg)) return false;

    // Skip UUIDs
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return false;

    // Skip MongoDB ObjectIds (24 hex chars)
    if (/^[0-9a-f]{24}$/i.test(seg)) return false;

    // Keep common API path segments even if short
    const commonSegments = ['api', 'v1', 'v2', 'v3', 'v4', 'v5', 'app', 'web', 'p'];
    if (commonSegments.includes(seg.toLowerCase())) return true;

    // Skip short random strings (likely IDs) - but only if not a common segment
    if (seg.length <= 2 && /^[a-z0-9]+$/i.test(seg)) return false;

    return true;
  });

  return segments;
}

/**
 * Check if value is a template string
 */
function isTemplate(value: string): boolean {
  return /\$\{[^}]+\}/.test(value) || /:[a-zA-Z_]\w*/.test(value);
}

/**
 * Extract dependencies from template string
 */
function extractDependencies(value: string): string[] {
  const deps: string[] = [];
  const regex = /\$\{([^}]+)\}/g;
  let match;

  while ((match = regex.exec(value)) !== null) {
    const varName = match[1].trim().replace(/\([^)]*\)$/, '');
    deps.push(varName);
  }

  return deps;
}

/**
 * Extract return value from function code
 */
function extractReturnValue(code: string): string | undefined {
  const returnMatch = code.match(/return\s+([`'"].*?[`'"]|`[^`]*`)/s);
  if (returnMatch) {
    let value = returnMatch[1].trim();
    // Remove quotes if not a template string
    if (!value.startsWith('`')) {
      value = value.replace(/^['"]+|['"]+$/g, '');
    }
    return value;
  }
  return undefined;
}

/**
 * Find symbol by name in symbol table
 */
function findSymbolByName(name: string, symbolTable: Record<string, Symbol>): string | undefined {
  const cleanName = name.replace(/\([^)]*\)$/, '');

  // Try different prefixes
  const candidates = [
    `const:${cleanName}`,
    `func:${cleanName}`,
    `const:${cleanName.toUpperCase()}`,
    `const:${cleanName.toLowerCase()}`,
  ];

  for (const candidate of candidates) {
    if (symbolTable[candidate]) {
      return candidate;
    }
  }

  // Fuzzy match
  for (const [symbolId, symbol] of Object.entries(symbolTable)) {
    if (symbol.name === cleanName || symbol.name.endsWith(`.${cleanName}`)) {
      return symbolId;
    }
  }

  return undefined;
}

/**
 * Calculate match confidence between target URL and derived pattern
 */
function calculateMatchConfidence(targetUrl: string, pattern: string): number {
  const normalize = (url: string) => url.replace(/^https?:\/\/[^\/]+/, '').toLowerCase();

  const normalizedTarget = normalize(targetUrl);
  const normalizedPattern = normalize(pattern);

  // Exact match
  if (normalizedTarget === normalizedPattern) {
    return 100;
  }

  // Pattern match (with placeholders)
  const patternRegex = normalizedPattern
    .replace(/\$\{[^}]+\}/g, '[^/]+')
    .replace(/:[a-zA-Z_]\w*/g, '[^/]+')
    .replace(/\//g, '\\/');

  const regex = new RegExp(`^${patternRegex}$`);

  if (regex.test(normalizedTarget)) {
    // Calculate similarity based on static vs dynamic segments
    const targetSegments = normalizedTarget.split('/').filter(Boolean);
    const patternSegments = normalizedPattern.split('/').filter(Boolean);

    if (targetSegments.length !== patternSegments.length) {
      return 0;
    }

    let matchScore = 0;
    for (let i = 0; i < targetSegments.length; i++) {
      if (targetSegments[i] === patternSegments[i]) {
        matchScore += 1.0; // Exact segment match
      } else if (/\$\{[^}]+\}|:[a-zA-Z_]\w*/.test(patternSegments[i])) {
        matchScore += 0.5; // Placeholder match
      }
    }

    return Math.round((matchScore / targetSegments.length) * 100);
  }

  // Partial match
  const targetSegments = normalizedTarget.split('/').filter(Boolean);
  const patternSegments = normalizedPattern.split('/').filter(Boolean);

  let matchCount = 0;
  const minLength = Math.min(targetSegments.length, patternSegments.length);

  for (let i = 0; i < minLength; i++) {
    if (targetSegments[i] === patternSegments[i]) {
      matchCount++;
    }
  }

  const maxLength = Math.max(targetSegments.length, patternSegments.length);
  return Math.round((matchCount / maxLength) * 100);
}
