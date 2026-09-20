# 03 - URL 智能推导的血泪史

> 这是整个项目最大的技术难点，也是最有价值的创新点。
>
> ⚠️ **口径提醒（务必先读）**
> 原版本给每一版都标了「总体准确率 30% / 60% / 80% / 95%」以及一堆 100%/95%/85% 的分项，
> 还写了一句「业界唯一支持 URL 智能推导的代码搜索工具」。
> **那些数字至今没有依据**（已从本文件移除），「业界唯一」也站不住。
> 已改为按**能力边界**陈述（能处理什么 / 处理不了什么），这是可逐条对照代码验证的。
>
> ✅ **2026-09-19 更新：这条链路现在有实测数字了** ——
> 12 个用例 / 37 个期望位置命中 **36/37**（换成 277 文件的真实语料前是 37/37）。
> 口径：「命中的 (文件, 行号) 落在期望符号 `[line_start-2, line_end+2]` 内」，
> **不能按符号名判**（pattern/usage/derivation 三类结果的 `symbol_name` 为空，
> 按名字判会把 46% 报成 29%，还会把修复优先级排反）。
>
> ⚠️ **但要说清这个数字的性质**：语料和问题都是我自己构造的、问题基本照着代码出，
> 所以它是**上界，不是承诺**。脚本 `test-repo/eval/eval_cases.py`，报告 `test-repo/TEST_REPORT.md`。
>
> 另外，原版的版本日期是 2024-04，但项目的 git 历史是 **2026-04-26 起步**，
> 已按真实时间线修正。
>
> **正确的自我定位**：不说「我做到了 95% 准确率」，
> 而说「**我把一类原本结构性做不到的查询做成了可做的**，并且诚实地暴露做不到的部分」。

---

## 一、问题背景

### 1.1 为什么需要 URL 智能推导？

在前后端分离的项目中，API 端点的定义往往分散在多个文件中：

```typescript
// constants.ts
export const API_BASE = '/api/v1';

// endpoints.ts
import { API_BASE } from './constants';
export const USER_ENDPOINT = `${API_BASE}/users`;

// service.ts
import { USER_ENDPOINT } from './endpoints';
export function getUserData(userId: string) {
  return fetch(`${USER_ENDPOINT}/${userId}`);
}
```

**问题**：当用户搜索 `/api/v1/users/:id` 时，传统搜索返回 **0 个结果**，因为完整 URL 不在任何单个文件中。

> **注意措辞**：这里不是说「我的准确率比传统搜索高」，
> 而是说**传统方案在这个问题上是结构性失效的**（完整字符串根本不存在于任何单一位置），
> 不是精度不足。这个区分决定了后面所有设计的方向。

### 1.2 技术挑战

1. **跨文件追踪**：需要追踪常量的导入和引用关系
2. **字符串拼接**：需要理解 `+`、模板字符串 `` `${var}` `` 等拼接方式
3. **变量展开**：需要递归展开嵌套的变量引用
4. **函数调用**：需要内联函数调用，展开返回值
5. **条件表达式**：需要求值三元表达式 `condition ? a : b`
6. **对象方法**：需要解析对象方法调用 `ApiPaths.users.detail(id)`
7. **循环依赖**：`A dependsOn B` 且 `B dependsOn A` 时必须终止（真实实现里最容易被忽略的一块）

---

## 二、演进历程：四个阶段

> 真实时间线（按 git 提交）：项目 2026-04-26 起步，末次提交 2026-05-13，全程 **67 次提交**。
> 下面四个阶段的日期按此对齐。
>
> ⚠️ 每阶段末尾的「测试结果」在原版本里是一组百分比。
> **当时没有评测集，那些百分比是凭空写的**，已改为**能力清单**
> （✅ 能 / ❌ 不能 / ⚠️ 部分），这同样可逐条对照代码。
>
> 📌 补一句 2026-09-19 的口径：现在有了实测结果
> （**37 个期望位置命中 36/37**，口径见文件开头），
> 但那是**整条链路最终态的一次快照**，**不能反推回这四个阶段各自多少分** ——
> 阶段性的百分比依然没有出处，别把它们接在一起讲。

