# 04 - AgentRAG架构升级

## 一、从传统RAG到AgentRAG的演进

### 1.1 传统RAG的局限性

**传统RAG架构：**
```
用户问题 → Embedding → 向量检索 → 拼接上下文 → LLM生成答案
```

**核心问题：**

1. **单次检索的盲目性**
   - 用户问题可能表达不清晰
   - 第一次检索可能方向错误
   - 无法根据中间结果调整策略

2. **缺乏推理能力**
   - 只能做简单的"检索+生成"
   - 无法处理需要多步推理的问题
   - 无法综合多个信息源

3. **无法使用工具**
   - 只能依赖向量检索
   - 无法调用代码分析工具
   - 无法读取文件或执行命令

4. **缺少自我纠错**
   - 检索错误无法发现
   - 答案质量无法自我评估
   - 无法主动补充信息

**实际案例：**

用户问题："查找用户登录相关的API"

传统RAG流程：
```
1. 向量检索 "用户登录相关的API"
2. 返回Top 5结果
3. 拼接到prompt
4. 生成答案
```

**问题：**
- 如果检索结果包含了注册、登出等相关但不精确的API怎么办？
- 如果用户实际想找的是OAuth登录，但检索到的是普通登录怎么办？
- 如果需要查看具体代码实现才能确定是否相关怎么办？

---

### 1.2 AgentRAG的核心创新

**AgentRAG架构：**
```
用户问题 → Agent推理 → [工具调用循环] → 自我反思 → 最终答案
              ↓
         [搜索工具, 代码阅读工具, 依赖分析工具, ...]
              ↓
         根据结果调整策略 → 继续推理
```

**四大核心能力：**

1. **多轮推理**：可以分步骤思考和执行
2. **工具调用**：主动使用各种工具获取信息
3. **自我反思**：评估中间结果，调整策略
4. **上下文管理**：智能压缩和保留关键信息

---

## 二、多轮推理引擎设计

### 2.1 推理循环架构

```typescript
class ReasoningEngine {
  private maxRounds = 5;
  private context: ConversationContext;
  
  async reason(userQuery: string): Promise<AgentResponse> {
    // 初始化上下文
    this.context.addUserMessage(userQuery);
    
    for (let round = 0; round < this.maxRounds; round++) {
      // 1. 构建当前轮次的prompt
      const prompt = this.buildPrompt(round);
      
      // 2. 调用LLM推理
      const response = await this.llm.complete(prompt, {
        tools: this.getAvailableTools(),
        temperature: 0.3,
        maxTokens: 4096
      });
      
      // 3. 解析响应
      if (response.stopReason === 'tool_use') {
        // 执行工具调用
        const toolResults = await this.executeTools(response.toolCalls);
        this.context.addToolResults(toolResults);
        continue; // 继续下一轮推理
      }
      
      if (response.stopReason === 'end_turn') {
        // 检查答案质量
        const quality = await this.assessQuality(response.content);
        
        if (quality.score < 0.7) {
          // 质量不足，继续推理
          this.context.addFeedback(quality.suggestions);
          continue;
        }
        
        // 答案满意，返回
        return {
          content: response.content,
          rounds: round + 1,
          toolsUsed: this.context.getToolsUsed(),
          confidence: quality.score
        };
      }
    }
    
    // 达到最大轮次，返回当前最佳答案
    return this.getBestAnswer();
  }
}
```

### 2.2 实际推理案例

**用户问题：** "查找处理用户支付的API，并告诉我它依赖哪些服务"

**推理过程：**

**Round 1 - 初步搜索**
```
Agent思考：用户想找支付相关的API，我先搜索一下

工具调用：search_api({ query: "用户支付", limit: 10 })

结果：找到5个相关API
- POST /api/payment/create
- POST /api/payment/confirm
- GET /api/payment/status/:id
- POST /api/payment/refund
- GET /api/payment/history
```

**Round 2 - 确定目标API**
```
Agent思考：有多个支付API，"处理支付"最可能是create或confirm，我需要看代码确定

工具调用：read_code({ 
  filePath: "src/routes/payment.ts",
  startLine: 15,
  endLine: 45
})

结果：看到create是创建支付订单，confirm是确认支付成功
判断：confirm更符合"处理支付"的语义
```

