/**
 * Relationship Builder - Build relationships between code entities
 *
 * This module takes the output from AST analysis and builds relationships
 * in the database: imports, constant references, URL usages, and call graphs.
 */
import * as path from 'path';
// ============================================
// Relationship Builder Class
// ============================================
export class RelationshipBuilder {
    constructor(db) {
        this.db = db;
    }
    /**
     * Build all relationships for a file's AST analysis result
     */
    async buildRelationships(repoId, fileId, filePath, astResult) {
        const result = {
            importsCreated: 0,
            constantReferencesCreated: 0,
            urlUsagesCreated: 0,
            callGraphEdgesCreated: 0,
            fileDependenciesCreated: 0,
        };
        try {
            // 1. Build import relationships
            result.importsCreated = await this.buildImportRelationships(repoId, fileId, filePath, astResult.imports);
            // 2. Build constant references
            result.constantReferencesCreated = await this.buildConstantReferences(repoId, fileId, astResult.stringConstants);
            // 3. Build URL usages
            result.urlUsagesCreated = await this.buildURLUsages(repoId, fileId, astResult.urlPatterns);
            // 4. Build call graph edges
            result.callGraphEdgesCreated = await this.buildCallGraphEdges(repoId, fileId, astResult.functions);
            // 5. Update file dependencies (triggered by import_relations trigger)
            // This happens automatically via the database trigger
            return result;
        }
        catch (error) {
            console.error(`Error building relationships for file ${filePath}:`, error);
            throw error;
        }
    }
    /**
     * Build import relationships
     */
    async buildImportRelationships(repoId, importerFileId, importerFilePath, imports) {
        let count = 0;
        for (const imp of imports) {
            try {
                // Resolve the imported file path
                const importedFilePath = this.resolveImportPath(importerFilePath, imp.importPath);
                let importedFileId = null;
                if (!imp.isExternal && importedFilePath) {
                    // Find the imported file in the database
                    const fileResult = await this.db.query(`
            SELECT id FROM files
            WHERE repo_id = $1 AND path = $2
          `, [repoId, importedFilePath]);
                    if (fileResult.rows.length > 0) {
                        importedFileId = fileResult.rows[0].id;
                    }
                }
                // Insert import relation
                await this.db.query(`
          INSERT INTO import_relations (
            repo_id,
            importer_file_id,
            importer_line,
            imported_file_id,
            imported_symbol,
            import_type,
            import_path,
            is_external,
            alias
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT DO NOTHING
        `, [
                    repoId,
                    importerFileId,
                    imp.line,
                    importedFileId,
                    imp.importedSymbol || null,
                    imp.importType,
                    imp.importPath,
                    imp.isExternal,
                    imp.alias || null,
                ]);
                count++;
            }
            catch (error) {
                console.error(`Error creating import relation for ${imp.importPath}:`, error);
            }
        }
        return count;
    }
    /**
     * Build constant references
     */
    async buildConstantReferences(repoId, fileId, constants) {
        let count = 0;
        for (const constant of constants) {
            try {
                // Find the constant in the database
                const constantResult = await this.db.query(`
          SELECT id FROM string_constants
          WHERE repo_id = $1
            AND file_id = $2
            AND string_value = $3
            AND line_start = $4
        `, [repoId, fileId, constant.stringValue, constant.lineStart]);
                if (constantResult.rows.length === 0) {
                    continue;
                }
                const constantId = constantResult.rows[0].id;
                // Find references to this constant in other files
                // This is done by searching for the symbol name in code chunks
                if (constant.symbolName && constant.exportType !== 'none') {
                    const references = await this.findConstantReferences(repoId, fileId, constant.symbolName);
                    for (const ref of references) {
                        await this.db.query(`
              INSERT INTO constant_references (
                repo_id,
                referrer_file_id,
                referrer_chunk_id,
                referrer_line,
                referrer_context,
                constant_id,
                reference_type
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT DO NOTHING
            `, [repoId, ref.fileId, ref.chunkId, ref.line, ref.context, constantId, ref.type]);
                        count++;
                    }
                }
            }
            catch (error) {
                console.error(`Error creating constant references for ${constant.symbolName}:`, error);
            }
        }
        return count;
    }
    /**
     * Find references to a constant symbol
     */
    async findConstantReferences(repoId, definitionFileId, symbolName) {
        const references = [];
        // Find files that import this symbol
        const importers = await this.db.query(`
      SELECT
        ir.importer_file_id,
        ir.alias,
        ir.import_type
      FROM import_relations ir
      WHERE ir.repo_id = $1
        AND ir.imported_file_id = $2
        AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
    `, [repoId, definitionFileId, symbolName]);
        for (const importer of importers.rows) {
            const searchSymbol = importer.alias || symbolName;
            // Search for usage in code chunks
            const chunks = await this.db.query(`
        SELECT id, content, line_start
        FROM code_chunks
        WHERE file_id = $1
      `, [importer.importer_file_id]);
            for (const chunk of chunks.rows) {
                const lines = chunk.content.split('\n');
                lines.forEach((line, index) => {
                    const regex = new RegExp(`\\b${this.escapeRegex(searchSymbol)}\\b`);
                    if (regex.test(line)) {
                        references.push({
                            fileId: importer.importer_file_id,
                            chunkId: chunk.id,
                            line: chunk.line_start + index,
                            context: line.trim().slice(0, 200),
                            type: importer.import_type === 'namespace' ? 'namespace_access' : 'direct_reference',
                        });
                    }
                });
            }
        }
        return references;
    }
    /**
     * Build URL usages
     */
    async buildURLUsages(repoId, fileId, urlPatterns) {
        let count = 0;
        for (const pattern of urlPatterns) {
            try {
                // Find or create the URL pattern
                const patternResult = await this.db.query(`
          SELECT id FROM url_patterns
          WHERE repo_id = $1
            AND normalized_pattern = $2
            AND method = $3
        `, [repoId, pattern.normalizedPattern, pattern.method || null]);
                let patternId;
                if (patternResult.rows.length > 0) {
                    patternId = patternResult.rows[0].id;
                }
                else {
                    // Create new URL pattern
                    const insertResult = await this.db.query(`
            INSERT INTO url_patterns (
              repo_id,
              pattern,
              normalized_pattern,
              method,
              definition_file_id,
              definition_line,
              definition_code,
              components,
              path_params,
              query_params
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
          `, [
                        repoId,
                        pattern.pattern,
                        pattern.normalizedPattern,
                        pattern.method || null,
                        fileId,
                        pattern.definitionLine,
                        pattern.definitionCode,
                        JSON.stringify(pattern.components),
                        JSON.stringify(pattern.pathParams),
                        JSON.stringify(pattern.queryParams),
                    ]);
                    patternId = insertResult.rows[0].id;
                }
                // Find the chunk containing this URL usage
                const chunkResult = await this.db.query(`
          SELECT id FROM code_chunks
          WHERE file_id = $1
            AND line_start <= $2
            AND line_end >= $2
          ORDER BY line_start DESC
          LIMIT 1
        `, [fileId, pattern.definitionLine]);
                const chunkId = chunkResult.rows.length > 0 ? chunkResult.rows[0].id : null;
                // Create URL usage
                await this.db.query(`
          INSERT INTO url_usages (
            repo_id,
            url_pattern_id,
            usage_file_id,
            usage_chunk_id,
            usage_line,
            usage_code,
            usage_context,
            http_method
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
        `, [
                    repoId,
                    patternId,
                    fileId,
                    chunkId,
                    pattern.definitionLine,
                    pattern.definitionCode,
                    this.inferUsageContext(pattern.definitionCode),
                    pattern.method || null,
                ]);
                count++;
            }
            catch (error) {
                console.error(`Error creating URL usage for ${pattern.pattern}:`, error);
            }
        }
        return count;
    }
    /**
     * Build call graph edges
     */
    async buildCallGraphEdges(repoId, fileId, functions) {
        let count = 0;
        for (const func of functions) {
            try {
                // Find the chunk for this function
                const chunkResult = await this.db.query(`
          SELECT id FROM code_chunks
          WHERE file_id = $1
            AND line_start <= $2
            AND line_end >= $3
          ORDER BY line_start DESC
          LIMIT 1
        `, [fileId, func.lineStart, func.lineEnd]);
                if (chunkResult.rows.length === 0) {
                    continue;
                }
                const fromChunkId = chunkResult.rows[0].id;
                // Extract function calls from the function body
                const calls = this.extractFunctionCalls(func.code);
                for (const call of calls) {
                    // Try to resolve the called function
                    const toChunk = await this.resolveCalledFunction(repoId, fileId, call.name);
                    await this.db.query(`
            INSERT INTO call_graph (
              repo_id,
              from_chunk_id,
              to_chunk_id,
              to_symbol,
              call_type,
              arguments,
              call_line
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING
          `, [
                        repoId,
                        fromChunkId,
                        toChunk?.id || null,
                        call.name,
                        call.type,
                        JSON.stringify(call.arguments),
                        func.lineStart + call.lineOffset,
                    ]);
                    count++;
                }
            }
            catch (error) {
                console.error(`Error creating call graph edges for ${func.name}:`, error);
            }
        }
        return count;
    }
    /**
     * Extract function calls from code
     */
    extractFunctionCalls(code) {
        const calls = [];
        const lines = code.split('\n');
        lines.forEach((line, index) => {
            // Simple regex to find function calls
            // This is a basic implementation; AST-based extraction would be more accurate
            const callRegex = /(\w+)\s*\(/g;
            let match;
            while ((match = callRegex.exec(line)) !== null) {
                const funcName = match[1];
                // Skip common keywords
                const keywords = ['if', 'for', 'while', 'switch', 'catch', 'function', 'return'];
                if (keywords.includes(funcName)) {
                    continue;
                }
                calls.push({
                    name: funcName,
                    type: 'direct',
                    arguments: [],
                    lineOffset: index,
                });
            }
            // Detect async/await calls
            if (line.includes('await')) {
                const awaitRegex = /await\s+(\w+)/g;
                let awaitMatch;
                while ((awaitMatch = awaitRegex.exec(line)) !== null) {
                    calls.push({
                        name: awaitMatch[1],
                        type: 'async_await',
                        arguments: [],
                        lineOffset: index,
                    });
                }
            }
            // Detect promise chains
            if (line.includes('.then(')) {
                calls.push({
                    name: 'then',
                    type: 'promise',
                    arguments: [],
                    lineOffset: index,
                });
            }
        });
        return calls;
    }
    /**
     * Resolve a called function to its chunk
     */
    async resolveCalledFunction(repoId, callerFileId, functionName) {
        // First, try to find in the same file
        const sameFileResult = await this.db.query(`
      SELECT id FROM code_chunks
      WHERE file_id = $1
        AND symbol_name = $2
      LIMIT 1
    `, [callerFileId, functionName]);
        if (sameFileResult.rows.length > 0) {
            return sameFileResult.rows[0];
        }
        // Try to find in imported files
        const importedResult = await this.db.query(`
      SELECT cc.id
      FROM import_relations ir
      JOIN code_chunks cc ON ir.imported_file_id = cc.file_id
      WHERE ir.repo_id = $1
        AND ir.importer_file_id = $2
        AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
        AND cc.symbol_name = $3
      LIMIT 1
    `, [repoId, callerFileId, functionName]);
        if (importedResult.rows.length > 0) {
            return importedResult.rows[0];
        }
        return null;
    }
    /**
     * Resolve import path to absolute file path
     */
    resolveImportPath(importerPath, importPath) {
        // Handle relative imports
        if (importPath.startsWith('.')) {
            const importerDir = path.dirname(importerPath);
            let resolvedPath = path.resolve(importerDir, importPath);
            // Try common extensions
            const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
            for (const ext of extensions) {
                const testPath = resolvedPath + ext;
                // We can't check file existence here, so return the most likely path
                if (ext === '' || ext.startsWith('.')) {
                    return testPath;
                }
            }
            return resolvedPath + '.ts'; // Default to .ts
        }
        // Handle absolute imports (would need project configuration to resolve)
        // For now, return null for external/absolute imports
        return null;
    }
    /**
     * Infer usage context from code
     */
    inferUsageContext(code) {
        if (code.includes('axios') || code.includes('fetch')) {
            return 'api_call';
        }
        if (code.includes('.get(') || code.includes('.post(')) {
            return 'route_definition';
        }
        if (code.includes('router')) {
            return 'router';
        }
        return 'unknown';
    }
    /**
     * Escape special regex characters
     */
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    /**
     * Clean up old relationships for a file before rebuilding
     */
    async cleanupFileRelationships(repoId, fileId) {
        await this.db.query('BEGIN');
        try {
            // Delete import relations
            await this.db.query(`
        DELETE FROM import_relations
        WHERE repo_id = $1 AND importer_file_id = $2
      `, [repoId, fileId]);
            // Delete constant references
            await this.db.query(`
        DELETE FROM constant_references
        WHERE repo_id = $1 AND referrer_file_id = $2
      `, [repoId, fileId]);
            // Delete URL usages
            await this.db.query(`
        DELETE FROM url_usages
        WHERE repo_id = $1 AND usage_file_id = $2
      `, [repoId, fileId]);
            // Delete call graph edges
            await this.db.query(`
        DELETE FROM call_graph
        WHERE repo_id = $1 AND from_chunk_id IN (
          SELECT id FROM code_chunks WHERE file_id = $2
        )
      `, [repoId, fileId]);
            await this.db.query('COMMIT');
        }
        catch (error) {
            await this.db.query('ROLLBACK');
            throw error;
        }
    }
}
