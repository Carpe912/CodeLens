# CodeLens 框架对比分析 - 04：实施路线图

## 1. 总体实施策略

### 1.1 核心原则

- **渐进式迁移**：不做大规模重写，逐步引入框架能力
- **风险可控**：每个阶段都有明确的回滚方案
- **价值优先**：优先实施高价值、低风险的改进
- **持续验证**：每个阶段都有明确的验收标准

### 1.2 实施路线图概览

```
阶段 1: 工具标准化 (1-2周)
    ↓
阶段 2: 提示词管理 (1周)
    ↓
阶段 3: 复杂工作流 (2-3周)
    ↓
阶段 4: 优化和监控 (持续)
```

## 2. 阶段 1：工具标准化（1-2周）

### 2.1 目标

将现有的搜索和分析能力包装为 LangChain Tools，建立标准化的工具接口。

### 2.2 具体任务

#### 任务 1.1：创建工具包装层（3天）

**负责人**：后端开发

**工作内容**：
1. 创建 `apps/api/src/langchain/tools/` 目录
2. 实现 `CodeSearchTool` 包装 `MultiStrategySearch`
3. 实现 `DependencyAnalysisTool` 包装 `DependencyGraphAnalyzer`
4. 实现 `CallGraphTool` 包装 `CallGraphBuilder`

**代码示例**：
```typescript
// apps/api/src/langchain/tools/code-search-tool.ts
import { Tool } from "@langchain/core/tools";
import { MultiStrategySearch } from "../../llm/multi-strategy-search";

export class CodeSearchTool extends Tool {
  name = "code_search";
  description = "搜索代码库中的相关代码片段";
  
  constructor(private searchEngine: MultiStrategySearch) {
    super();
  }
  
  async _call(query: string): Promise<string> {
    const results = await this.searchEngine.search(query, {
      maxResults: 10,
      includeContext: true,
    });
    return JSON.stringify(results);
  }
}
```

**验收标准**：
- [ ] 所有工具类实现完成
- [ ] 工具调用返回结果与原生实现一致
- [ ] 单元测试覆盖率 > 80%

#### 任务 1.2：编写单元测试（2天）

**负责人**：后端开发

**工作内容**：
1. 为每个工具编写单元测试
2. 测试工具输入输出格式
3. 测试错误处理逻辑

**测试示例**：
```typescript
// apps/api/src/langchain/tools/__tests__/code-search-tool.test.ts
describe('CodeSearchTool', () => {
  it('should return search results in correct format', async () => {
    const mockSearch = {
      search: jest.fn().mockResolvedValue([
        { filePath: 'test.ts', content: 'code', score: 0.9 }
      ])
    };
    
    const tool = new CodeSearchTool(mockSearch as any);
    const result = await tool.call('test query');
    
    expect(JSON.parse(result)).toHaveLength(1);
    expect(mockSearch.search).toHaveBeenCalledWith('test query', expect.any(Object));
  });
});
```

**验收标准**：
- [ ] 每个工具至少 5 个测试用例
- [ ] 测试覆盖正常流程和异常流程
- [ ] 所有测试通过

#### 任务 1.3：集成到现有系统（2天）

**负责人**：后端开发

**工作内容**：
1. 在 `AgentCore` 中初始化工具
2. 添加工具调用日志
3. 验证工具在实际场景中的表现

**验收标准**：
- [ ] 工具可以在 AgentCore 中正常调用
- [ ] 日志记录完整
- [ ] 性能无明显下降（< 5%）

### 2.3 风险和缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 工具接口设计不合理 | 中 | 低 | 参考 LangChain 官方示例，进行代码评审 |
| 性能下降 | 高 | 低 | 建立性能基准测试，持续监控 |
| 测试覆盖不足 | 中 | 中 | 强制要求测试覆盖率 > 80% |

### 2.4 交付物

