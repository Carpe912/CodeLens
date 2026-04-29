/**
 * AST Analyzer - Extract structured information from TypeScript/JavaScript code
 *
 * This module uses ts-morph to parse source code and extract:
 * - String constants (URLs, error codes, event names, etc.)
 * - URL patterns and their components
 * - Functions and their signatures
 * - Classes and interfaces
 * - Import/export relationships
 */

import { Project, SourceFile, Node, SyntaxKind, ts } from 'ts-morph';
import * as path from 'path';

// ============================================
// Type Definitions
// ============================================

export interface StringConstant {
  symbolName?: string;
  stringValue: string;
  constantType: string;
  lineStart: number;
  lineEnd: number;
  parentObject?: string;
  exportType?: 'named' | 'default' | 'none';
  code: string;
}

export interface URLPattern {
  pattern: string;
  normalizedPattern: string;
  method?: string;
  components: URLComponent[];
  pathParams: string[];
  queryParams: string[];
  definitionLine: number;
  definitionCode: string;
}

export interface URLComponent {
  type: 'literal' | 'variable' | 'param';
  value: string;
  source?: {
    file?: string;
    symbol?: string;
  };
}

export interface FunctionInfo {
  name: string;
  fullName: string;
  signature: string;
  returnType?: string;
  functionType: 'function' | 'method' | 'arrow' | 'constructor';
  visibility?: 'public' | 'private' | 'protected';
  isAsync: boolean;
  isExported: boolean;
  parameters: ParameterInfo[];
  cyclomaticComplexity: number;
  linesOfCode: number;
  lineStart: number;
  lineEnd: number;
  code: string;
}

export interface ParameterInfo {
  name: string;
  type?: string;
  isOptional: boolean;
  defaultValue?: string;
}

export interface ClassInfo {
  name: string;
  fullName: string;
  classType: 'class' | 'interface' | 'type' | 'enum';
  extendsClass?: string;
  implementsInterfaces: string[];
  properties: PropertyInfo[];
  methods: string[];
  decorators: string[];
  lineStart: number;
  lineEnd: number;
  code: string;
}

export interface PropertyInfo {
  name: string;
  type?: string;
  visibility?: string;
  isStatic: boolean;
  isReadonly: boolean;
}

export interface ImportInfo {
  importedSymbol?: string;
  importType: 'named' | 'default' | 'namespace' | 'side-effect';
  importPath: string;
  isExternal: boolean;
  alias?: string;
  line: number;
}

export interface ASTAnalysisResult {
  stringConstants: StringConstant[];
  urlPatterns: URLPattern[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  imports: ImportInfo[];
}

// ============================================
// AST Analyzer Class
// ============================================

export class ASTAnalyzer {
  private project: Project;

  constructor() {
    this.project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.CommonJS,
        allowJs: true,
        checkJs: false,
        noEmit: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Analyze a source file and extract all structured information
   */
  async analyzeFile(filePath: string, content: string): Promise<ASTAnalysisResult> {
    const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });

    const result: ASTAnalysisResult = {
      stringConstants: [],
      urlPatterns: [],
      functions: [],
      classes: [],
      imports: [],
    };

    try {
      // Extract imports first (needed for dependency tracking)
      result.imports = this.extractImports(sourceFile);

      // Extract string constants
      result.stringConstants = this.extractStringConstants(sourceFile);

      // Extract URL patterns from constants
      result.urlPatterns = this.extractURLPatterns(result.stringConstants, sourceFile);

      // Extract functions
      result.functions = this.extractFunctions(sourceFile);

      // Extract classes
      result.classes = this.extractClasses(sourceFile);
    } catch (error) {
      console.error(`Error analyzing file ${filePath}:`, error);
    } finally {
      // Clean up to avoid memory leaks
      this.project.removeSourceFile(sourceFile);
    }

    return result;
  }

