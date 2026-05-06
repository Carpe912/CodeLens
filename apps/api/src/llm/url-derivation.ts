/**
 * URL Derivation - Trace how URLs are constructed from constants and functions
 *
 * This module analyzes URL construction chains by following dependencies
 * and expanding template strings to understand the complete URL pattern.
 */

import { Pool } from 'pg';

// Helper function to escape special regex characters
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  console.log(`[URL Derivation] Starting derivation for: ${targetUrl}`);

  // 1. Build symbol table from database
  const symbolTable = await buildSymbolTable(db, repoId);

  console.log(`[URL Derivation] Symbol table built with ${Object.keys(symbolTable).length} symbols`);

  if (Object.keys(symbolTable).length === 0) {
    console.log('[URL Derivation] No symbols found, returning empty results');
    return [];
  }

  // 2. Find entry points (symbols that might contain the target URL)
  const entryPoints = findEntryPoints(targetUrl, symbolTable);

  console.log(`[URL Derivation] Found ${entryPoints.length} entry points`);

  if (entryPoints.length === 0) {
    console.log('[URL Derivation] No entry points found');
    return [];
  }

  // 3. Derive URL for each entry point
  const results: URLDerivationResult[] = [];

  for (const entryPoint of entryPoints.slice(0, 10)) {
    console.log(`[URL Derivation] Deriving from entry point: ${entryPoint}`);
    const result = deriveFromEntryPoint(targetUrl, entryPoint, symbolTable);
    console.log(`[URL Derivation] Result pattern: ${result.pattern}, confidence: ${result.confidence}`);
    console.log(`[URL Derivation] Symbol chain length: ${result.symbolChain.length}`);
    console.log(`[URL Derivation] Missing symbols: ${result.missingSymbols.join(', ')}`);
    if (result.confidence > 0) {
      results.push(result);
    }
  }

  console.log(`[URL Derivation] Generated ${results.length} derivation results`);

  // 4. Sort by confidence
  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Build symbol table from database
 */