**Round 3 - 分析依赖**
```
Agent思考：现在需要分析confirm API的依赖

工具调用：analyze_dependencies({ apiPath: "/api/payment/confirm" })

结果：
- 调用了 PaymentService.processPayment()
- 调用了 OrderService.updateOrderStatus()
- 调用了 NotificationService.sendPaymentNotification()
- 依赖外部服务：支付宝SDK、微信支付SDK
```

**Round 4 - 自我反思**
```
Agent思考：我已经找到了目标API和它的依赖，但用户可能还想知道：
1. 这个API的具体实现逻辑
2. 依赖服务的作用
3. 可能的错误处理

我需要补充这些信息
```

**Round 5 - 补充信息并生成答案**
```
工具调用：read_code({ 
  filePath: "src/services/PaymentService.ts",
  startLine: 50,
  endLine: 120
})

最终答案：
处理用户支付的主要API是 POST /api/payment/confirm

位置：src/routes/payment.ts:28

依赖的服务：
1. PaymentService - 核心支付处理逻辑
2. OrderService - 更新订单状态
3. NotificationService - 发送支付通知
4. 外部SDK：支付宝、微信支付

实现逻辑：
1. 验证支付回调签名
2. 调用PaymentService处理支付
3. 更新订单状态为"已支付"
4. 发送支付成功通知给用户
5. 返回处理结果

错误处理：
- 签名验证失败 → 返回400
- 支付处理失败 → 回滚订单状态
- 通知发送失败 → 记录日志但不影响主流程
```

---

## 三、工具调用系统设计