  /**
   * Extract all string constants from the source file
   */
  private extractStringConstants(sourceFile: SourceFile): StringConstant[] {
    const constants: StringConstant[] = [];

    // Find all variable declarations with string values
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((varDecl) => {
      const initializer = varDecl.getInitializer();
      if (!initializer) return;

      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;

      const varStatement = varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      const isExported = varStatement?.isExported() || false;

      constants.push({
        symbolName: varDecl.getName(),
        stringValue,
        constantType: this.inferConstantType(stringValue),
        lineStart: varDecl.getStartLineNumber(),
        lineEnd: varDecl.getEndLineNumber(),
        exportType: isExported ? 'named' : 'none',
        code: varDecl.getText(),
      });
    });

    // Find all property assignments in objects
    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((propAssign) => {
      const initializer = propAssign.getInitializer();
      if (!initializer) return;

      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;

      const objectLiteral = propAssign.getFirstAncestorByKind(SyntaxKind.ObjectLiteralExpression);
      const parentVar = objectLiteral?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

      constants.push({
        symbolName: propAssign.getName(),
        stringValue,
        constantType: this.inferConstantType(stringValue),
        lineStart: propAssign.getStartLineNumber(),
        lineEnd: propAssign.getEndLineNumber(),
        parentObject: parentVar?.getName(),
        exportType: 'none',
        code: propAssign.getText(),
      });
    });

    // Find enum members
    sourceFile.getDescendantsOfKind(SyntaxKind.EnumMember).forEach((enumMember) => {
      const initializer = enumMember.getInitializer();
      if (!initializer) return;

      const stringValue = this.extractStringValue(initializer);
      if (!stringValue) return;

      const enumDecl = enumMember.getFirstAncestorByKind(SyntaxKind.EnumDeclaration);

      constants.push({
        symbolName: enumMember.getName(),
        stringValue,
        constantType: 'enum_value',
        lineStart: enumMember.getStartLineNumber(),
        lineEnd: enumMember.getEndLineNumber(),
        parentObject: enumDecl?.getName(),
        exportType: enumDecl?.isExported() ? 'named' : 'none',
        code: enumMember.getText(),
      });
    });

    return constants;
  }

  /**
   * Extract string value from various node types
   */
  private extractStringValue(node: Node): string | null {
    // String literal
    if (Node.isStringLiteral(node)) {
      return node.getLiteralValue();
    }

    // Template literal without expressions
    if (Node.isNoSubstitutionTemplateLiteral(node)) {
      return node.getLiteralValue();
    }

    // Template literal with expressions (try to extract pattern)
    if (Node.isTemplateExpression(node)) {
      return this.extractTemplatePattern(node);
    }

    // Binary expression (string concatenation)
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const left = this.extractStringValue(node.getLeft());
      const right = this.extractStringValue(node.getRight());
      if (left && right) {
        return left + right;
      }
      if (left) return left;
      if (right) return right;
    }