### 阶段一：简单字符串拼接（2026-04-26 前后）

**能力**：只能处理最简单的字符串拼接

```typescript
// 能处理
const API_BASE = '/api';
const USER_PATH = API_BASE + '/users';  // ✅ 能推导出 /api/users

// 不能处理
const USER_PATH = `${API_BASE}/users`;  // ❌ 模板字符串不支持
```

**实现思路**：
```typescript
function expandValue(value: string, symbolTable: Record<string, Symbol>): string {
  // 只处理 ${var} 形式的变量引用
  const varRegex = /\$\{([^}]+)\}/g;
  return value.replace(varRegex, (match, varName) => {
    const symbol = symbolTable[`const:${varName}`];
    return symbol ? symbol.value : match;
  });
}
```

**遇到的问题**：
1. ❌ 模板字符串不支持
2. ❌ 嵌套变量引用不支持
3. ❌ 函数调用不支持

**能力清单**：
- 简单拼接：✅
- 模板字符串：❌
- 函数调用：❌
- **总体：只覆盖最基础的场景**

---

### 阶段二：支持模板字符串和嵌套展开（2026-04-29 前后）

**新增能力**：
1. ✅ 支持模板字符串 `` `${var}` ``
2. ✅ 支持嵌套变量引用（最多 10 层）
3. ✅ 支持多次迭代展开

```typescript
// 能处理
const API_BASE = '/api';
const API_V1 = `${API_BASE}/v1`;
const USER_PATH = `${API_V1}/users`;  // ✅ 能推导出 /api/v1/users

// 不能处理
function buildPath(resource: string) {
  return `${API_BASE}/${resource}`;
}
const USER_PATH = buildPath('users');  // ❌ 函数调用不支持
```

**实现思路**：
```typescript
function expandValue(value: string, symbolTable: Record<string, Symbol>): string {
  let expanded = value;
  let iterations = 0;
  let changed = true;
  
  // 迭代展开，直到没有变化或达到最大次数
  while (changed && iterations < 10) {
    changed = false;
    iterations++;
    
    // 去除外层的反引号
    if (expanded.startsWith('`') && expanded.endsWith('`')) {
      expanded = expanded.slice(1, -1);
    }
    
    // 查找所有 ${...} 变量
    const varRegex = /\$\{([^}]+)\}/g;
    const matches = Array.from(expanded.matchAll(varRegex));
    
    for (const match of matches) {
      const varName = match[1].trim();
      const symbol = symbolTable[`const:${varName}`];
      
      if (symbol) {
        let replacement = symbol.value;
        
        // 去除反引号
        if (replacement.startsWith('`') && replacement.endsWith('`')) {
          replacement = replacement.slice(1, -1);
        }
        
        expanded = expanded.replace(match[0], replacement);
        changed = true;
      }
    }
  }
  
  return expanded;
}
```

**遇到的问题**：
1. ✅ 模板字符串支持
2. ✅ 嵌套变量引用支持
3. ❌ 函数调用仍不支持
4. ❌ 三元表达式不支持

**能力清单**：
- 简单拼接：✅
- 模板字符串：✅
- 嵌套引用：✅
- 函数调用：❌
- **总体：覆盖拼接与嵌套，函数调用仍是空白**

---

### 阶段三：支持函数调用内联（2026-05-03 前后）

**新增能力**：
1. ✅ 支持函数调用内联
2. ✅ 支持参数替换
3. ✅ 支持对象属性访问（如 `RESOURCES.USERS`）

```typescript
// 能处理
const RESOURCES = {
  USERS: 'users',
  PRODUCTS: 'products'
};

function buildApiPath(resource: string) {
  return `${API_BASE}/${resource}`;
}

const USER_PATH = buildApiPath(RESOURCES.USERS);  // ✅ 能推导出 /api/users

// 不能处理
function buildPath(resource: string, includeVersion: boolean) {
  return includeVersion ? `${API_BASE}/v1/${resource}` : `${API_BASE}/${resource}`;
}
const USER_PATH = buildPath('users', true);  // ❌ 三元表达式不支持
```