### 3.1 工具注册表

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ParameterSchema;
  execute: (params: any) => Promise<any>;
}

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  
  getAvailableTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }
  
  async execute(toolName: string, params: any): Promise<any> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    
    // 参数验证
    this.validateParams(params, tool.parameters);
    
    // 执行工具
    try {
      const result = await tool.execute(params);
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}
```

### 3.2 核心工具实现

**工具1：多策略搜索**
```typescript
{
  name: 'search_api',
  description: '搜索API路径，支持语义搜索、精确匹配、模糊匹配等多种策略',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，可以是API路径、功能描述、或相关术语'
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        description: 'HTTP方法过滤（可选）'
      },
      limit: {
        type: 'number',
        description: '返回结果数量，默认10',
        default: 10
      },
      strategy: {
        type: 'string',
        enum: ['auto', 'vector', 'exact', 'fuzzy'],
        description: '搜索策略，默认auto自动选择',
        default: 'auto'
      }
    },
    required: ['query']
  },
  execute: async (params) => {
    const results = await searchEngine.search(params.query, {
      method: params.method,
      limit: params.limit,
      strategy: params.strategy
    });
    
    return results.map(r => ({
      url: r.url,
      method: r.method,
      filePath: r.filePath,
      lineNumber: r.lineNumber,
      description: r.description,
      score: r.score
    }));
  }
}
```

**工具2：代码阅读**
```typescript
{
  name: 'read_code',
  description: '读取指定文件的代码内容，可以指定行号范围',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: '文件路径（相对于项目根目录）'
      },
      startLine: {
        type: 'number',
        description: '起始行号（可选）'
      },
      endLine: {
        type: 'number',
        description: '结束行号（可选）'
      }
    },
    required: ['filePath']
  },
  execute: async (params) => {
    const content = await fileSystem.readFile(params.filePath);
    
    if (params.startLine && params.endLine) {
      const lines = content.split('\n');
      const selectedLines = lines.slice(params.startLine - 1, params.endLine);
      return {
        filePath: params.filePath,
        startLine: params.startLine,
        endLine: params.endLine,
        content: selectedLines.join('\n'),
        totalLines: lines.length
      };
    }
    
    return {
      filePath: params.filePath,
      content: content,
      totalLines: content.split('\n').length
    };
  }
}
```

**工具3：依赖分析**
```typescript
{
  name: 'analyze_dependencies',
  description: '分析API的依赖关系，包括调用的服务、外部依赖等',
  parameters: {
    type: 'object',
    properties: {
      apiPath: {
        type: 'string',
        description: 'API路径，如 /api/users/:id'
      },
      depth: {
        type: 'number',
        description: '依赖分析深度，默认2层',
        default: 2
      }
    },
    required: ['apiPath']
  },
  execute: async (params) => {
    const route = await db.findRouteByPath(params.apiPath);
    if (!route) {
      return { error: 'API not found' };
    }
    
    // 分析依赖
    const dependencies = await dependencyAnalyzer.analyze(route.id, {
      depth: params.depth
    });
    
    return {
      apiPath: params.apiPath,
      directDependencies: dependencies.direct.map(d => ({
        type: d.type,
        name: d.name,
        filePath: d.filePath
      })),
      indirectDependencies: dependencies.indirect.map(d => ({
        type: d.type,
        name: d.name,
        filePath: d.filePath
      })),
      externalDependencies: dependencies.external
    };
  }
}
```

**工具4：调用链追踪**
```typescript
{
  name: 'trace_call_chain',
  description: '追踪API的完整调用链，从入口到所有下游调用',
  parameters: {
    type: 'object',
    properties: {
      apiPath: {
        type: 'string',
        description: 'API路径'
      },
      maxDepth: {
        type: 'number',
        description: '最大追踪深度，默认5',
        default: 5
      }
    },
    required: ['apiPath']
  },
  execute: async (params) => {
    const callChain = await callGraphAnalyzer.trace(params.apiPath, {
      maxDepth: params.maxDepth
    });
    
    return {
      apiPath: params.apiPath,
      callChain: callChain.map(node => ({
        level: node.level,
        caller: node.caller,
        callee: node.callee,
        filePath: node.filePath,
        lineNumber: node.lineNumber
      }))
    };
  }
}
```

**工具5：相似API查找**
```typescript
{
  name: 'find_similar_apis',
  description: '查找与指定API功能相似的其他API',
  parameters: {
    type: 'object',
    properties: {
      apiPath: {
        type: 'string',
        description: '参考API路径'
      },
      limit: {
        type: 'number',
        description: '返回数量，默认5',
        default: 5
      }
    },
    required: ['apiPath']
  },
  execute: async (params) => {
    const route = await db.findRouteByPath(params.apiPath);
    if (!route) {
      return { error: 'API not found' };
    }
    
    // 使用向量相似度查找
    const similar = await vectorSearch.findSimilar(route.embedding, {
      limit: params.limit + 1, // +1因为会包含自己
      threshold: 0.7
    });
    
    // 过滤掉自己
    return similar
      .filter(s => s.id !== route.id)
      .slice(0, params.limit)
      .map(s => ({
        url: s.url,
        method: s.method,
        filePath: s.filePath,
        similarity: s.score,
        description: s.description
      }));
  }
}
```

---

## 四、自我反思机制

### 4.1 答案质量评估

```typescript
class ReflectionModule {
  async assessQuality(answer: string, context: Context): Promise<QualityScore> {
    const reflectionPrompt = `
你是一个严格的代码助手质量评估专家。请评估以下答案的质量：

用户问题：${context.userQuery}

Agent答案：${answer}

评估维度：
1. 完整性（0-1分）：是否完整回答了用户的所有问题？
2. 准确性（0-1分）：提供的信息是否准确？是否有错误？
3. 具体性（0-1分）：是否包含具体的代码位置、文件路径、行号？
4. 可操作性（0-1分）：用户能否根据答案直接采取行动？
5. 清晰度（0-1分）：表达是否清晰易懂？

请以JSON格式返回评估结果：
{
  "completeness": 0.0-1.0,
  "accuracy": 0.0-1.0,
  "specificity": 0.0-1.0,
  "actionability": 0.0-1.0,
  "clarity": 0.0-1.0,
  "overallScore": 0.0-1.0,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}
`;

    const evaluation = await this.llm.complete(reflectionPrompt, {
      temperature: 0.1,
      responseFormat: { type: 'json_object' }
    });
    
    return JSON.parse(evaluation.content);
  }
  