async function buildSymbolTable(db: Pool, repoId: number): Promise<Record<string, Symbol>> {
  const symbolTable: Record<string, Symbol> = {};

  console.log(`[URL Derivation] Building symbol table for repo ${repoId}`);

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
    WHERE f.repo_id = $1
      AND sc.constant_type IN ('url_segment', 'string')
      AND sc.symbol_name IS NOT NULL
      AND sc.string_value IS NOT NULL
      AND (
        sc.constant_type = 'url_segment'
        OR sc.symbol_name ILIKE '%API%'
        OR sc.symbol_name ILIKE '%URL%'
        OR sc.symbol_name ILIKE '%PATH%'
        OR sc.symbol_name ILIKE '%PREFIX%'
        OR sc.symbol_name ILIKE '%VERSION%'
        OR sc.symbol_name ILIKE '%RESOURCE%'
      )
  `;

  const constants = await db.query(constantsQuery, [repoId]);
  console.log(`[URL Derivation] Found ${constants.rows.length} string constants`);

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

  // Extract object/variable constants from string_constants (e.g., RESOURCES object)
  const objectsQuery = `
    SELECT
      sc.id,
      sc.symbol_name,
      sc.code,
      sc.line_start,
      f.path as file_path
    FROM string_constants sc
    JOIN files f ON sc.file_id = f.id
    WHERE sc.repo_id = $1
      AND (
        sc.symbol_name ILIKE '%RESOURCE%'
        OR sc.symbol_name ILIKE '%API%'
        OR sc.symbol_name ILIKE '%URL%'
        OR sc.symbol_name ILIKE '%PATH%'
        OR sc.symbol_name ILIKE '%CONFIG%'
      )
    LIMIT 50
  `;

  const objects = await db.query(objectsQuery, [repoId]);
  console.log(`[URL Derivation] Found ${objects.rows.length} object/variable constants`);

  for (const row of objects.rows) {
    const symbolId = `const:${row.symbol_name}`;

    // Extract the actual value from the declaration
    let value = row.code;

    // Try to match: const/let/var NAME = value
    let valueMatch = row.code.match(/(?:const|let|var)\s+\w+\s*=\s*(.+?)(?:;|$)/s);
    if (valueMatch) {
      value = valueMatch[1].trim();
    } else {
      // Try to match: NAME = value (without const/let/var)
      valueMatch = row.code.match(/^\s*\w+\s*=\s*(.+?)(?:;|$)/s);
      if (valueMatch) {
        value = valueMatch[1].trim();
      }
    }

    symbolTable[symbolId] = {
      id: symbolId,
      name: row.symbol_name,
      value: value,
      type: 'constant',
      dependsOn: extractDependencies(value),
      file: row.file_path,
      line: row.line_start,
    };

    console.log(`[URL Derivation]   Added object constant: ${row.symbol_name} = ${value.substring(0, 50)}`);
  }

  // Extract URL-related functions from code_chunks
  const functionsQuery = `
    SELECT
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
        OR fn.code ~ 'ApiPaths\\.\\w+\\.\\w+'
        OR fn.code ~ 'buildApiPath\\s*\\('
        OR fn.code ~ '(axios|client|http|fetch)\\.(get|post|put|delete|patch)'
        OR fn.code ILIKE '%/api/%'
      )
    LIMIT 100
  `;

  const functions = await db.query(functionsQuery, [repoId]);
  console.log(`[URL Derivation] Found ${functions.rows.length} functions`);

  for (const row of functions.rows) {
    const symbolId = `func:${row.full_name || row.name}`;
    const returns = extractReturnValue(row.code);

    // Debug logging for buildApiPath and getUserData
    if (row.name === 'buildApiPath' || row.name === 'getUserData') {
      console.log(`[URL Derivation] ${row.name} function found:`);
      console.log('  Code:', row.code.substring(0, 200));
      console.log('  Extracted returns:', returns);
    }

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

  // Extract function calls (e.g., buildApiPath(RESOURCES.PRODUCTS))
  const callsQuery = `
    SELECT
      fn.id,
      fn.code,
      fn.line_start,
      f.path as file_path
    FROM functions fn
    JOIN files f ON fn.file_id = f.id
    WHERE fn.repo_id = $1
      AND fn.code ~ 'buildApiPath\\s*\\('
    LIMIT 50
  `;

  const calls = await db.query(callsQuery, [repoId]);
  console.log(`[URL Derivation] Found ${calls.rows.length} function calls`);

  // Extract function call patterns
  for (const row of calls.rows) {
    const callMatches = extractFunctionCalls(row.code, 'buildApiPath');
    for (const call of callMatches) {
      const callId = `call:${call.functionName}:${row.line_start}`;
      console.log(`[URL Derivation] Found call: ${call.functionName}(${call.args.join(', ')})`);

      symbolTable[callId] = {
        id: callId,
        name: `${call.functionName}_call`,
        value: call.fullMatch,
        type: 'function',
        dependsOn: [
          `func:${call.functionName}`,
          ...call.args.map(arg => {
            // If arg looks like a constant reference (e.g., RESOURCES.PRODUCTS)
            if (/^[A-Z_][A-Z0-9_.]*$/.test(arg.trim())) {
              return `const:${arg.trim()}`;
            }
            return arg;
          }).filter(arg => arg.startsWith('const:'))
        ],
        returns: call.fullMatch,
        file: row.file_path,
        line: row.line_start,
      };
    }
  }

  console.log(`[URL Derivation] Symbol table complete with ${Object.keys(symbolTable).length} symbols`);
  console.log(`[URL Derivation] Symbol table keys:`, Object.keys(symbolTable).join(', '));

  // Log each symbol's details
  for (const [key, symbol] of Object.entries(symbolTable)) {
    console.log(`[URL Derivation]   ${key}: ${symbol.value.substring(0, 100)}`);
  }

  return symbolTable;
}

/**
 * Resolve object method calls like ApiPaths.users.detail(userId)
 */
function resolveObjectMethod(
  functionPath: string,
  args: string,
  symbolTable: Record<string, Symbol>
): string | null {
  // Split the path: "ApiPaths.users.detail" -> ["ApiPaths", "users", "detail"]
  const parts = functionPath.split('.');

  if (parts.length < 2) {
    return null; // Not an object method call
  }

  // Try to find the object in symbol table
  const objectName = parts[0]; // e.g., "ApiPaths"
  const objectSymbolId = `const:${objectName}`;
  const objectSymbol = symbolTable[objectSymbolId];

  if (!objectSymbol || !objectSymbol.value) {
    console.log(`[URL Derivation]   Object ${objectName} not found in symbol table`);
    return null;
  }

  // Parse the object structure to find the nested method
  // Example: ApiPaths = { users: { detail: (id) => `${buildApiPath(RESOURCES.USERS)}/${id}` } }
  let currentValue = objectSymbol.value;

  // Navigate through the object path (skip the first part, which is the object name)
  for (let i = 1; i < parts.length; i++) {
    const propertyName = parts[i];
    const isLastPart = i === parts.length - 1;

    // Find the property at the current nesting level
    // We need to extract the value between propertyName: and the matching closing brace/comma
    const propertyStartRegex = new RegExp(`${propertyName}\\s*:\\s*`, 'g');
    const match = propertyStartRegex.exec(currentValue);

    if (!match) {
      console.log(`[URL Derivation]   Property ${propertyName} not found in object`);
      return null;
    }

    const startIndex = match.index + match[0].length;
    let valueStr = currentValue.substring(startIndex);

    // Check if it's an arrow function
    const arrowMatch = valueStr.match(/^\(([^)]*)\)\s*=>\s*/);

    if (arrowMatch && isLastPart) {
      // This is the final property and it's an arrow function
      const functionArgs = arrowMatch[1]; // e.g., "id"
      const bodyStart = arrowMatch[0].length;

      // Extract the function body - handle template literals and expressions
      let functionBody = '';
      let depth = 0;
      let i = bodyStart;

      if (valueStr[i] === '`') {
        // Template literal
        i++;
        while (i < valueStr.length) {
          if (valueStr[i] === '`' && valueStr[i-1] !== '\\') {
            functionBody = '`' + valueStr.substring(bodyStart + 1, i) + '`';
            break;
          }
          i++;
        }
      } else {
        // Regular expression - read until comma or closing brace at depth 0
        while (i < valueStr.length) {
          const char = valueStr[i];
          if (char === '{') depth++;
          else if (char === '}') {
            if (depth === 0) break;
            depth--;
          } else if (char === ',' && depth === 0) break;
          i++;
        }
        functionBody = valueStr.substring(bodyStart, i).trim();
      }

      console.log(`[URL Derivation]   Found arrow function: (${functionArgs}) => ${functionBody}`);

      // Replace function parameters with actual arguments
      const argNames = functionArgs.split(',').map(a => a.trim()).filter(a => a);
      const argValues = args.split(',').map(a => a.trim()).filter(a => a);

      let result = functionBody;
      for (let j = 0; j < argNames.length && j < argValues.length; j++) {
        const argName = argNames[j];
        // Use :id as placeholder for dynamic parameters
        result = result.replace(new RegExp(`\\$\\{${escapeRegExp(argName)}\\}`, 'g'), ':id');
        result = result.replace(new RegExp(`\\b${escapeRegExp(argName)}\\b`, 'g'), ':id');
      }

      // Now expand any remaining variables (like buildApiPath calls)
      result = expandValueWithLocals(result, symbolTable, {});

      // Strip backticks if present (expandValueWithLocals may have added them)
      if (result.startsWith('`') && result.endsWith('`')) {
        result = result.slice(1, -1);
      }

      // If the result contains ${} expressions, wrap it in backticks
      // so it can be used as a template string when replacing standalone identifiers
      if (result.includes('${')) {
        result = '`' + result + '`';
      }

      return result;
    } else if (valueStr[0] === '{') {
      // Nested object - extract it
      let depth = 1;
      let i = 1;
      while (i < valueStr.length && depth > 0) {
        if (valueStr[i] === '{') depth++;
        else if (valueStr[i] === '}') depth--;
        i++;
      }
      currentValue = valueStr.substring(1, i - 1); // Extract content between { }
    } else {
      console.log(`[URL Derivation]   Unexpected property format for ${propertyName}`);
      return null;
    }
  }

  return null;
}