**实现思路**：
```typescript
function inlineFunctionCall(
  functionName: string,
  argsStr: string,
  symbolTable: Record<string, Symbol>
): string {
  // 1. 找到函数定义
  const funcSymbol = symbolTable[`func:${functionName}`];
  if (!funcSymbol || !funcSymbol.returns) {
    return `${functionName}(${argsStr})`;
  }
  
  // 2. 解析参数
  const args = argsStr.split(',').map(arg => arg.trim());
  
  // 3. 提取函数参数名
  const paramMatch = funcSymbol.value.match(/function\s+\w+\s*\(([^)]*)\)/);
  if (!paramMatch) return `${functionName}(${argsStr})`;
  
  const params = paramMatch[1].split(',').map(p => p.trim());
  
  // 4. 构建参数替换映射
  const argMap: Record<string, string> = {};
  for (let i = 0; i < params.length && i < args.length; i++) {
    argMap[params[i]] = resolveArgumentValue(args[i], symbolTable);
  }
  
  // 5. 替换返回值中的参数
  let returnValue = funcSymbol.returns;
  for (const [paramName, paramValue] of Object.entries(argMap)) {
    const regex = new RegExp(`\\$\\{${paramName}\\}`, 'g');
    returnValue = returnValue.replace(regex, paramValue);
  }
  
  // 6. 展开剩余变量
  return expandValue(returnValue, symbolTable);
}

function resolveArgumentValue(arg: string, symbolTable: Record<string, Symbol>): string {
  // 处理对象属性访问：RESOURCES.USERS
  if (arg.includes('.')) {
    const [objectName, propertyName] = arg.split('.');
    const objectSymbol = symbolTable[`const:${objectName}`];
    
    if (objectSymbol) {
      // 从对象字面量中提取属性值
      const propertyRegex = new RegExp(`${propertyName}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
      const match = objectSymbol.value.match(propertyRegex);
      if (match) return match[1];
    }
  }
  
  return arg;
}
```

**遇到的问题**：
1. ✅ 函数调用支持
2. ✅ 对象属性访问支持
3. ❌ 三元表达式仍不支持
4. ❌ 局部变量不支持

**能力清单**：
- 简单拼接：✅
- 模板字符串：✅
- 嵌套引用：✅
- 函数调用：✅（但此时仍不支持三元表达式）
- **总体：覆盖函数内联，条件分支仍是空白**

---

### 阶段四：支持三元表达式与局部变量（2026-05-06 前后，当前版本）

**新增能力**：
1. ✅ 支持三元表达式求值
2. ✅ 支持函数内局部变量
3. ✅ 支持对象方法调用（如 `ApiPaths.users.detail(id)`）
4. ✅ 支持嵌套的反引号和模板字符串

```typescript
// 全部能处理！
const ApiPaths = {
  users: {
    list: () => `${buildApiPath(RESOURCES.USERS)}`,
    detail: (id: string) => `${buildApiPath(RESOURCES.USERS)}/${id}`
  }
};

function getUserData(userId: string, includeOrders: boolean) {
  const basePath = ApiPaths.users.detail(userId);
  return includeOrders ? `${basePath}/orders` : basePath;
}