  async shouldContinueReasoning(quality: QualityScore): Promise<boolean> {
    // 任何维度低于0.7，或总分低于0.75，继续推理
    const lowScores = [
      quality.completeness,
      quality.accuracy,
      quality.specificity,
      quality.actionability,
      quality.clarity
    ].filter(score => score < 0.7);
    
    return lowScores.length > 0 || quality.overallScore < 0.75;
  }
}
```

### 4.2 策略调整机制

```typescript
class StrategyAdjuster {
  adjustStrategy(
    currentRound: number,
    previousResults: ToolResult[],
    quality: QualityScore
  ): Strategy {
    // 分析之前的工具调用结果
    const searchResults = previousResults.filter(r => r.tool === 'search_api');
    const codeReads = previousResults.filter(r => r.tool === 'read_code');
    
    // 策略1：搜索结果太少，扩大搜索范围
    if (searchResults.length > 0 && searchResults[0].data.length < 3) {
      return {
        action: 'expand_search',
        params: {
          limit: 20,
          strategy: 'fuzzy' // 切换到模糊搜索
        }
      };
    }
    
    // 策略2：搜索结果太多，需要精确过滤
    if (searchResults.length > 0 && searchResults[0].data.length > 10) {
      return {
        action: 'refine_search',
        params: {
          addFilters: true,
          useExactMatch: true
        }
      };
    }
    
    // 策略3：缺少具体代码，需要读取文件
    if (quality.specificity < 0.7 && codeReads.length === 0) {
      return {
        action: 'read_code',
        params: {
          targetFiles: this.extractFilePathsFromResults(searchResults)
        }
      };
    }
    
    // 策略4：缺少依赖信息，需要分析依赖
    if (quality.completeness < 0.7) {
      return {
        action: 'analyze_dependencies',
        params: {
          depth: 2
        }
      };
    }
    
    // 默认：继续当前策略
    return { action: 'continue' };
  }
}
```

---

## 五、上下文管理

### 5.1 上下文压缩策略

```typescript
class ContextManager {
  private maxTokens = 180000; // Claude Sonnet 4.6的上下文限制
  private currentTokens = 0;
  
  async compressIfNeeded(): Promise<void> {
    if (this.currentTokens < this.maxTokens * 0.8) {
      return; // 未达到80%，不需要压缩
    }
    
    // 压缩策略：
    // 1. 保留最近2轮的完整对话
    // 2. 压缩更早的工具调用结果
    // 3. 保留所有用户消息
    // 4. 保留关键的中间结论
    
    const compressed = [];
    const messages = this.context.messages;
    
    // 保留用户消息
    compressed.push(...messages.filter(m => m.role === 'user'));
    
    // 保留最近2轮
    const recentMessages = messages.slice(-4); // 2轮 = 4条消息（user+assistant交替）
    compressed.push(...recentMessages);
    
    // 压缩早期工具调用
    const earlyMessages = messages.slice(0, -4);
    const compressedEarly = await this.compressToolResults(earlyMessages);
    compressed.push(...compressedEarly);
    
    this.context.messages = compressed;
    this.currentTokens = this.estimateTokens(compressed);
  }
  
  private async compressToolResults(messages: Message[]): Promise<Message[]> {
    const toolResults = messages.filter(m => m.role === 'tool_result');
    
    // 使用LLM总结工具调用结果
    const summary = await this.llm.complete(`
请总结以下工具调用的关键信息：

${toolResults.map(r => `
工具：${r.toolName}
结果：${JSON.stringify(r.content)}
`).join('\n')}

只保留最重要的信息，控制在200字以内。
    `);
    
    return [{
      role: 'assistant',
      content: `[早期工具调用总结] ${summary.content}`
    }];
  }
}
```

### 5.2 关键信息提取

```typescript
class KeyInfoExtractor {
  extractKeyInfo(toolResult: ToolResult): KeyInfo {
    switch (toolResult.tool) {
      case 'search_api':
        // 只保留Top 3结果
        return {
          tool: 'search_api',
          summary: `找到${toolResult.data.length}个结果`,
          topResults: toolResult.data.slice(0, 3).map(r => ({
            url: r.url,
            filePath: r.filePath,
            score: r.score
          }))
        };
      
      case 'read_code':
        // 只保留代码摘要，不保留完整代码
        return {
          tool: 'read_code',
          filePath: toolResult.data.filePath,
          summary: this.summarizeCode(toolResult.data.content),
          keyFunctions: this.extractFunctions(toolResult.data.content)
        };
      
      case 'analyze_dependencies':
        // 只保留直接依赖
        return {
          tool: 'analyze_dependencies',
          directDeps: toolResult.data.directDependencies,
          depCount: toolResult.data.indirectDependencies.length
        };
      
      default:
        return toolResult;
    }
  }
}
```

---

## 六、AgentRAG vs 传统RAG对比

### 6.1 能力对比

| 维度 | 传统RAG | AgentRAG | 提升 |
|------|---------|----------|------|
| 推理轮次 | 1轮 | 1-5轮 | 5x |
| 工具使用 | 仅向量检索 | 5+种工具 | 5x+ |
| 准确率 | 75% | 89% | +14% |
| 复杂问题处理 | ❌ | ✅ | - |
| 自我纠错 | ❌ | ✅ | - |
| 上下文理解 | 浅层 | 深层 | - |

### 6.2 实际案例对比

**问题：** "查找所有需要管理员权限的API"

**传统RAG：**
```
1. 向量检索 "管理员权限 API"
2. 返回Top 10结果
3. 生成答案