/**
 * Extract local variable definitions from function body
 */
function extractLocalVariables(functionCode: string): Record<string, string> {
  const locals: Record<string, string> = {};

  // Match: const varName = `template` or const varName = 'string'
  const constRegex = /const\s+(\w+)\s*=\s*`([^`]+)`|const\s+(\w+)\s*=\s*'([^']+)'|const\s+(\w+)\s*=\s*"([^"]+)"/g;
  let match;

  while ((match = constRegex.exec(functionCode)) !== null) {
    if (match[1]) {
      locals[match[1]] = `\`${match[2]}\``;
    } else if (match[3]) {
      locals[match[3]] = `'${match[4]}'`;
    } else if (match[5]) {
      locals[match[5]] = `"${match[6]}"`;
    }
  }

  // Match: const varName = ObjectName.method.call(args)
  // Example: const basePath = ApiPaths.users.detail(userId)
  const functionCallRegex = /const\s+(\w+)\s*=\s*([\w.]+)\s*\(([^)]*)\)/g;
  while ((match = functionCallRegex.exec(functionCode)) !== null) {
    const varName = match[1];
    const functionPath = match[2]; // e.g., "ApiPaths.users.detail"
    const args = match[3]; // e.g., "userId"

    // Store as a special marker that needs to be resolved
    locals[varName] = `__CALL__${functionPath}(${args})`;
    console.log(`[URL Derivation] Found local function call: ${varName} = ${functionPath}(${args})`);
  }

  return locals;
}

/**
 * Expand variables in a value, including local function variables
 */