- [ ] 3 个工具类实现
- [ ] 完整的单元测试套件
- [ ] 工具使用文档
- [ ] 性能基准测试报告

## 3. 阶段 2：提示词管理（1周）

### 3.1 目标

将硬编码的提示词迁移到 LangChain PromptTemplate，建立提示词版本控制和管理体系。

### 3.2 具体任务

#### 任务 2.1：提取现有提示词（2天）

**负责人**：后端开发

**工作内容**：
1. 审计代码中所有硬编码的提示词
2. 分类提示词（搜索、分析、生成等）
3. 创建提示词清单

**提示词清单示例**：
```markdown
| 提示词名称 | 用途 | 当前位置 | 变量 |
|-----------|------|---------|------|
| search_query_classification | 分类查询类型 | agent-core.ts:45 | {question} |
| code_explanation | 解释代码 | agent-core.ts:120 | {code, context} |
| root_cause_hypothesis | 生成根因假设 | agent-core.ts:200 | {problem, evidence} |
```

**验收标准**：
- [ ] 所有提示词已识别
- [ ] 提示词清单完整
- [ ] 变量已标注

#### 任务 2.2：创建 PromptTemplate（2天）

**负责人**：后端开发

**工作内容**：
1. 创建 `apps/api/src/langchain/prompts/` 目录
2. 将提示词转换为 PromptTemplate
3. 添加提示词版本号

**代码示例**：
```typescript
// apps/api/src/langchain/prompts/search-prompts.ts
import { PromptTemplate } from "@langchain/core/prompts";

export const QUERY_CLASSIFICATION_PROMPT = new PromptTemplate({
  template: `你是一个代码查询分类器。分析以下问题并分类：

问题：{question}

可能的类型：
- simple_search: 简单的代码搜索
- code_explanation: 代码解释
- root_cause_analysis: 根因分析
- impact_analysis: 影响分析

返回分类结果（只返回类型名称）：`,
  inputVariables: ["question"],
});

export const CODE_EXPLANATION_PROMPT = new PromptTemplate({
  template: `解释以下代码：

代码：
\`\`\`
{code}
\`\`\`

上下文：
{context}

请提供清晰、简洁的解释，包括：
1. 代码的主要功能
2. 关键逻辑和算法
3. 潜在的问题或改进建议`,
  inputVariables: ["code", "context"],
});
```

**验收标准**：
- [ ] 所有提示词已转换为 PromptTemplate
- [ ] 提示词有版本号和描述
- [ ] 提示词可以正常渲染

#### 任务 2.3：替换硬编码提示词（1天）

**负责人**：后端开发

**工作内容**：
1. 在代码中使用 PromptTemplate 替换硬编码字符串
2. 验证功能正常
3. 清理旧代码

**代码示例**：
```typescript
// 之前
const prompt = `你是一个代码查询分类器。分析以下问题并分类：\n\n问题：${question}\n\n...`;

// 之后
import { QUERY_CLASSIFICATION_PROMPT } from "../langchain/prompts/search-prompts";
const prompt = await QUERY_CLASSIFICATION_PROMPT.format({ question });
```

**验收标准**：
- [ ] 所有硬编码提示词已替换
- [ ] 功能测试通过
- [ ] 代码审查通过

#### 任务 2.4：建立提示词版本控制（1天）

**负责人**：后端开发

**工作内容**：
1. 创建提示词版本管理系统
2. 添加提示词 A/B 测试能力
3. 建立提示词评估指标

**代码示例**：
```typescript
// apps/api/src/langchain/prompts/prompt-manager.ts
export class PromptManager {
  private prompts: Map<string, PromptTemplate[]> = new Map();
  
  registerPrompt(name: string, version: string, template: PromptTemplate) {
    const key = `${name}:${version}`;
    // ...
  }
  
  getPrompt(name: string, version: string = 'latest'): PromptTemplate {
    // ...
  }
  