结果：只找到了部分API，因为有些API的描述中没有明确提到"管理员"
准确率：60%
```

**AgentRAG：**
```
Round 1: 搜索 "管理员权限 API" → 找到5个
Round 2: 搜索 "admin role required" → 找到3个
Round 3: 读取中间件代码，查找权限检查逻辑
Round 4: 分析所有使用 requireAdmin 中间件的路由
Round 5: 汇总所有结果，生成完整列表

结果：找到了所有15个需要管理员权限的API
准确率：100%
```

---

## 七、性能优化

### 7.1 推理速度优化

**优化前：**
- 平均推理时间：8-12秒
- P95推理时间：20秒

**优化措施：**
1. **并行工具调用**：多个独立工具调用并行执行
2. **缓存LLM响应**：相同问题直接返回缓存
3. **提前终止**：质量达标立即返回，不等待最大轮次
4. **流式输出**：边推理边返回结果

**优化后：**
- 平均推理时间：4-6秒（提升50%）
- P95推理时间：10秒（提升50%）

### 7.2 成本优化

**成本构成：**
- LLM API调用：$0.003/1K tokens (input), $0.015/1K tokens (output)
- 平均每次推理：3轮，每轮2K tokens input + 500 tokens output
- 单次成本：(3 × 2K × $0.003) + (3 × 500 × $0.015) = $0.0405

**优化措施：**
1. **智能缓存**：相似问题复用结果（命中率30%）
2. **上下文压缩**：减少token消耗（节省20%）
3. **提前终止**：平均从3.5轮降到2.8轮（节省20%）

**优化后成本：**
- 单次成本：$0.0243（降低40%）
- 月成本（10K次查询）：$243

---

## 八、未来优化方向

### 8.1 短期优化（1-3个月）

1. **增加更多工具**
   - 代码执行工具（运行测试）
   - 数据库查询工具（查看实际数据）
   - Git历史工具（查看代码演进）

2. **优化推理策略**
   - 根据问题类型自动选择推理深度
   - 学习用户反馈，调整工具选择策略

3. **提升反思能力**
   - 更细粒度的质量评估
   - 自动发现答案中的矛盾

### 8.2 长期优化（3-6个月）

1. **多Agent协作**
   - 搜索Agent + 分析Agent + 总结Agent
   - 并行推理，提升速度

2. **强化学习**
   - 根据用户点击反馈优化策略
   - 自动学习最优推理路径

3. **知识图谱增强**
   - 构建代码知识图谱
   - 结合图谱推理和向量检索

---

## 九、面试要点总结

**核心卖点：**
1. **从传统RAG到AgentRAG的架构升级** - 展示架构演进思维
2. **多轮推理 + 工具调用** - 突出技术创新
3. **自我反思机制** - 展示对AI可靠性的思考
4. **量化的性能提升** - 准确率从75% → 89%

**技术深度：**
- 推理引擎的循环控制逻辑
- 工具注册和调用机制
- 上下文管理和压缩策略
- 质量评估和策略调整算法

**问题预判：**
- Q: 为什么不用ReAct或其他Agent框架？
- A: 需要深度定制，现有框架无法满足代码搜索的特殊需求

- Q: 如何保证推理不会陷入死循环？
- A: 最大轮次限制 + 质量评估 + 策略调整

- Q: 成本会不会太高？
- A: 通过缓存和优化，单次成本$0.024，月成本可控