function expandValueWithLocals(
  value: string,
  symbolTable: Record<string, Symbol>,
  localVars: Record<string, string> = {}
): string {
  let expanded = value;

  console.log(`[URL Derivation] expandValueWithLocals input: "${value}"`);
  console.log(`[URL Derivation] Local vars:`, JSON.stringify(localVars, null, 2));

  // Strip backticks
  if (expanded.startsWith('`') && expanded.endsWith('`')) {
    expanded = expanded.slice(1, -1);
  }

  // Expand up to 10 times to handle nested variables
  let iterations = 0;
  let changed = true;

  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    console.log(`[URL Derivation] Iteration ${iterations}, current: "${expanded}"`);

    // First, handle local variables that appear as standalone identifiers (not inside ${})
    // Example: "basePath" in ternary expression "includeOrders ? `${basePath}/orders` : basePath"
    for (const [varName, varValue] of Object.entries(localVars)) {
      // Replace standalone variable references (not inside ${})
      const standaloneRegex = new RegExp(`\\b${varName}\\b(?!})`, 'g');
      if (standaloneRegex.test(expanded)) {
        let resolvedValue = varValue;

        // Handle __CALL__ markers (function or object method calls)
        if (varValue.startsWith('__CALL__')) {
          const callPattern = varValue.substring(8); // Remove "__CALL__"
          const callMatch = callPattern.match(/^([\w.]+)\(([^)]*)\)$/);
          if (callMatch) {
            const functionPath = callMatch[1];
            const args = callMatch[2];

            // Check if it's a simple function call (no dots) or object method call (has dots)
            if (functionPath.includes('.')) {
              console.log(`[URL Derivation] Resolving standalone object method call: ${varName} = ${functionPath}(${args})`);

              const methodResult = resolveObjectMethod(functionPath, args, symbolTable);
              if (methodResult) {
                resolvedValue = methodResult;
                console.log(`[URL Derivation]   Resolved to: ${resolvedValue}`);
              }
            } else {
              console.log(`[URL Derivation] Resolving standalone function call: ${varName} = ${functionPath}(${args})`);

              const inlinedResult = inlineFunctionCall(functionPath, args, symbolTable);
              if (inlinedResult && inlinedResult !== `${functionPath}(${args})`) {
                resolvedValue = inlinedResult;
                console.log(`[URL Derivation]   Inlined to: ${resolvedValue}`);
              }
            }
          }
        }

        // When replacing standalone identifiers, strip backticks from template strings
        // because they're not inside ${} and shouldn't be treated as template literals
        // BUT: wrap the result in backticks if it contains ${} expressions
        if (resolvedValue.startsWith('`') && resolvedValue.endsWith('`')) {
          const innerValue = resolvedValue.slice(1, -1);
          // If the inner value contains ${}, we need to keep it as a template string
          if (innerValue.includes('${')) {
            resolvedValue = '`' + innerValue + '`';
          } else {
            resolvedValue = innerValue;
          }
        }

        expanded = expanded.replace(standaloneRegex, resolvedValue);
        changed = true;
      }
    }

    const varRegex = /\$\{([^}]+)\}/g;
    const matches = Array.from(expanded.matchAll(varRegex));

    for (const match of matches) {
      const varName = match[1].trim();
      let replacement = null;

      // Check if this is a function call (e.g., buildApiPath(RESOURCES.PRODUCTS))
      const functionCallMatch = varName.match(/^(\w+)\s*\((.*)\)$/);
      if (functionCallMatch) {
        const [, funcName, argsStr] = functionCallMatch;
        console.log(`[URL Derivation] Detected function call in template: ${funcName}(${argsStr})`);

        // Try to inline the function call
        replacement = inlineFunctionCall(funcName, argsStr, symbolTable);
        if (replacement) {
          console.log(`[URL Derivation] Inlined to: ${replacement}`);
          // Strip backticks from inlined function result to avoid nested backticks
          if (replacement.startsWith('`') && replacement.endsWith('`')) {
            replacement = replacement.slice(1, -1);
            console.log(`[URL Derivation] Stripped backticks: ${replacement}`);
          }
        }
      } else if (localVars[varName]) {
        // First check local variables
        replacement = localVars[varName];

        // Handle __CALL__ markers (function or object method calls)
        if (replacement.startsWith('__CALL__')) {
          const callPattern = replacement.substring(8); // Remove "__CALL__"
          const callMatch = callPattern.match(/^([\w.]+)\(([^)]*)\)$/);
          if (callMatch) {
            const functionPath = callMatch[1]; // e.g., "buildApiPath" or "ApiPaths.users.detail"
            const args = callMatch[2]; // e.g., "RESOURCES.PRODUCTS" or "userId"

            // Check if it's a simple function call (no dots) or object method call (has dots)
            if (functionPath.includes('.')) {
              console.log(`[URL Derivation] Resolving object method call: ${functionPath}(${args})`);

              // Try to resolve the object method from symbol table
              const resolvedValue = resolveObjectMethod(functionPath, args, symbolTable);
              if (resolvedValue) {
                replacement = resolvedValue;
                console.log(`[URL Derivation]   Resolved to: ${replacement}`);
              }
            } else {
              console.log(`[URL Derivation] Resolving function call: ${functionPath}(${args})`);

              // Try to inline the function call
              const inlinedValue = inlineFunctionCall(functionPath, args, symbolTable);
              if (inlinedValue && inlinedValue !== `${functionPath}(${args})`) {
                replacement = inlinedValue;
                console.log(`[URL Derivation]   Inlined to: ${replacement}`);
              }
            }
          }
        }

        if (replacement.startsWith('`') && replacement.endsWith('`')) {
          replacement = replacement.slice(1, -1);
        }
        // Strip quotes from string literals
        if ((replacement.startsWith("'") && replacement.endsWith("'")) ||
            (replacement.startsWith('"') && replacement.endsWith('"'))) {
          replacement = replacement.slice(1, -1);
        }
      } else {
        // Then check symbol table
        const symbolId = `const:${varName}`;
        const symbol = symbolTable[symbolId];
        if (symbol) {
          replacement = symbol.value;
          if (replacement.startsWith('`') && replacement.endsWith('`')) {
            replacement = replacement.slice(1, -1);
          }
          // Strip quotes from string literals
          if ((replacement.startsWith("'") && replacement.endsWith("'")) ||
              (replacement.startsWith('"') && replacement.endsWith('"'))) {
            replacement = replacement.slice(1, -1);
          }
        }
      }

      if (replacement) {
        expanded = expanded.replace(match[0], replacement);
        changed = true;
      }
    }
  }

  return expanded;
}