    return null;
  }

  /**
   * Extract pattern from template literal
   */
  private extractTemplatePattern(node: Node): string {
    if (!Node.isTemplateExpression(node)) return '';

    let pattern = (node.getHead() as any).getLiteralValue();

    node.getTemplateSpans().forEach((span) => {
      const expr = span.getExpression();

      // Try to resolve the expression
      if (Node.isIdentifier(expr)) {
        pattern += `\${${expr.getText()}}`;
      } else {
        pattern += '${...}';
      }

      pattern += (span.getLiteral() as any).getLiteralValue();
    });

    return pattern;
  }

  /**
   * Infer the type of a string constant
   */
  private inferConstantType(value: string): string {
    // URL segment
    if (value.match(/^(https?:\/\/|\/[a-z])/i)) {
      return 'url_segment';
    }

    // Error code
    if (value.match(/^E\d+$/)) {
      return 'error_code';
    }

    // Event name (contains colon)
    if (value.includes(':')) {
      return 'event_name';
    }

    // CSS class (starts with dot or dash)
    if (value.match(/^[\.\-]/)) {
      return 'css_class';
    }

    // Environment variable (all caps with underscores)
    if (value.match(/^[A-Z_]+$/)) {
      return 'env_var';
    }

    // API path segment
    if (value.match(/^\/[a-z0-9\-_\/]+$/i)) {
      return 'api_path';
    }

    return 'string';
  }

  /**
   * Extract URL patterns from string constants
   */
  private extractURLPatterns(constants: StringConstant[], sourceFile: SourceFile): URLPattern[] {
    const patterns: URLPattern[] = [];

    // Find axios/fetch calls
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
      const expr = callExpr.getExpression();
      const exprText = expr.getText();

      // Check if it's an HTTP call
      const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'axios', 'fetch'];
      const isHttpCall = httpMethods.some((method) => exprText.includes(method));

      if (!isHttpCall) return;

      // Extract URL argument
      const args = callExpr.getArguments();
      if (args.length === 0) return;

      const urlArg = args[0];
      const urlPattern = this.extractURLFromExpression(urlArg);

      if (urlPattern) {
        patterns.push({
          pattern: urlPattern.pattern,
          normalizedPattern: this.normalizeURLPattern(urlPattern.pattern),
          method: this.extractHTTPMethod(exprText),
          components: urlPattern.components,
          pathParams: urlPattern.pathParams,
          queryParams: urlPattern.queryParams,
          definitionLine: callExpr.getStartLineNumber(),
          definitionCode: callExpr.getText().slice(0, 200), // Limit length
        });
      }
    });

    // Find route definitions (Express, Fastify, etc.)
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
      const expr = callExpr.getExpression();

      if (Node.isPropertyAccessExpression(expr)) {
        const methodName = expr.getName();
        const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'all'];

        if (httpMethods.includes(methodName)) {
          const args = callExpr.getArguments();
          if (args.length >= 1) {
            const routeArg = args[0];
            const urlPattern = this.extractURLFromExpression(routeArg);

            if (urlPattern) {
              patterns.push({
                pattern: urlPattern.pattern,
                normalizedPattern: this.normalizeURLPattern(urlPattern.pattern),
                method: methodName.toUpperCase(),
                components: urlPattern.components,
                pathParams: urlPattern.pathParams,
                queryParams: urlPattern.queryParams,
                definitionLine: callExpr.getStartLineNumber(),
                definitionCode: callExpr.getText().slice(0, 200),
              });
            }
          }
        }
      }
    });

    return patterns;
  }

  /**
   * Extract URL pattern from an expression
   */
  private extractURLFromExpression(node: Node): {
    pattern: string;
    components: URLComponent[];
    pathParams: string[];
    queryParams: string[];
  } | null {
    const components: URLComponent[] = [];
    const pathParams: string[] = [];
    const queryParams: string[] = [];

    // String literal
    if (Node.isStringLiteral(node)) {
      const value = node.getLiteralValue();
      components.push({ type: 'literal', value });
      this.extractParamsFromPattern(value, pathParams);
      return { pattern: value, components, pathParams, queryParams };
    }

    // Template literal
    if (Node.isTemplateExpression(node)) {
      let pattern = '';

      const head = (node.getHead() as any).getLiteralValue();
      pattern += head;
      components.push({ type: 'literal', value: head });

      node.getTemplateSpans().forEach((span) => {
        const expr = span.getExpression();
        const exprText = expr.getText();

        pattern += `\${${exprText}}`;
        components.push({ type: 'variable', value: exprText });
        pathParams.push(exprText);

        const literal = (span.getLiteral() as any).getLiteralValue();
        pattern += literal;
        if (literal) {
          components.push({ type: 'literal', value: literal });
        }
      });

      return { pattern, components, pathParams, queryParams };
    }

    // Binary expression (concatenation)
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const left = this.extractURLFromExpression(node.getLeft());
      const right = this.extractURLFromExpression(node.getRight());

      if (left && right) {
        return {
          pattern: left.pattern + right.pattern,
          components: [...left.components, ...right.components],
          pathParams: [...left.pathParams, ...right.pathParams],
          queryParams: [...left.queryParams, ...right.queryParams],
        };
      }
    }

    // Identifier (variable reference)
    if (Node.isIdentifier(node)) {
      const name = node.getText();
      components.push({ type: 'variable', value: name });
      return { pattern: `\${${name}}`, components, pathParams: [name], queryParams };
    }

    return null;
  }

  /**
   * Extract path parameters from URL pattern
   */
  private extractParamsFromPattern(pattern: string, params: string[]): void {
    // Express-style params: /users/:id
    const expressParams = pattern.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
    if (expressParams) {
      expressParams.forEach((param) => params.push(param.slice(1)));
    }

    // Curly brace params: /users/{id}
    const braceParams = pattern.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
    if (braceParams) {
      braceParams.forEach((param) => params.push(param.slice(1, -1)));
    }
  }

  /**
   * Normalize URL pattern for matching
   */
  private normalizeURLPattern(pattern: string): string {
    return pattern
      // Replace UUIDs with :id
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      // Replace long hex strings with :id
      .replace(/\/[0-9a-f]{20,}/gi, '/:id')
      // Replace numeric IDs with :id
      .replace(/\/\d+/g, '/:id')
      // Replace template variables with :param
      .replace(/\$\{[^}]+\}/g, ':param')
      // Normalize multiple slashes
      .replace(/\/+/g, '/');
  }

  /**
   * Extract HTTP method from expression text
   */
  private extractHTTPMethod(text: string): string | undefined {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    for (const method of methods) {
      if (text.toLowerCase().includes(method.toLowerCase())) {
        return method;
      }
    }
    return undefined;
  }

  /**
   * Extract all functions from the source file
   */
  private extractFunctions(sourceFile: SourceFile): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // Function declarations
    sourceFile.getFunctions().forEach((func) => {
      functions.push(this.extractFunctionInfo(func, 'function'));
    });

    // Method declarations in classes
    sourceFile.getClasses().forEach((cls) => {
      cls.getMethods().forEach((method) => {
        functions.push(this.extractFunctionInfo(method, 'method'));
      });

      cls.getConstructors().forEach((ctor) => {
        functions.push(this.extractFunctionInfo(ctor, 'constructor'));
      });
    });

    // Arrow functions assigned to variables
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach((varDecl) => {
      const initializer = varDecl.getInitializer();
      if (initializer && Node.isArrowFunction(initializer)) {
        const name = varDecl.getName();
        functions.push({
          name,
          fullName: name,
          signature: varDecl.getText(),
          functionType: 'arrow',
          visibility: 'public',
          isAsync: initializer.isAsync(),
          isExported: varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement)?.isExported() || false,
          parameters: this.extractParameters(initializer),
          cyclomaticComplexity: this.calculateComplexity(initializer),
          linesOfCode: initializer.getEndLineNumber() - initializer.getStartLineNumber() + 1,
          lineStart: initializer.getStartLineNumber(),
          lineEnd: initializer.getEndLineNumber(),
          code: initializer.getText(),
        });
      }
    });

    return functions;
  }

  /**
   * Extract function information
   */
  private extractFunctionInfo(
    func: any,
    functionType: 'function' | 'method' | 'arrow' | 'constructor'
  ): FunctionInfo {
    const name = func.getName?.() || 'anonymous';
    const parent = func.getParent();
    const className = Node.isClassDeclaration(parent) ? parent.getName() : undefined;
    const fullName = className ? `${className}.${name}` : name;

    return {
      name,
      fullName,
      signature: func.getText().split('\n')[0].slice(0, 200),
      returnType: func.getReturnType?.()?.getText(),
      functionType,
      visibility: func.getScope?.() || 'public',
      isAsync: func.isAsync?.() || false,
      isExported: func.isExported?.() || false,
      parameters: this.extractParameters(func),
      cyclomaticComplexity: this.calculateComplexity(func),
      linesOfCode: func.getEndLineNumber() - func.getStartLineNumber() + 1,
      lineStart: func.getStartLineNumber(),
      lineEnd: func.getEndLineNumber(),
      code: func.getText(),
    };
  }

  /**
   * Extract parameters from a function
   */
  private extractParameters(func: any): ParameterInfo[] {
    const params: ParameterInfo[] = [];

    func.getParameters?.().forEach((param: any) => {
      params.push({
        name: param.getName(),
        type: param.getType().getText(),
        isOptional: param.isOptional(),
        defaultValue: param.getInitializer()?.getText(),
      });
    });

    return params;
  }

  /**
   * Calculate cyclomatic complexity
   */
  private calculateComplexity(node: Node): number {
    let complexity = 1;

    node.forEachDescendant((child) => {
      const kind = child.getKind();

      // Decision points
      if (
        kind === SyntaxKind.IfStatement ||
        kind === SyntaxKind.ConditionalExpression ||
        kind === SyntaxKind.CaseClause ||
        kind === SyntaxKind.ForStatement ||
        kind === SyntaxKind.ForInStatement ||
        kind === SyntaxKind.ForOfStatement ||
        kind === SyntaxKind.WhileStatement ||
        kind === SyntaxKind.DoStatement ||
        kind === SyntaxKind.CatchClause
      ) {
        complexity++;
      }

      // Logical operators
      if (kind === SyntaxKind.AmpersandAmpersandToken || kind === SyntaxKind.BarBarToken) {
        complexity++;
      }
    });

    return complexity;
  }

  /**
   * Extract all classes from the source file
   */
  private extractClasses(sourceFile: SourceFile): ClassInfo[] {
    const classes: ClassInfo[] = [];

    // Class declarations
    sourceFile.getClasses().forEach((cls) => {
      classes.push({
        name: cls.getName() || 'anonymous',
        fullName: cls.getName() || 'anonymous',
        classType: 'class',
        extendsClass: cls.getExtends()?.getText(),
        implementsInterfaces: cls.getImplements().map((i) => i.getText()),
        properties: cls.getProperties().map((prop) => ({
          name: prop.getName(),
          type: prop.getType().getText(),
          visibility: prop.getScope(),
          isStatic: prop.isStatic(),
          isReadonly: prop.isReadonly(),
        })),
        methods: cls.getMethods().map((m) => m.getName()),
        decorators: cls.getDecorators().map((d) => d.getName()),
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        code: cls.getText(),
      });
    });

    // Interface declarations
    sourceFile.getInterfaces().forEach((iface) => {
      classes.push({
        name: iface.getName(),
        fullName: iface.getName(),
        classType: 'interface',
        extendsClass: undefined,
        implementsInterfaces: iface.getExtends().map((e) => e.getText()),
        properties: iface.getProperties().map((prop) => ({
          name: prop.getName(),
          type: prop.getType().getText(),
          visibility: 'public',
          isStatic: false,
          isReadonly: false,
        })),
        methods: iface.getMethods().map((m) => m.getName()),
        decorators: [],
        lineStart: iface.getStartLineNumber(),
        lineEnd: iface.getEndLineNumber(),
        code: iface.getText(),
      });
    });

    // Type aliases
    sourceFile.getTypeAliases().forEach((typeAlias) => {
      classes.push({
        name: typeAlias.getName(),
        fullName: typeAlias.getName(),
        classType: 'type',
        extendsClass: undefined,
        implementsInterfaces: [],
        properties: [],
        methods: [],
        decorators: [],
        lineStart: typeAlias.getStartLineNumber(),
        lineEnd: typeAlias.getEndLineNumber(),
        code: typeAlias.getText(),
      });
    });

    // Enums
    sourceFile.getEnums().forEach((enumDecl) => {
      classes.push({
        name: enumDecl.getName(),
        fullName: enumDecl.getName(),
        classType: 'enum',
        extendsClass: undefined,
        implementsInterfaces: [],
        properties: enumDecl.getMembers().map((member) => ({
          name: member.getName(),
          type: 'string | number',
          visibility: 'public',
          isStatic: true,
          isReadonly: true,
        })),
        methods: [],
        decorators: [],
        lineStart: enumDecl.getStartLineNumber(),
        lineEnd: enumDecl.getEndLineNumber(),
        code: enumDecl.getText(),
      });
    });

    return classes;
  }

  /**
   * Extract all imports from the source file
   */
  private extractImports(sourceFile: SourceFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    sourceFile.getImportDeclarations().forEach((importDecl) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const isExternal = !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');

      // Default import
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        imports.push({
          importedSymbol: defaultImport.getText(),
          importType: 'default',
          importPath: moduleSpecifier,
          isExternal,
          line: importDecl.getStartLineNumber(),
        });
      }

      // Namespace import
      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) {
        imports.push({
          importedSymbol: namespaceImport.getText(),
          importType: 'namespace',
          importPath: moduleSpecifier,
          isExternal,
          line: importDecl.getStartLineNumber(),
        });
      }

      // Named imports
      const namedImports = importDecl.getNamedImports();
      namedImports.forEach((namedImport) => {
        imports.push({
          importedSymbol: namedImport.getName(),
          importType: 'named',
          importPath: moduleSpecifier,
          isExternal,
          alias: namedImport.getAliasNode()?.getText(),
          line: importDecl.getStartLineNumber(),
        });
      });

      // Side-effect import
      if (!defaultImport && !namespaceImport && namedImports.length === 0) {
        imports.push({
          importType: 'side-effect',
          importPath: moduleSpecifier,
          isExternal,
          line: importDecl.getStartLineNumber(),
        });
      }
    });

    return imports;
  }
}