  async evaluatePrompt(name: string, testCases: any[]): Promise<number> {
    // 评估提示词质量
  }
}
```

**验收标准**：
- [ ] 提示词版本管理系统实现
- [ ] 可以切换不同版本的提示词
- [ ] 有基本的评估能力

### 3.3 交付物

- [ ] 提示词清单文档
- [ ] 所有 PromptTemplate 实现
- [ ] 提示词版本管理系统
- [ ] 提示词使用指南

## 4. 阶段 3：复杂工作流（2-3周）

### 3.1 目标

使用 LangGraph 实现根因分析和影响分析工作流，提升复杂推理能力。

### 3.2 具体任务

#### 任务 3.1：设计工作流状态机（2天）

**负责人**：架构师 + 后端开发

**工作内容**：
1. 设计根因分析工作流状态机
2. 设计影响分析工作流状态机
3. 定义状态转换条件

**根因分析状态机**：
```
[开始]
  ↓
[生成假设] ← ─ ─ ─ ─ ─ ─ ─ ┐
  ↓                        │
[收集证据]                  │
  ↓                        │
[评估假设]                  │
  ↓                        │
[决策] ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
  ↓ (置信度 >= 0.7)
[最终化]
  ↓
[结束]
```

**验收标准**：
- [ ] 状态机设计文档完成
- [ ] 状态转换逻辑清晰
- [ ] 团队评审通过

#### 任务 3.2：实现根因分析工作流（5天）

**负责人**：后端开发

**工作内容**：
1. 实现 `RootCauseAnalysisWorkflow` 类
2. 实现各个节点的逻辑
3. 添加日志和追踪

**关键代码**（参考 03 文档中的完整实现）：
```typescript
export class RootCauseAnalysisWorkflow {
  private graph: StateGraph<RootCauseState>;
  
  constructor(/* tools */) {
    this.graph = this.buildGraph();
  }
  
  private buildGraph() {
    const workflow = new StateGraph<RootCauseState>({/* ... */});
    
    workflow.addNode("generate_hypotheses", async (state) => {/* ... */});
    workflow.addNode("gather_evidence", async (state) => {/* ... */});
    workflow.addNode("evaluate_hypotheses", async (state) => {/* ... */});
    // ...
    
    return workflow.compile();
  }
  
  async analyze(problem: string): Promise<RootCauseState> {
    // ...
  }
}
```

**验收标准**：
- [ ] 工作流实现完成
- [ ] 可以处理简单的根因分析问题
- [ ] 日志记录完整

#### 任务 3.3：实现影响分析工作流（5天）

**负责人**：后端开发

**工作内容**：
1. 实现 `ImpactAnalysisWorkflow` 类
2. 实现依赖链分析逻辑
3. 实现风险评估逻辑

**影响分析状态机**：
```
[开始]
  ↓
[识别变更点]
  ↓
[分析直接依赖]
  ↓
[分析间接依赖] ← ─ ─ ─ ─ ┐
  ↓                      │
[评估风险]                │
  ↓                      │
[决策] ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
  ↓ (深度 < 最大深度)
[生成报告]
  ↓
[结束]
```

**验收标准**：
- [ ] 工作流实现完成
- [ ] 可以分析代码变更的影响范围
- [ ] 风险评估准确

#### 任务 3.4：集成到 AgentCore（2天）

**负责人**：后端开发

**工作内容**：
1. 在 `AgentCore` 中初始化工作流
2. 根据查询类型路由到不同的工作流
3. 统一返回格式

**代码示例**：
```typescript
export class AgentCore {
  private rootCauseWorkflow: RootCauseAnalysisWorkflow;
  private impactAnalysisWorkflow: ImpactAnalysisWorkflow;
  