/**
 * Simple variable expansion for entry point matching (legacy)
 */
function expandValue(value: string, symbolTable: Record<string, Symbol>): string {
  return expandValueWithLocals(value, symbolTable, {});
}

/**
 * Parse ternary expression handling nested backticks and template strings
 * Returns { condition, trueValue, falseValue } or null if not a ternary
 */
function parseTernaryExpression(expr: string): { condition: string; trueValue: string; falseValue: string } | null {
  // Find the ? operator, accounting for nested structures
  let questionMarkIndex = -1;
  let depth = 0;
  let inBacktick = false;

  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];

    if (char === '`') {
      inBacktick = !inBacktick;
    } else if (!inBacktick) {
      if (char === '(' || char === '{' || char === '[') {
        depth++;
      } else if (char === ')' || char === '}' || char === ']') {
        depth--;
      } else if (char === '?' && depth === 0) {
        questionMarkIndex = i;
        break;
      }
    }
  }

  if (questionMarkIndex === -1) {
    return null; // Not a ternary expression
  }

  const condition = expr.substring(0, questionMarkIndex).trim();
  const afterQuestion = expr.substring(questionMarkIndex + 1);

  // Find the : operator, accounting for nested structures
  let colonIndex = -1;
  depth = 0;
  inBacktick = false;

  for (let i = 0; i < afterQuestion.length; i++) {
    const char = afterQuestion[i];

    if (char === '`') {
      inBacktick = !inBacktick;
    } else if (!inBacktick) {
      if (char === '(' || char === '{' || char === '[') {
        depth++;
      } else if (char === ')' || char === '}' || char === ']') {
        depth--;
      } else if (char === ':' && depth === 0) {
        colonIndex = i;
        break;
      }
    }
  }

  if (colonIndex === -1) {
    return null; // Invalid ternary expression
  }

  const trueValue = afterQuestion.substring(0, colonIndex).trim();
  const falseValue = afterQuestion.substring(colonIndex + 1).trim();

  return { condition, trueValue, falseValue };
}

/**
 * Find entry points that might contain the target URL
 */
