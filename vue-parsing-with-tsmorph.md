# Vue 文件解析方案（ts-morph）

## 问题：ts-morph 如何解析 Vue 文件？

**答案**：ts-morph 无法直接解析 `.vue` 文件，需要先提取 `<script>` 部分。

## 解析策略

### 为什么需要两步？

Vue 单文件组件（SFC）的结构：
```vue
<template>
  <div>{{ message }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const message = ref('Hello')
</script>

<style scoped>
div { color: red; }
</style>
```

**问题**：这不是有效的 JavaScript/TypeScript 代码！

**解决方案**：
1. 使用 `@vue/compiler-sfc` 解析 SFC 结构
2. 提取 `<script>` 部分的纯 JS/TS 代码
3. 使用 ts-morph 解析提取的代码

---

## 现有实现（Babel）

### 基础索引中的 Vue 处理

```typescript
// vue-parser.ts
export function parseVueFile(filePath: string, code: string): ParseResult {
  // 步骤 1: 使用 Vue 编译器解析 SFC
  const { descriptor } = parseVue(code, { filename: filePath });

  // 步骤 2: 提取 script 内容
  const scriptContent = descriptor.scriptSetup?.content || descriptor.script?.content || '';
  const scriptLang = descriptor.scriptSetup?.lang || descriptor.script?.lang || 'js';

  // 步骤 3: 使用 Babel 解析提取的代码
  if (scriptLang === 'ts' || scriptLang === 'typescript') {
    const result = parseTsFile(filePath, scriptContent);  // 调用 Babel
    result.language = 'vue';
    return result;
  }

  return { filePath, language: 'vue', chunks: [], imports: [], exports: [] };
}
```

**依赖**：
- `@vue/compiler-sfc`：解析 Vue SFC 结构
- `@babel/parser`：解析提取的 script 代码

---

## 新实现（ts-morph）

### 统一索引器中的 Vue 处理

```typescript
// unified-indexer.ts
export class UnifiedIndexer {
  private project: Project;
  private astCache: Map<string, SourceFile> = new Map();

  /**
   * 解析文件为 AST（支持 Vue）
   */
  private async parseFile(filePath: string, content: string): Promise<SourceFile> {
    const cacheKey = `${filePath}:${this.hashContent(content)}`;
    
    // 检查缓存
    let sourceFile = this.astCache.get(cacheKey);
    if (sourceFile) {
      console.log(`♻️  Reusing cached AST for ${filePath}`);
      return sourceFile;
    }

    // Vue 文件特殊处理
    if (filePath.endsWith('.vue')) {
      sourceFile = await this.parseVueFile(filePath, content);
    } else {
      // 普通 TS/JS 文件
      sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    }

    // 缓存 AST
    this.astCache.set(cacheKey, sourceFile);
    console.log(`✅ Parsed and cached ${filePath}`);
    
    return sourceFile;
  }

  /**
   * 解析 Vue 单文件组件
   */
  private async parseVueFile(filePath: string, content: string): Promise<SourceFile> {
    // 步骤 1: 使用 Vue 编译器解析 SFC 结构
    const { descriptor } = parseVue(content, { filename: filePath });

    // 步骤 2: 提取 script 内容
    const scriptContent = descriptor.scriptSetup?.content || descriptor.script?.content || '';
    
    if (!scriptContent) {
      // 没有 script 块，创建空文件
      return this.project.createSourceFile(
        filePath + '.ts',
        '',
        { overwrite: true }
      );
    }

    // 步骤 3: 使用 ts-morph 解析提取的代码
    // 注意：使用虚拟文件名（添加 .ts 后缀），避免与原文件冲突
    const virtualPath = filePath + '.ts';
    const sourceFile = this.project.createSourceFile(
      virtualPath,
      scriptContent,
      { overwrite: true }
    );

    // 保存原始文件路径，用于后续引用
    (sourceFile as any).__originalPath = filePath;

    return sourceFile;
  }

  /**
   * 提取代码块（支持 Vue）
   */
  private extractCodeChunks(sourceFile: SourceFile, filePath: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // 获取原始文件路径（Vue 文件会有虚拟路径）
    const originalPath = (sourceFile as any).__originalPath || filePath;

    // 提取函数
    sourceFile.getFunctions().forEach(func => {
      chunks.push({
        name: func.getName() || 'anonymous',
        type: 'function',
        lineStart: func.getStartLineNumber(),
        lineEnd: func.getEndLineNumber(),
        code: func.getText(),
        filePath: originalPath,  // 使用原始路径
      });
    });

    // 提取类
    sourceFile.getClasses().forEach(cls => {
      chunks.push({
        name: cls.getName() || 'anonymous',
        type: 'class',
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        code: cls.getText(),
        filePath: originalPath,
      });
    });

    // 提取变量（Vue Composition API 常用）
    sourceFile.getVariableDeclarations().forEach(decl => {
      chunks.push({
        name: decl.getName(),
        type: 'variable',
        lineStart: decl.getStartLineNumber(),
        lineEnd: decl.getEndLineNumber(),
        code: decl.getText(),
        filePath: originalPath,
      });
    });

    return chunks;
  }
}
```