// ✅ 能推导出：
// includeOrders=true  → /api/v1/users/:id/orders
// includeOrders=false → /api/v1/users/:id
```

**核心改进 1：三元表达式解析**

```typescript
function parseTernaryExpression(expr: string): {
  condition: string;
  trueValue: string;
  falseValue: string;
} | null {
  // 找到 ? 操作符（考虑嵌套结构）
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
  
  if (questionMarkIndex === -1) return null;
  
  const condition = expr.substring(0, questionMarkIndex).trim();
  const afterQuestion = expr.substring(questionMarkIndex + 1);
  
  // 找到 : 操作符（同样考虑嵌套）
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
  
  if (colonIndex === -1) return null;
  
  const trueValue = afterQuestion.substring(0, colonIndex).trim();
  const falseValue = afterQuestion.substring(colonIndex + 1).trim();
  
  return { condition, trueValue, falseValue };
}
```

**核心改进 2：局部变量提取**

```typescript
function extractLocalVariables(functionCode: string): Record<string, string> {
  const locals: Record<string, string> = {};
  
  // 匹配：const varName = `template` 或 const varName = 'string'
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
  
  // 匹配：const varName = ObjectName.method.call(args)
  const functionCallRegex = /const\s+(\w+)\s*=\s*([\w.]+)\s*\(([^)]*)\)/g;
  while ((match = functionCallRegex.exec(functionCode)) !== null) {
    const varName = match[1];
    const functionPath = match[2];
    const args = match[3];
    
    // 存储为特殊标记，稍后解析
    locals[varName] = `__CALL__${functionPath}(${args})`;
  }
  
  return locals;
}
```

**核心改进 3：对象方法调用解析**

```typescript
function resolveObjectMethod(
  functionPath: string,  // e.g., "ApiPaths.users.detail"
  args: string,           // e.g., "userId"
  symbolTable: Record<string, Symbol>
): string | null {
  const parts = functionPath.split('.');
  if (parts.length < 2) return null;
  
  // 找到对象定义
  const objectName = parts[0];
  const objectSymbol = symbolTable[`const:${objectName}`];
  if (!objectSymbol) return null;
  
  // 导航到嵌套属性
  let currentValue = objectSymbol.value;
  
  for (let i = 1; i < parts.length; i++) {
    const propertyName = parts[i];
    const isLastPart = i === parts.length - 1;
    
    // 查找属性
    const propertyRegex = new RegExp(`${propertyName}\\s*:\\s*`, 'g');
    const match = propertyRegex.exec(currentValue);
    if (!match) return null;
    
    const startIndex = match.index + match[0].length;
    let valueStr = currentValue.substring(startIndex);
    
    // 检查是否是箭头函数
    const arrowMatch = valueStr.match(/^\(([^)]*)\)\s*=>\s*/);
    
    if (arrowMatch && isLastPart) {
      // 提取函数体
      const functionArgs = arrowMatch[1];
      const bodyStart = arrowMatch[0].length;
      
      let functionBody = '';
      if (valueStr[bodyStart] === '`') {
        // 模板字符串
        let i = bodyStart + 1;
        while (i < valueStr.length) {
          if (valueStr[i] === '`' && valueStr[i-1] !== '\\') {
            functionBody = '`' + valueStr.substring(bodyStart + 1, i) + '`';
            break;
          }
          i++;
        }
      }
      
      // 替换参数
      const argNames = functionArgs.split(',').map(a => a.trim());
      const argValues = args.split(',').map(a => a.trim());
      
      let result = functionBody;
      for (let j = 0; j < argNames.length && j < argValues.length; j++) {
        result = result.replace(
          new RegExp(`\\$\\{${argNames[j]}\\}`, 'g'),
          ':id'  // 使用占位符
        );
      }
      
      // 展开剩余变量
      return expandValueWithLocals(result, symbolTable, {});
    } else if (valueStr[0] === '{') {
      // 嵌套对象，继续导航
      let depth = 1;
      let i = 1;
      while (i < valueStr.length && depth > 0) {
        if (valueStr[i] === '{') depth++;
        else if (valueStr[i] === '}') depth--;
        i++;
      }
      currentValue = valueStr.substring(1, i - 1);
    }
  }
  
  return null;
}
```

**能力清单（当前版本）**：
- 简单拼接：✅
- 模板字符串：✅
- 嵌套引用：✅
- 函数调用：✅
- 三元表达式：⚠️ **返回多个候选**（不是"更准"，而是"一个 URL 对应多个可能值"）
- 对象方法：⚠️ 简单场景可解析
- **兜底策略**：推不了的在 `missingSymbols` 里显式列出，不猜值

> ⚠️ 原版本这里是「✅ 95% / ✅ 90% / ✅ 85% / 总体 95%」——
> **那些百分比是凭空写的，不能用**（现在有实测数字了，但见下方说明）。
> 正确的表达是**能力 + 不确定性表达方式**，而不是一个总分。
>
> ✅ 现在能用的数字只有一个：**37 个期望位置命中 36/37**（口径见文件开头，
> 且是**自造语料的上界**）。它是**整条链路的一次快照**，
> **不能拆成分项百分比去对应上面这几条能力**——一拆就又变成编数字了。

---

## 三、遇到的坑

### 坑 1：反引号的处理

**问题**：模板字符串的反引号在展开过程中容易丢失或重复

```typescript
// 错误示例
const API_BASE = '`/api`';  // 带反引号
const USER_PATH = `${API_BASE}/users`;  // 展开后：`/api`/users ❌
```

**解决方案**：
- 在展开前统一去除反引号
- 在需要时重新添加反引号
- 区分"作为模板字符串的反引号"和"字符串内容的反引号"

```typescript
function expandValueWithLocals(value: string, ...): string {
  let expanded = value;
  
  // 去除外层反引号
  if (expanded.startsWith('`') && expanded.endsWith('`')) {
    expanded = expanded.slice(1, -1);
  }
  
  // ... 展开逻辑
  
  // 如果结果包含 ${} 表达式，重新添加反引号
  if (expanded.includes('${')) {
    expanded = '`' + expanded + '`';
  }
  
  return expanded;
}
```

### 坑 2：三元表达式的嵌套

**问题**：三元表达式可能嵌套在模板字符串中，简单的正则匹配会失败

```typescript
// 复杂示例
const path = includeOrders 
  ? `${basePath}/orders` 
  : basePath;