function findEntryPoints(targetUrl: string, symbolTable: Record<string, Symbol>): string[] {
  const targetSegments = extractPathSegments(targetUrl);
  const entryPoints: Array<{ id: string; score: number }> = [];

  console.log('[URL Derivation] Finding entry points for segments:', targetSegments);

  for (const [symbolId, symbol] of Object.entries(symbolTable)) {
    let matchCount = 0;
    let checkValue = '';

    // For functions, check the return value pattern (expand variables first)
    if (symbol.type === 'function' && symbol.returns) {
      // Extract local variables from function body
      const localVars = extractLocalVariables(symbol.value);
      checkValue = expandValueWithLocals(symbol.returns, symbolTable, localVars);
      console.log(`[URL Derivation]   Checking function ${symbol.name}: returns="${symbol.returns}" locals=${JSON.stringify(localVars)} expanded="${checkValue}"`);
      matchCount = targetSegments.filter(seg =>
        checkValue.toLowerCase().includes(seg.toLowerCase())
      ).length;
    } else {
      // For constants/templates, check the value (expand variables first)
      checkValue = expandValue(symbol.value, symbolTable);
      console.log(`[URL Derivation]   Checking ${symbol.type} ${symbol.name}: value="${symbol.value}" expanded="${checkValue}"`);
      matchCount = targetSegments.filter(seg =>
        checkValue.toLowerCase().includes(seg.toLowerCase())
      ).length;
    }

    if (matchCount > 0) {
      // Give functions a slight boost since they can generate dynamic URLs
      const baseScore = matchCount / targetSegments.length;
      const finalScore = symbol.type === 'function' ? baseScore * 1.1 : baseScore;
      console.log(`[URL Derivation]     ✓ Match! Score: ${matchCount}/${targetSegments.length} (final: ${finalScore.toFixed(2)})`);
      entryPoints.push({
        id: symbolId,
        score: finalScore,
      });
    }
  }

  console.log(`[URL Derivation] Found ${entryPoints.length} entry points`);

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

  // For functions, use the return value; for constants, use the value
  let currentValue: string;
  if (entrySymbol.type === 'function' && entrySymbol.returns) {
    // Check if this is a function call (e.g., buildApiPath(RESOURCES.PRODUCTS))
    const functionCallMatch = entrySymbol.returns.match(/^(\w+)\s*\((.*)\)$/);
    if (functionCallMatch) {
      const [, funcName, argsStr] = functionCallMatch;
      console.log(`[URL Derivation] Detected function call: ${funcName}(${argsStr})`);

      // Try to inline the function call
      currentValue = inlineFunctionCall(funcName, argsStr, symbolTable);
      console.log(`[URL Derivation] Inlined to: ${currentValue}`);
    } else {
      // Extract local variables and expand the return value
      const localVars = extractLocalVariables(entrySymbol.value);
      currentValue = expandValueWithLocals(entrySymbol.returns, symbolTable, localVars);
      console.log(`[URL Derivation] Starting from function ${entrySymbol.name}, returns: ${entrySymbol.returns}, expanded: ${currentValue}`);

      // After expansion, check if result contains a ternary expression that needs evaluation
      // Use a more robust parser that handles nested backticks
      const ternaryParts = parseTernaryExpression(currentValue);
      if (ternaryParts) {
        const { condition, trueValue, falseValue } = ternaryParts;
        console.log(`[URL Derivation] Found ternary in expanded result: condition="${condition}", true="${trueValue}", false="${falseValue}"`);

        // Evaluate condition - check if it's a truthy value
        const conditionTrimmed = condition.trim();
        const falsyValues = ['', '0', 'false', 'null', 'undefined', 'NaN', '""', "''"];

        if (falsyValues.includes(conditionTrimmed)) {
          console.log(`[URL Derivation] Condition "${conditionTrimmed}" is falsy, using false branch`);
          currentValue = falseValue.trim();
        } else {
          console.log(`[URL Derivation] Condition "${conditionTrimmed}" is truthy, using true branch`);
          currentValue = trueValue.trim();
        }

        // Strip backticks from the selected branch
        if (currentValue.startsWith('`') && currentValue.endsWith('`')) {
          currentValue = currentValue.slice(1, -1);
        }

        console.log(`[URL Derivation] After ternary evaluation: ${currentValue}`);
      }
    }
  } else {
    currentValue = entrySymbol.value;
    console.log(`[URL Derivation] Starting from ${entrySymbol.type} ${entrySymbol.name}, value: ${currentValue}`);
  }

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

    let expanded = value;

    // Extract template string content if wrapped in backticks
    if (value.startsWith('`') && value.endsWith('`')) {
      expanded = value.slice(1, -1);
    }

    // Keep expanding until no more variables found
    let hasChanges = true;
    let iterations = 0;
    while (hasChanges && iterations < 20) {
      hasChanges = false;
      iterations++;

      // Find all ${...} variables in current state
      const varRegex = /\$\{([^}]+)\}/g;
      const matches = Array.from(expanded.matchAll(varRegex));

      for (const match of matches) {
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

          // Strip backticks from replacement if present
          if (replacement.startsWith('`') && replacement.endsWith('`')) {
            replacement = replacement.slice(1, -1);
          }

          expanded = expanded.replace(match[0], replacement);
          hasChanges = true;
        } else if (!symbolId && !missingSymbols.includes(varName)) {
          // Missing symbol - use placeholder
          missingSymbols.push(varName);
          expanded = expanded.replace(match[0], `:${varName}`);
          hasChanges = true;
        }
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

  // Split by / and map segments, replacing IDs with placeholders to preserve structure
  const segments = path.split('/').map(seg => {
    if (!seg) return null;

    // Replace pure numeric IDs with :id placeholder
    if (/^\d+$/.test(seg)) return ':id';

    // Replace long hex strings (SHA, tokens, etc.) with :token
    if (/^[0-9a-f]{20,}$/i.test(seg)) return ':token';

    // Replace UUIDs with :uuid
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';

    // Replace MongoDB ObjectIds (24 hex chars) with :id
    if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';

    // Keep common API path segments even if short
    const commonSegments = ['api', 'v1', 'v2', 'v3', 'v4', 'v5', 'app', 'web', 'p'];
    if (commonSegments.includes(seg.toLowerCase())) return seg;

    // Skip short random strings (likely IDs) - but only if not a common segment
    if (seg.length <= 2 && /^[a-z0-9]+$/i.test(seg)) return null;

    return seg;
  }).filter(seg => seg !== null) as string[];

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
  // Try to match return statement (use 's' flag for multiline)
  const returnMatch = code.match(/return\s+([\s\S]+?)(?:;|\n\}|$)/);
  if (!returnMatch) {
    return undefined;
  }

  let value = returnMatch[1].trim();

  // Handle HTTP client calls like: return this.client.get(path)
  const httpCallMatch = value.match(/(?:this\.)?(?:client|axios|fetch|http)\.(?:get|post|put|delete|patch|request)\s*\(\s*([^,)]+)/);
  if (httpCallMatch) {
    value = httpCallMatch[1].trim();
  }

  // Keep ternary expressions intact - they will be evaluated during inlining
  // Don't extract just one branch, keep the whole expression
  // The inlineFunctionCall function will handle evaluation

  // Don't inline variables here - let expandValueWithLocals handle it
  // This preserves __CALL__ markers and allows proper function inlining

  // Handle variable references - look for const/let/var declarations in the code
  if (!value.startsWith('`') && !value.startsWith('"') && !value.startsWith("'")) {
    // It's a variable reference, try to find its definition
    // Only match simple variable names (alphanumeric + underscore), not complex expressions
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      const varMatch = code.match(new RegExp(`(?:const|let|var)\\s+${escapeRegExp(value)}\\s*=\\s*([\\s\\S]+?)(?:;|\\n)`));
      if (varMatch) {
        let varValue = varMatch[1].trim();

        // Handle .replace() calls on template strings
        // Pattern: template.replace(':placeholder', variable)
        const replaceMatch = varValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.replace\s*\(\s*['"](:?[^'"]+)['"]\s*,\s*([^)]+)\)/);
        if (replaceMatch) {
          const [, templateVar] = replaceMatch;
          // Find the template variable definition
          const templateMatch = code.match(new RegExp(`(?:const|let|var)\\s+${escapeRegExp(templateVar)}\\s*=\\s*([\\s\\S]+?)(?:;|\\n)`));
          if (templateMatch) {
            // Use the template value directly, keeping placeholders intact
            varValue = templateMatch[1].trim();
          }
        }

        value = varValue;
      }
    }
  }

  // Remove quotes if not a template string
  if (!value.startsWith('`')) {
    value = value.replace(/^['"]+|['"]+$/g, '');
  }

  // Only return if it looks like a URL pattern
  if (value.includes('/') || value.includes('${')) {
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
  let normalizedPattern = normalize(pattern);

  // Remove base URL placeholders (like :this.baseURL, ${this.baseURL}) from the beginning
  normalizedPattern = normalizedPattern.replace(/^:?this\.baseurl\/?/i, '').replace(/^\$\{this\.baseurl\}\/?/i, '');

  // Remove query strings and hash from both target and pattern for comparison
  const cleanTarget = normalizedTarget.split('?')[0].split('#')[0];
  const cleanPattern = normalizedPattern.split('?')[0].split('#')[0];

  // Exact match
  if (cleanTarget === cleanPattern) {
    return 100;
  }

  // Pattern match (with placeholders)
  // First, escape all regex special characters except placeholders
  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Replace placeholders with regex patterns, then escape the rest
  let patternRegex = cleanPattern;

  // Mark placeholders temporarily
  patternRegex = patternRegex
    .replace(/\$\{[^}]+\}/g, '___PLACEHOLDER___')
    .replace(/:[a-zA-Z_]\w*/g, '___PLACEHOLDER___');

  // Escape regex special characters
  patternRegex = escapeRegex(patternRegex);

  // Replace placeholder markers with regex pattern
  patternRegex = patternRegex.replace(/___PLACEHOLDER___/g, '[^/]+');

  try {
    const regex = new RegExp(`^${patternRegex}$`);

    if (regex.test(cleanTarget)) {
      // Calculate similarity based on static vs dynamic segments
      const targetSegments = cleanTarget.split('/').filter(Boolean);
      const patternSegments = cleanPattern.split('/').filter(Boolean);

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
  } catch (error) {
    // If regex construction fails, fall through to partial match
    console.log(`[URL Derivation] Regex error for pattern "${pattern}":`, error);
  }

  // Partial match
  const targetSegments = cleanTarget.split('/').filter(Boolean);
  const patternSegments = cleanPattern.split('/').filter(Boolean);

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

/**
 * Inline a function call by substituting arguments into the function body
 */
function inlineFunctionCall(
  functionName: string,
  argsStr: string,
  symbolTable: Record<string, Symbol>
): string {
  // Find the function definition
  const funcSymbol = symbolTable[`func:${functionName}`];
  if (!funcSymbol || !funcSymbol.returns) {
    console.log(`[URL Derivation] Function ${functionName} not found in symbol table`);
    return `${functionName}(${argsStr})`;
  }

  // Parse arguments
  const args = argsStr
    .split(',')
    .map((arg: string) => arg.trim())
    .filter((arg: string) => arg.length > 0);

  console.log(`[URL Derivation] Inlining ${functionName} with args: ${args.join(', ')}`);

  // Extract parameter names from function code
  const paramMatch = funcSymbol.value.match(/function\s+\w+\s*\(([^)]*)\)/);
  if (!paramMatch) {
    console.log(`[URL Derivation] Could not extract parameters from function`);
    return `${functionName}(${argsStr})`;
  }

  // Parse parameters and their default values
  const paramDefs = paramMatch[1]
    .split(',')
    .map((p: string) => {
      const parts = p.trim().split('=');
      return {
        name: parts[0].trim(),
        defaultValue: parts.length > 1 ? parts[1].trim() : undefined
      };
    })
    .filter((p) => p.name.length > 0);

  const params = paramDefs.map(p => p.name);
  console.log(`[URL Derivation] Function parameters: ${params.join(', ')}`);

  // Build argument substitution map
  const argMap: Record<string, string> = {};
  for (let i = 0; i < paramDefs.length; i++) {
    if (i < args.length) {
      // Resolve argument value
      const argValue = resolveArgumentValue(args[i], symbolTable);
      argMap[paramDefs[i].name] = argValue;
      console.log(`[URL Derivation]   ${paramDefs[i].name} = ${argValue}`);
    } else if (paramDefs[i].defaultValue !== undefined) {
      // Use default value for parameters not provided
      const defaultVal = paramDefs[i].defaultValue!;
      // Remove quotes from string literals
      const cleanDefault = defaultVal.replace(/^['"`]|['"`]$/g, '');
      argMap[paramDefs[i].name] = cleanDefault;
      console.log(`[URL Derivation]   ${paramDefs[i].name} = ${cleanDefault} (default)`);
    }
  }

  // Extract local variables from function body
  const localVars = extractLocalVariables(funcSymbol.value);
  console.log(`[URL Derivation] Local variables: ${JSON.stringify(localVars)}`);

  // Don't substitute parameters in local variables yet - pass them to expandValueWithLocals
  // so it can handle __CALL__ markers properly
  const substitutedLocals: Record<string, string> = { ...localVars };
  console.log(`[URL Derivation] Local variables (before expansion): ${JSON.stringify(substitutedLocals)}`);

  // First, check if return value contains a ternary expression
  // Pattern: condition ? trueValue : falseValue
  let returnValue = funcSymbol.returns;
  const ternaryMatch = returnValue.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);

  if (ternaryMatch) {
    const [, condition, trueValue, falseValue] = ternaryMatch;
    console.log(`[URL Derivation] Found ternary expression: condition="${condition}", true="${trueValue}", false="${falseValue}"`);

    // Evaluate the condition by substituting parameters
    let evaluatedCondition = condition.trim();
    for (const [paramName, paramValue] of Object.entries(argMap)) {
      // Replace parameter name in condition
      evaluatedCondition = evaluatedCondition.replace(
        new RegExp(`\\b${paramName}\\b`, 'g'),
        paramValue === '' ? '""' : paramValue
      );
    }

    console.log(`[URL Derivation] Evaluated condition: "${evaluatedCondition}"`);

    // Check if condition is falsy
    const falsyValues = ['', '0', 'false', 'null', 'undefined', 'NaN', '""', "''"];
    if (falsyValues.includes(evaluatedCondition)) {
      console.log(`[URL Derivation] Condition is falsy, using false branch: ${falseValue}`);
      returnValue = falseValue.trim();
    } else {
      console.log(`[URL Derivation] Condition is truthy, using true branch: ${trueValue}`);
      returnValue = trueValue.trim();
    }
  }

  // Merge argMap into substitutedLocals so expandValueWithLocals can access parameters
  // Don't do string replacement here - let expandValueWithLocals handle it properly
  const localsWithArgs: Record<string, string> = { ...substitutedLocals, ...argMap };

  console.log(`[URL Derivation] Return value before expansion: ${returnValue}`)
  console.log(`[URL Derivation] Locals with args:`, localsWithArgs);

  // Expand with local variables (including parameters) and symbol table
  const expanded = expandValueWithLocals(returnValue, symbolTable, localsWithArgs);
  console.log(`[URL Derivation] Final expanded value: ${expanded}`);

  return expanded;
}

/**
 * Resolve an argument value (e.g., RESOURCES.PRODUCTS -> 'products')
 */
function resolveArgumentValue(arg: string, symbolTable: Record<string, Symbol>): string {
  // If it's a string literal, return as-is
  if (arg.startsWith("'") || arg.startsWith('"') || arg.startsWith('`')) {
    return arg;
  }

  // If it's a constant reference (e.g., RESOURCES.PRODUCTS)
  const symbolId = `const:${arg}`;
  if (symbolTable[symbolId]) {
    const value = symbolTable[symbolId].value;
    console.log(`[URL Derivation]   Resolved ${arg} -> ${value}`);
    return value;
  }

  // Handle object property access (e.g., RESOURCES.PRODUCTS)
  if (arg.includes('.')) {
    const [objectName, propertyName] = arg.split('.');
    const objectSymbolId = `const:${objectName}`;

    if (symbolTable[objectSymbolId]) {
      const objectCode = symbolTable[objectSymbolId].value;
      console.log(`[URL Derivation]   Found object ${objectName}, extracting property ${propertyName}`);

      // Extract property value from object literal
      // Match: PROPERTY: 'value' or PROPERTY: "value"
      const propertyRegex = new RegExp(`${propertyName}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
      const match = objectCode.match(propertyRegex);

      if (match) {
        const propertyValue = match[1];
        console.log(`[URL Derivation]   Resolved ${arg} -> '${propertyValue}'`);
        return propertyValue;
      } else {
        console.log(`[URL Derivation]   Could not extract property ${propertyName} from ${objectName}`);
      }
    }
  }

  // Try without quotes
  const plainValue = arg.replace(/^['"`]|['"`]$/g, '');
  console.log(`[URL Derivation]   Could not resolve ${arg}, using plain value: ${plainValue}`);
  return plainValue;
}

/**
 * Extract function calls from code
 */
function extractFunctionCalls(code: string, functionName: string): Array<{
  functionName: string;
  args: string[];
  fullMatch: string;
}> {
  const results: Array<{ functionName: string; args: string[]; fullMatch: string }> = [];

  // Match: functionName(arg1, arg2, ...)
  // This regex handles simple cases, not nested function calls
  const callRegex = new RegExp(`${functionName}\\s*\\(([^)]*)\\)`, 'g');
  let match;

  while ((match = callRegex.exec(code)) !== null) {
    const argsString = match[1];
    const args = argsString
      .split(',')
      .map((arg: string) => arg.trim())
      .filter((arg: string) => arg.length > 0);

    results.push({
      functionName,
      args,
      fullMatch: match[0],
    });
  }

  return results;
}