**依赖**：
- `@vue/compiler-sfc`：解析 Vue SFC 结构（保留）
- `ts-morph`：解析提取的 script 代码（替代 Babel）

---

## 对比总结

### 相同点

两种方案的**核心策略完全相同**：

1. ✅ 都使用 `@vue/compiler-sfc` 提取 `<script>` 部分
2. ✅ 都只解析 script 代码，不处理 template 和 style
3. ✅ 都支持 `<script setup>` 和普通 `<script>`
4. ✅ 都支持 TypeScript 和 JavaScript

### 不同点

| 维度 | 现有方案（Babel） | 新方案（ts-morph） |
|------|------------------|-------------------|
| **解析器** | @babel/parser | ts-morph |
| **类型信息** | 基础 | 完整的 TypeScript 类型 |
| **性能** | 快 | 稍慢但更强大 |
| **一致性** | 与增强索引不一致 | 与增强索引统一 |

---

## 实际示例

### 输入：Vue 文件

```vue
<!-- UserProfile.vue -->
<template>
  <div>{{ userName }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { fetchUser } from '@/api/user'

interface User {
  id: number
  name: string
}

const userName = ref<string>('Guest')

async function loadUser(id: number): Promise<void> {
  const user = await fetchUser(id)
  userName.value = user.name
}

loadUser(1)
</script>

<style scoped>
div { color: blue; }
</style>
```

### 步骤 1：提取 script（@vue/compiler-sfc）

```typescript
const scriptContent = `
import { ref } from 'vue'
import { fetchUser } from '@/api/user'

interface User {
  id: number
  name: string
}

const userName = ref<string>('Guest')

async function loadUser(id: number): Promise<void> {
  const user = await fetchUser(id)
  userName.value = user.name
}

loadUser(1)
`
```

### 步骤 2：解析 script（ts-morph）

```typescript
const sourceFile = project.createSourceFile('UserProfile.vue.ts', scriptContent);

// 提取信息
const imports = sourceFile.getImportDeclarations();
// → ['vue', '@/api/user']

const interfaces = sourceFile.getInterfaces();
// → [{ name: 'User', properties: ['id', 'name'] }]

const variables = sourceFile.getVariableDeclarations();
// → [{ name: 'userName', type: 'Ref<string>' }]

const functions = sourceFile.getFunctions();
// → [{ name: 'loadUser', params: ['id: number'], returnType: 'Promise<void>' }]
```

### 步骤 3：生成索引

```typescript
// code_chunks 表
{
  symbol_name: 'loadUser',
  symbol_type: 'function',
  line_start: 12,
  line_end: 15,
  code: 'async function loadUser(id: number): Promise<void> { ... }',
  file_path: 'UserProfile.vue',  // 原始路径
  language: 'vue'
}

// functions 表（完整模式）
{
  name: 'loadUser',
  full_name: 'loadUser',
  signature: 'async function loadUser(id: number): Promise<void>',
  parameters: [{ name: 'id', type: 'number' }],
  return_type: 'Promise<void>',
  is_async: true,
  file_path: 'UserProfile.vue'
}

// import_relations 表
{
  importer_file: 'UserProfile.vue',
  imported_symbol: 'fetchUser',
  import_path: '@/api/user',
  import_type: 'named'
}
```

---

## 注意事项

### 1. 行号映射问题

提取 script 后，行号会发生变化：

```vue
1  <template>
2    <div>Hello</div>
3  </template>
4  
5  <script setup lang="ts">
6  const count = ref(0)  ← 在原文件中是第 6 行
7  </script>
```

提取后：
```typescript
1  const count = ref(0)  ← 在提取的代码中是第 1 行
```

**解决方案**：
```typescript
// 获取 script 块在原文件中的起始行号
const scriptStartLine = descriptor.scriptSetup?.loc.start.line || 0;

// 调整行号
chunks.forEach(chunk => {
  chunk.lineStart += scriptStartLine;
  chunk.lineEnd += scriptStartLine;
});
```

### 2. 虚拟文件路径

为了避免与原文件冲突，使用虚拟路径：

```typescript
// 原文件：UserProfile.vue
// 虚拟文件：UserProfile.vue.ts

const sourceFile = this.project.createSourceFile(
  filePath + '.ts',  // 虚拟路径
  scriptContent,
  { overwrite: true }
);

// 保存原始路径
(sourceFile as any).__originalPath = filePath;
```

### 3. Vue 特有的语法

`<script setup>` 有一些特殊语法：

```vue
<script setup lang="ts">
// 顶层变量自动暴露给 template
const count = ref(0)

// defineProps 是编译器宏
const props = defineProps<{ msg: string }>()

// defineEmits 是编译器宏
const emit = defineEmits<{ change: [value: number] }>()
</script>
```

**问题**：`defineProps` 和 `defineEmits` 不是真实的函数，ts-morph 可能报错。