```

**解决方案**：
- 使用状态机解析，跟踪括号、反引号的深度
- 只在深度为 0 时识别 `?` 和 `:` 操作符

### 坑 3：函数参数的默认值

**问题**：函数参数可能有默认值，调用时未传递参数需要使用默认值

```typescript
function buildPath(resource: string, version: string = 'v1') {
  return `/${version}/${resource}`;
}

buildPath('users');  // 应该使用默认值 'v1'
```

**解决方案**：
```typescript
// 解析参数定义，提取默认值
const paramDefs = paramMatch[1].split(',').map(p => {
  const parts = p.trim().split('=');
  return {
    name: parts[0].trim(),
    defaultValue: parts.length > 1 ? parts[1].trim() : undefined
  };
});

// 构建参数映射时使用默认值
for (let i = 0; i < paramDefs.length; i++) {
  if (i < args.length) {
    argMap[paramDefs[i].name] = resolveArgumentValue(args[i], symbolTable);
  } else if (paramDefs[i].defaultValue !== undefined) {
    argMap[paramDefs[i].name] = paramDefs[i].defaultValue.replace(/^['"`]|['"`]$/g, '');
  }
}
```

### 坑 4：对象方法调用的参数替换

**问题**：对象方法的参数需要替换为占位符（如 `:id`），而不是实际值

```typescript
const ApiPaths = {
  users: {
    detail: (id: string) => `${API_BASE}/users/${id}`
  }
};

// 调用 ApiPaths.users.detail(userId)
// 应该推导出：/api/users/:id
// 而不是：/api/users/userId
```

**解决方案**：
```typescript
// 替换参数时使用占位符
for (let j = 0; j < argNames.length && j < argValues.length; j++) {
  const argName = argNames[j];
  result = result.replace(
    new RegExp(`\\$\\{${escapeRegExp(argName)}\\}`, 'g'),
    ':id'  // 使用占位符，而不是实际参数值
  );
}
```

---

## 四、最终效果

### 4.1 支持的场景

✅ **简单拼接**
```typescript
const API_BASE = '/api';
const USER_PATH = API_BASE + '/users';
// 推导：/api/users
```

✅ **模板字符串**
```typescript
const API_BASE = '/api';
const USER_PATH = `${API_BASE}/users`;
// 推导：/api/users
```

✅ **嵌套引用**
```typescript
const API_BASE = '/api';
const API_V1 = `${API_BASE}/v1`;
const USER_PATH = `${API_V1}/users`;
// 推导：/api/v1/users
```

✅ **函数调用**
```typescript
function buildApiPath(resource: string) {
  return `${API_BASE}/${resource}`;
}
const USER_PATH = buildApiPath('users');
// 推导：/api/users
```

✅ **对象属性访问**
```typescript
const RESOURCES = { USERS: 'users' };
const USER_PATH = buildApiPath(RESOURCES.USERS);
// 推导：/api/users
```

✅ **三元表达式**
```typescript
function buildPath(resource: string, includeVersion: boolean) {
  return includeVersion 
    ? `${API_BASE}/v1/${resource}` 
    : `${API_BASE}/${resource}`;
}
// includeVersion=true  → /api/v1/users
// includeVersion=false → /api/users
```

✅ **对象方法调用**
```typescript
const ApiPaths = {
  users: {
    detail: (id: string) => `${buildApiPath(RESOURCES.USERS)}/${id}`
  }
};
const path = ApiPaths.users.detail(userId);
// 推导：/api/users/:id
```

✅ **局部变量**
```typescript
function getUserData(userId: string, includeOrders: boolean) {
  const basePath = ApiPaths.users.detail(userId);
  return includeOrders ? `${basePath}/orders` : basePath;
}
// includeOrders=true  → /api/users/:id/orders
// includeOrders=false → /api/users/:id
```

### 4.2 性能与边界（不报编造的指标）

> ⛔ **原版本写的是「推导成功率 95% / 平均推导时间 50-100ms / 最大深度 10 层」——
> 前两项无出处。** 已改为可讲清的结构性事实：

| 维度 | 真实情况 |
|------|---------|
| 实现体量 | `url-derivation.ts` **1,571 行**（项目最大单文件） |
| 数据来源 | 符号表从数据库构建（`buildSymbolTable`），不是内存扫描 |
| 核心机制 | 符号抽象为带 `dependsOn` 的**有向图节点**，递归展开 + 环检测 |
| 不确定性表达 | `missingSymbols[]` 显式列出未解析符号；`derivationSteps[]` 可回放 |
| 回归验证 | `pnpm url-derivation`（`scripts/url-derivation-analyzer.ts`）可对指定 URL 跑推导 |
| 可拓展空间 | 三元穷举分支、高阶函数常量传播、循环展开（见 `08` 文档） |
| 耗时 | 取决于符号表规模与推导深度，**未做基准测试，不给数字** |

**面试口径**：
> 「我不报成功率 —— 因为『成功』需要一个标注好的期望输出集，
> 而我没有。我更愿意说清楚**边界在哪**：
> 能静态推导的给出确定结果；依赖运行时值的，返回候选并列出缺哪个符号。
> 这个『诚实报告不确定性』的设计，比一个 95% 更有用 ——
> 因为用户拿到结果时知道哪些部分可信。」

### 4.3 与同类工具的对比（措辞需谨慎）

> ⛔ **原版本的结论是「CodeLens 是业界唯一支持 URL 智能推导的代码搜索工具」——
> 这句话不能讲。** 理由：
> 1. 「唯一」是无法证明的断言，面试官只要举出一个反例就崩了
> 2. GitHub Copilot / Sourcegraph / Cursor 的定位不同（补全、代码搜索、IDE），
>    用「❌」去标它们「做不到」，比较维度本身就不成立
> 3. 它们内部有没有类似能力，你无法核实

**✅ 改成可辩护的说法：**

| 维度 | 说明 |
|------|------|
| **问题类型** | 通用代码搜索工具的核心是「找文本/找语义相似」；<br>「跨文件字符串构造链的**静态还原**」是另一个问题 |
| **公开可查的差异** | 它们的公开能力描述里没有强调「URL 构造链推导」这一项 |
| **诚实的写法** | 「这是**我遇到的一个具体工程问题**，我用手写的符号图遍历解决了它；<br>我没有做过与商业工具的功能对比测试」 |

> **一句话总结**：讲「**我解决了一个什么问题、怎么解的**」，
> 而不是「**我是唯一能解的**」。前者经得起追问，后者只需一个反例。

---

## 五、面试中如何展示

### 5.1 讲故事的结构

**1. 背景（30 秒）**
> "在前后端分离的项目中，API 端点的定义往往分散在多个文件中。
> 一个完整的 URL 可能在代码库里**根本不存在** —— 它是运行时拼出来的。
> 所以传统搜索搜不到，这不是精度问题，是**结构性失效**。"

**2. 挑战（30 秒）**
> "技术挑战是：跨文件追踪、字符串拼接、变量展开、函数调用、三元表达式、对象方法调用，
> 以及最容易被忽略的一条 —— **循环依赖时必须终止**。每一个都有边界情况。"

**3. 演进（1 分钟）**
> "我经历了四个阶段，每个阶段解决一类新的构造方式：
> - 阶段一：只支持 `A + B` 形式的简单拼接
> - 阶段二：支持模板字符串与嵌套引用（需要多次迭代展开）
> - 阶段三：支持函数调用内联（要跨文件找到函数定义并求值）
> - 阶段四：支持三元表达式与局部变量（一个 URL 会产出多个候选）
>
> 这四个阶段的划分本身就是内容：**每加一类构造，就多一类边界情况**。"

**4. 难点（1 分钟）**
> "最难的部分是**三元表达式与嵌套模板的组合**。
> 因为三元表达式可能嵌在模板字符串里，而模板字符串里又可能有函数调用，
> 简单的正则匹配会在嵌套处失败。最终的做法是对表达式做**结构化的状态机解析**，
> 跟踪括号与反引号的深度，只在深度为 0 时识别操作符。
>
> 另一个容易被忽略的难点是**循环依赖**：`A dependsOn B` 且 `B dependsOn A` 时，
> 递归必须能终止。这块代码没有显式的『亮点』，但少了它整个推导会挂死。"

**5. 效果（30 秒）**
> "最终的结果是：**能静态推导的给出确定的构造链（含文件路径与行号），
> 推不出来的在 `missingSymbols` 里明确列出缺哪个符号。**
> 这个设计的意义是让用户知道**哪些部分可信**。
>
> 我不报准确率 —— 因为没有标注好的期望输出集。
> 但如果你给我一个具体的 URL，我可以现场跑一遍推导给你看。"

> ⛔ **不要说的话**：
> 「实现了 95% 的准确率」「支持 10 层嵌套」「平均 50-100ms」
> 「业界唯一支持 URL 智能推导的工具」—— 全部无出处 / 无法证明。

### 5.2 准备的代码示例

准备一个复杂的真实案例，能够现场演示推导过程：

```typescript
// 真实案例：多层嵌套 + 三元表达式 + 对象方法
const API_CONFIG = {
  BASE: '/api',
  VERSION: 'v1'
};

const RESOURCES = {
  USERS: 'users',
  PRODUCTS: 'products'
};

function buildApiPath(resource: string, includeVersion: boolean = true) {
  const base = API_CONFIG.BASE;
  return includeVersion 
    ? `${base}/${API_CONFIG.VERSION}/${resource}` 
    : `${base}/${resource}`;
}

const ApiPaths = {
  users: {
    list: () => buildApiPath(RESOURCES.USERS),
    detail: (id: string) => `${buildApiPath(RESOURCES.USERS)}/${id}`,
    orders: (id: string, includeDetails: boolean) => {
      const userPath = ApiPaths.users.detail(id);
      return includeDetails 
        ? `${userPath}/orders?details=true` 
        : `${userPath}/orders`;
    }
  }
};

// 查询：ApiPaths.users.orders(userId, true)
// 推导结果：/api/v1/users/:id/orders?details=true
```

---

**下一篇：[04-AgentRAG架构升级](./04-AgentRAG架构升级.md)**