  async query(question: string, sessionId?: string) {
    const queryType = this.classifyQueryType(question);
    
    switch (queryType) {
      case "root_cause_analysis":
        return this.handleRootCauseAnalysis(question, sessionId);
      case "impact_analysis":
        return this.handleImpactAnalysis(question, sessionId);
      default:
        return this.handleSimpleQuery(question, sessionId);
    }
  }
}
```

**验收标准**：
- [ ] 工作流集成完成
- [ ] 查询路由正确
- [ ] 端到端测试通过

#### 任务 3.5：编写集成测试（2天）

**负责人**：后端开发 + QA

**工作内容**：
1. 编写根因分析集成测试
2. 编写影响分析集成测试
3. 编写性能测试

**测试用例示例**：
```typescript
describe('RootCauseAnalysisWorkflow Integration', () => {
  it('should identify root cause for test failure', async () => {
    const workflow = new RootCauseAnalysisWorkflow(/* ... */);
    const result = await workflow.analyze('为什么 UserService 测试失败了？');
    
    expect(result.rootCause).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.evidence).toHaveLength(3);
  });
});
```

**验收标准**：
- [ ] 至少 10 个集成测试用例
- [ ] 测试覆盖主要场景
- [ ] 所有测试通过

### 3.3 风险和缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 工作流逻辑复杂，难以调试 | 高 | 中 | 添加详细日志，使用 LangSmith 调试工具 |
| LLM 调用次数过多，成本高 | 中 | 中 | 优化工作流，减少不必要的 LLM 调用 |
| 工作流不稳定，结果不一致 | 高 | 中 | 添加重试机制，设置合理的超时 |

### 3.4 交付物

- [ ] 根因分析工作流实现
- [ ] 影响分析工作流实现
- [ ] 完整的集成测试套件
- [ ] 工作流使用文档
- [ ] 性能测试报告

## 5. 阶段 4：优化和监控（持续）

### 5.1 目标

建立持续优化和监控体系，确保系统稳定性和性能。

### 5.2 具体任务

#### 任务 4.1：建立监控体系（1周）

**负责人**：DevOps + 后端开发

**工作内容**：
1. 添加工作流执行时间监控
2. 添加 LLM 调用次数和成本监控
3. 添加错误率监控
4. 建立告警机制

**监控指标**：
```typescript
interface WorkflowMetrics {
  workflowName: string;
  executionTime: number;
  llmCalls: number;
  llmCost: number;
  success: boolean;
  errorType?: string;
  timestamp: Date;
}
```

**验收标准**：
- [ ] 监控指标收集完整
- [ ] 监控面板可视化
- [ ] 告警规则配置完成

#### 任务 4.2：性能优化（持续）

**负责人**：后端开发

**优化方向**：
1. **减少 LLM 调用次数**
   - 缓存常见查询结果
   - 批量处理相似查询
   - 优化提示词，减少多轮对话

2. **并行化处理**
   - 工具调用并行执行
   - 证据收集并行化

3. **智能路由**
   - 简单问题不走复杂工作流
   - 根据历史数据预测查询类型

**验收标准**：
- [ ] 平均响应时间减少 20%
- [ ] LLM 调用次数减少 30%
- [ ] 成本降低 25%

#### 任务 4.3：质量评估（持续）

**负责人**：后端开发 + QA

**工作内容**：
1. 建立工作流质量评估体系
2. 收集用户反馈
3. 定期评估和改进

**评估指标**：
- 根因分析准确率
- 影响分析覆盖率
- 用户满意度
- 响应时间

**验收标准**：
- [ ] 评估体系建立
- [ ] 每月生成质量报告
- [ ] 持续改进计划

### 5.3 交付物

- [ ] 监控面板
- [ ] 性能优化报告
- [ ] 质量评估报告
- [ ] 持续改进计划

## 6. 资源需求

### 6.1 人力资源

| 角色 | 人数 | 投入时间 |
|------|------|---------|
| 架构师 | 1 | 20% (咨询和评审) |
| 后端开发 | 2 | 100% (4-6周) |
| QA | 1 | 50% (测试和验证) |
| DevOps | 1 | 20% (监控和部署) |

### 6.2 技术资源

| 资源 | 用途 | 成本估算 |
|------|------|---------|
| LangChain/LangGraph | 框架依赖 | 免费（开源） |
| Anthropic API | LLM 调用 | $500-1000/月（开发测试） |
| LangSmith | 调试和监控 | $50/月 |
| 测试环境 | 集成测试 | 现有资源 |

### 6.3 时间估算

| 阶段 | 时间 | 依赖 |
|------|------|------|
| 阶段 1: 工具标准化 | 1-2周 | - |
| 阶段 2: 提示词管理 | 1周 | 阶段 1 |
| 阶段 3: 复杂工作流 | 2-3周 | 阶段 1, 2 |
| 阶段 4: 优化和监控 | 持续 | 阶段 3 |

**总计**：4-6周（核心功能），然后持续优化

## 7. 成功标准

### 7.1 技术指标

- [ ] 所有阶段的验收标准达成
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过率 > 95%
- [ ] 性能下降 < 10%

### 7.2 业务指标

- [ ] 根因分析准确率 > 85%
- [ ] 影响分析覆盖率 > 90%
- [ ] 用户满意度 > 4.5/5
- [ ] 开发效率提升 > 50%

### 7.3 质量指标

- [ ] 代码可读性提升 > 20%
- [ ] Bug 数量减少 > 30%
- [ ] 维护成本降低 > 40%

## 8. 风险总结

### 8.1 高风险项

| 风险 | 缓解措施 | 负责人 |
|------|---------|--------|
| 工作流不稳定 | 充分测试，添加重试机制 | 后端开发 |
| 性能下降 | 建立基准测试，持续监控 | 后端开发 + DevOps |
| 学习曲线陡峭 | 提供培训，建立最佳实践 | 架构师 |

### 8.2 中风险项

| 风险 | 缓解措施 | 负责人 |
|------|---------|--------|
| 成本超支 | 优化 LLM 调用，使用缓存 | 后端开发 |
| 进度延期 | 预留缓冲时间，及时调整 | 项目经理 |
| 依赖问题 | 选择成熟框架，保留降级方案 | 架构师 |

## 9. 回滚方案

### 9.1 阶段 1 回滚

如果工具标准化出现问题：
- 移除工具包装层
- 恢复直接调用原生实现
- 影响范围：仅新增代码，无需回滚

### 9.2 阶段 2 回滚

如果提示词管理出现问题：
- 恢复硬编码提示词
- 移除 PromptTemplate
- 影响范围：中等，需要代码回滚

### 9.3 阶段 3 回滚

如果工作流出现严重问题：
- 禁用 LangGraph 工作流
- 路由回原生实现
- 保留工具层和提示词管理
- 影响范围：大，但有降级方案

## 10. 下一步行动

### 10.1 立即行动（本周）

1. [ ] 召开项目启动会议
2. [ ] 确认团队成员和角色
3. [ ] 搭建开发环境
4. [ ] 创建项目看板

### 10.2 短期行动（2周内）

1. [ ] 完成阶段 1：工具标准化
2. [ ] 完成阶段 2：提示词管理
3. [ ] 开始阶段 3：复杂工作流设计

### 10.3 中期行动（4-6周内）

1. [ ] 完成阶段 3：复杂工作流实现
2. [ ] 开始阶段 4：优化和监控
3. [ ] 收集用户反馈

### 10.4 长期行动（持续）

1. [ ] 持续优化性能
2. [ ] 持续改进质量
3. [ ] 探索新的框架能力

---

**相关文档**：
- [01：项目概览和框架对比](./framework-comparison-01-overview.md)
- [02：开发者体验对比](./framework-comparison-02-comparison.md)
- [03：混合架构设计](./framework-comparison-03-hybrid-architecture.md)