**解决方案**：
```typescript
// 添加类型声明
const typeDeclarations = `
declare function defineProps<T>(): T;
declare function defineEmits<T>(): T;
declare function defineExpose<T>(exposed: T): void;
`;

const scriptContent = typeDeclarations + extractedScript;
```

---

## 完整的统一索引器（支持 Vue）

```typescript
import { Project, SourceFile } from 'ts-morph';
import { parse as parseVue } from '@vue/compiler-sfc';

export class UnifiedIndexer {
  private project: Project;
  private astCache: Map<string, SourceFile> = new Map();

  constructor(private db: Pool, private anthropicApiKey: string) {
    this.project = new Project({
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * 索引文件（支持 Vue）
   */
  async indexFile(
    repoId: number,
    fileId: number,
    filePath: string,
    content: string,
    mode: 'quick' | 'full' = 'quick'
  ): Promise<void> {
    // 解析 AST（自动处理 Vue 文件）
    const sourceFile = await this.parseFile(filePath, content);

    if (mode === 'quick') {
      await this.quickIndex(repoId, fileId, filePath, sourceFile);
    } else {
      await this.fullIndex(repoId, fileId, filePath, sourceFile);
    }
  }

  /**
   * 解析文件为 AST（支持 Vue）
   */
  private async parseFile(filePath: string, content: string): Promise<SourceFile> {
    const cacheKey = `${filePath}:${this.hashContent(content)}`;
    
    let sourceFile = this.astCache.get(cacheKey);
    if (sourceFile) {
      return sourceFile;
    }

    if (filePath.endsWith('.vue')) {
      sourceFile = await this.parseVueFile(filePath, content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    }

    this.astCache.set(cacheKey, sourceFile);
    return sourceFile;
  }

  /**
   * 解析 Vue 文件
   */
  private async parseVueFile(filePath: string, content: string): Promise<SourceFile> {
    const { descriptor } = parseVue(content, { filename: filePath });
    
    const scriptContent = descriptor.scriptSetup?.content || descriptor.script?.content || '';
    const scriptStartLine = descriptor.scriptSetup?.loc.start.line || 
                           descriptor.script?.loc.start.line || 0;

    // 添加 Vue 编译器宏的类型声明
    const vueTypeDeclarations = `
      declare function defineProps<T>(): T;
      declare function defineEmits<T>(): T;
      declare function defineExpose<T>(exposed: T): void;
      declare function withDefaults<T, D>(props: T, defaults: D): T & D;
    `;

    const fullContent = vueTypeDeclarations + '\n' + scriptContent;

    const sourceFile = this.project.createSourceFile(
      filePath + '.ts',
      fullContent,
      { overwrite: true }
    );

    // 保存元数据
    (sourceFile as any).__originalPath = filePath;
    (sourceFile as any).__scriptStartLine = scriptStartLine;
    (sourceFile as any).__isVue = true;

    return sourceFile;
  }

  /**
   * 提取代码块（支持 Vue）
   */
  private extractCodeChunks(sourceFile: SourceFile, filePath: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const originalPath = (sourceFile as any).__originalPath || filePath;
    const lineOffset = (sourceFile as any).__scriptStartLine || 0;

    sourceFile.getFunctions().forEach(func => {
      chunks.push({
        name: func.getName() || 'anonymous',
        type: 'function',
        lineStart: func.getStartLineNumber() + lineOffset,
        lineEnd: func.getEndLineNumber() + lineOffset,
        code: func.getText(),
        filePath: originalPath,
      });
    });

    // ... 其他提取逻辑

    return chunks;
  }

  private hashContent(content: string): string {
    return content.length + ':' + content.slice(0, 100);
  }
}
```

---

## 总结

### 核心答案

**ts-morph 如何解析 Vue 文件？**

1. ✅ 使用 `@vue/compiler-sfc` 提取 `<script>` 部分
2. ✅ 使用 ts-morph 解析提取的纯 JS/TS 代码
3. ✅ 调整行号映射回原文件
4. ✅ 添加 Vue 编译器宏的类型声明

### 与 Babel 方案的对比

| 特性 | Babel 方案 | ts-morph 方案 |
|------|-----------|--------------|
| **Vue 解析** | @vue/compiler-sfc | @vue/compiler-sfc（相同） |
| **Script 解析** | @babel/parser | ts-morph |
| **类型信息** | 基础 | 完整 |
| **一致性** | 与增强索引分离 | 与增强索引统一 |
| **AST 复用** | ❌ 不可复用 | ✅ 可复用 |

### 关键优势

统一使用 ts-morph 后：
- ✅ Vue 文件和 TS 文件使用同一个解析器
- ✅ AST 可以在快速模式和完整模式之间复用
- ✅ 代码更统一，维护成本更低
- ✅ 获得完整的 TypeScript 类型信息

**结论**：ts-morph 处理 Vue 文件的方式与 Babel 完全相同，都需要先提取 script 部分，然后解析纯 JS/TS 代码。统一使用 ts-morph 的主要优势是 AST 复用和代码统一。
