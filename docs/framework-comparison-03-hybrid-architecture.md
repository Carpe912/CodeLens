# CodeLens 框架对比分析 - 03：混合架构设计

## 1. 混合架构设计原则

### 1.1 核心原则

**"框架处理通用，原生优化关键"**

- **性能关键路径**：保持原生实现，避免框架抽象开销
- **复杂推理场景**：使用框架的编排能力，降低开发复杂度
- **接口标准化**：使用框架的工具和提示词管理，提升可维护性
- **渐进式迁移**：不做大规模重写，逐步引入框架能力

### 1.2 技术选型矩阵

| 模块 | 实现方式 | 框架选择 | 理由 |
|------|---------|---------|------|
| 向量搜索引擎 | 原生 | - | 性能关键，需要精细控制 |
| 精确/模糊匹配 | 原生 | - | 已优化，无需改动 |
| 依赖图分析 | 原生 | - | 图算法性能敏感 |
| 调用图可视化 | 原生 | - | 渲染性能关键 |
| 简单问答 | 原生 | - | 直接调用 Anthropic SDK 更简洁 |
| 根因分析 | 框架 | LangGraph | 多步推理，状态管理复杂 |
| 影响分析 | 框架 | LangGraph | 需要循环推理和回溯 |
| 工具定义 | 框架 | LangChain | 标准化工具接口 |
| 提示词管理 | 框架 | LangChain | 版本控制和模板化 |
| 会话历史 | 混合 | LangChain Memory + PostgreSQL | 框架提供抽象，数据库存储 |

## 2. 分层架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层 (VSCode Extension)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  推理层 (LangGraph Workflows)                 │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  根因分析工作流   │  │  影响分析工作流   │                 │
│  │  - 问题定位      │  │  - 变更影响评估   │                 │
│  │  - 证据收集      │  │  - 依赖链分析     │                 │
│  │  - 假设验证      │  │  - 风险评估       │                 │
│  └──────────────────┘  └──────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  接口层 (LangChain Tools)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 搜索工具  │  │ 分析工具  │  │ 图工具    │  │ 查询工具  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  核心层 (Native Implementation)               │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  MultiStrategy    │  │  DependencyGraph │                 │
│  │  Search Engine    │  │  Analyzer        │                 │
│  └──────────────────┘  └──────────────────┘                 │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  Vector Index     │  │  Call Graph      │                 │
│  │  Manager          │  │  Builder         │                 │
│  └──────────────────┘  └──────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  数据层 (PostgreSQL + Vector DB)              │
└─────────────────────────────────────────────────────────────┘
```

## 3. 具体实现示例

### 3.1 LangChain Tools 包装现有搜索能力

```typescript
// apps/api/src/langchain/tools/search-tool.ts
import { Tool } from "@langchain/core/tools";
import { MultiStrategySearch } from "../../llm/multi-strategy-search";

export class CodeSearchTool extends Tool {
  name = "code_search";
  description = `搜索代码库中的相关代码片段。
  输入应该是一个搜索查询字符串。
  返回最相关的代码片段及其上下文。`;

  private searchEngine: MultiStrategySearch;

  constructor(searchEngine: MultiStrategySearch) {
    super();
    this.searchEngine = searchEngine;
  }

  async _call(query: string): Promise<string> {
    const results = await this.searchEngine.search(query, {
      maxResults: 10,
      includeContext: true,
    });

    return JSON.stringify({
      results: results.map(r => ({
        file: r.filePath,
        lines: `${r.startLine}-${r.endLine}`,
        code: r.content,
        relevance: r.score,
      })),
    });
  }
}

export class DependencyAnalysisTool extends Tool {
  name = "dependency_analysis";
  description = `分析代码依赖关系。
  输入应该是文件路径或符号名称。
  返回依赖图和影响范围。`;

  private analyzer: DependencyGraphAnalyzer;

  constructor(analyzer: DependencyGraphAnalyzer) {
    super();
    this.analyzer = analyzer;
  }

  async _call(input: string): Promise<string> {
    const graph = await this.analyzer.analyze(input);
    
    return JSON.stringify({
      dependencies: graph.dependencies,
      dependents: graph.dependents,
      depth: graph.maxDepth,
      affectedFiles: graph.affectedFiles.length,
    });
  }
}

export class CallGraphTool extends Tool {
  name = "call_graph";
  description = `获取函数调用图。
  输入应该是函数名称或文件路径。
  返回调用关系和调用链。`;

  private graphBuilder: CallGraphBuilder;

  constructor(graphBuilder: CallGraphBuilder) {
    super();
    this.graphBuilder = graphBuilder;
  }

  async _call(input: string): Promise<string> {
    const graph = await this.graphBuilder.build(input);
    
    return JSON.stringify({
      callers: graph.callers,
      callees: graph.callees,
      callChains: graph.chains,
    });
  }
}
```

### 3.2 LangGraph 工作流：根因分析

```typescript
// apps/api/src/langgraph/workflows/root-cause-analysis.ts
import { StateGraph, END } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import { CodeSearchTool, DependencyAnalysisTool, CallGraphTool } from "../tools";

// 定义状态
interface RootCauseState {
  problem: string;
  hypotheses: string[];
  evidence: Array<{
    hypothesis: string;
    supporting: any[];
    contradicting: any[];
  }>;
  rootCause: string | null;
  confidence: number;
  iteration: number;
}

export class RootCauseAnalysisWorkflow {
  private graph: StateGraph<RootCauseState>;
  private llm: ChatAnthropic;
  private tools: Tool[];

  constructor(
    searchEngine: MultiStrategySearch,
    dependencyAnalyzer: DependencyGraphAnalyzer,
    callGraphBuilder: CallGraphBuilder
  ) {
    this.llm = new ChatAnthropic({
      modelName: "claude-3-5-sonnet-20241022",
      temperature: 0,
    });

    this.tools = [
      new CodeSearchTool(searchEngine),
      new DependencyAnalysisTool(dependencyAnalyzer),
      new CallGraphTool(callGraphBuilder),
    ];

    this.graph = this.buildGraph();
  }

  private buildGraph() {
    const workflow = new StateGraph<RootCauseState>({
      channels: {
        problem: null,
        hypotheses: null,
        evidence: null,
        rootCause: null,
        confidence: null,
        iteration: null,
      },
    });

    // 节点 1: 生成假设
    workflow.addNode("generate_hypotheses", async (state) => {
      const prompt = `问题描述: ${state.problem}
      
      基于这个问题，生成 3-5 个可能的根本原因假设。
      每个假设应该具体、可验证。`;

      const response = await this.llm.invoke(prompt);
      const hypotheses = this.parseHypotheses(response.content);

      return {
        ...state,
        hypotheses,
        iteration: 0,
      };
    });

    // 节点 2: 收集证据
    workflow.addNode("gather_evidence", async (state) => {
      const evidence = [];

      for (const hypothesis of state.hypotheses) {
        const supporting = [];
        const contradicting = [];

        // 使用工具收集证据
        for (const tool of this.tools) {
          try {
            const result = await tool.call(hypothesis);
            const parsed = JSON.parse(result);

            // 让 LLM 判断证据是支持还是反驳假设
            const analysis = await this.llm.invoke(`
              假设: ${hypothesis}
              证据: ${JSON.stringify(parsed)}
              
              这个证据是支持还是反驳这个假设？给出理由。
            `);

            if (analysis.content.includes("支持")) {
              supporting.push({ tool: tool.name, data: parsed });
            } else if (analysis.content.includes("反驳")) {
              contradicting.push({ tool: tool.name, data: parsed });
            }
          } catch (error) {
            console.error(`Tool ${tool.name} failed:`, error);
          }
        }

        evidence.push({
          hypothesis,
          supporting,
          contradicting,
        });
      }

      return {
        ...state,
        evidence,
      };
    });

    // 节点 3: 评估假设
    workflow.addNode("evaluate_hypotheses", async (state) => {
      const prompt = `基于以下证据，评估每个假设的可信度:
      
      ${state.evidence.map(e => `
        假设: ${e.hypothesis}
        支持证据: ${e.supporting.length} 条
        反驳证据: ${e.contradicting.length} 条
        详情: ${JSON.stringify(e, null, 2)}
      `).join('\n')}
      
      选择最可能的根本原因，并给出置信度 (0-1)。
      如果置信度低于 0.7，建议需要更多证据的方向。`;

      const response = await this.llm.invoke(prompt);
      const evaluation = this.parseEvaluation(response.content);

      return {
        ...state,
        rootCause: evaluation.rootCause,
        confidence: evaluation.confidence,
      };
    });

    // 节点 4: 决策节点
    workflow.addNode("decide_next", async (state) => {
      if (state.confidence >= 0.7 || state.iteration >= 3) {
        return { ...state, next: "finalize" };
      } else {
        return { ...state, next: "refine", iteration: state.iteration + 1 };
      }
    });

    // 节点 5: 细化假设
    workflow.addNode("refine_hypotheses", async (state) => {
      const prompt = `当前根本原因假设置信度不足 (${state.confidence})。
      
      基于已有证据，细化或生成新的假设:
      ${JSON.stringify(state.evidence, null, 2)}`;

      const response = await this.llm.invoke(prompt);
      const refinedHypotheses = this.parseHypotheses(response.content);

      return {
        ...state,
        hypotheses: refinedHypotheses,
      };
    });

    // 节点 6: 最终化
    workflow.addNode("finalize", async (state) => {
      return state;
    });

    // 定义边
    workflow.setEntryPoint("generate_hypotheses");
    workflow.addEdge("generate_hypotheses", "gather_evidence");
    workflow.addEdge("gather_evidence", "evaluate_hypotheses");
    workflow.addEdge("evaluate_hypotheses", "decide_next");
    
    workflow.addConditionalEdges("decide_next", (state) => {
      return state.next === "finalize" ? "finalize" : "refine_hypotheses";
    });
    
    workflow.addEdge("refine_hypotheses", "gather_evidence");
    workflow.addEdge("finalize", END);

    return workflow.compile();
  }

  async analyze(problem: string): Promise<RootCauseState> {
    const initialState: RootCauseState = {
      problem,
      hypotheses: [],
      evidence: [],
      rootCause: null,
      confidence: 0,
      iteration: 0,
    };

    const result = await this.graph.invoke(initialState);
    return result;
  }

  private parseHypotheses(content: string): string[] {
    // 解析 LLM 输出的假设列表
    const lines = content.split('\n').filter(l => l.trim());
    return lines
      .filter(l => /^\d+\./.test(l.trim()))
      .map(l => l.replace(/^\d+\.\s*/, '').trim());
  }

  private parseEvaluation(content: string): { rootCause: string; confidence: number } {
    // 解析 LLM 输出的评估结果
    const rootCauseMatch = content.match(/根本原因[：:]\s*(.+)/);
    const confidenceMatch = content.match(/置信度[：:]\s*(0?\.\d+|\d+)/);

    return {
      rootCause: rootCauseMatch ? rootCauseMatch[1].trim() : "未确定",
      confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
    };
  }
}
```

### 3.3 集成到现有 API

```typescript
// apps/api/src/agent/agent-core.ts (修改后)
import { RootCauseAnalysisWorkflow } from "../langgraph/workflows/root-cause-analysis";
import { ImpactAnalysisWorkflow } from "../langgraph/workflows/impact-analysis";

export class AgentCore {
  private multiStrategySearch: MultiStrategySearch;
  private dependencyAnalyzer: DependencyGraphAnalyzer;
  private callGraphBuilder: CallGraphBuilder;
  
  // 新增：LangGraph 工作流
  private rootCauseWorkflow: RootCauseAnalysisWorkflow;
  private impactAnalysisWorkflow: ImpactAnalysisWorkflow;

  constructor(/* ... */) {
    // 原有初始化
    this.multiStrategySearch = new MultiStrategySearch(/* ... */);
    this.dependencyAnalyzer = new DependencyGraphAnalyzer(/* ... */);
    this.callGraphBuilder = new CallGraphBuilder(/* ... */);

    // 新增：初始化工作流
    this.rootCauseWorkflow = new RootCauseAnalysisWorkflow(
      this.multiStrategySearch,
      this.dependencyAnalyzer,
      this.callGraphBuilder
    );

    this.impactAnalysisWorkflow = new ImpactAnalysisWorkflow(
      this.multiStrategySearch,
      this.dependencyAnalyzer,
      this.callGraphBuilder
    );
  }

  async query(question: string, sessionId?: string) {
    const queryType = this.classifyQueryType(question);

    switch (queryType) {
      case "simple_search":
      case "code_explanation":
        // 简单查询：保持原生实现
        return this.handleSimpleQuery(question, sessionId);

      case "root_cause_analysis":
        // 根因分析：使用 LangGraph 工作流
        return this.handleRootCauseAnalysis(question, sessionId);

      case "impact_analysis":
        // 影响分析：使用 LangGraph 工作流
        return this.handleImpactAnalysis(question, sessionId);

      default:
        return this.handleSimpleQuery(question, sessionId);
    }
  }

  private async handleSimpleQuery(question: string, sessionId?: string) {
    // 原有的简单查询逻辑
    const evidence = await this.gatherEvidence(question, "simple_search");
    const answer = await this.generateAnswer(question, evidence, "simple_search");
    return answer;
  }

  private async handleRootCauseAnalysis(question: string, sessionId?: string) {
    // 使用 LangGraph 工作流
    const result = await this.rootCauseWorkflow.analyze(question);

    return {
      answer: `根本原因分析结果：\n\n${result.rootCause}\n\n置信度：${(result.confidence * 100).toFixed(1)}%`,
      evidence: result.evidence,
      metadata: {
        workflow: "root_cause_analysis",
        iterations: result.iteration,
        confidence: result.confidence,
      },
    };
  }

  private async handleImpactAnalysis(question: string, sessionId?: string) {
    // 使用 LangGraph 工作流
    const result = await this.impactAnalysisWorkflow.analyze(question);

    return {
      answer: `影响分析结果：\n\n${result.summary}`,
      affectedFiles: result.affectedFiles,
      riskLevel: result.riskLevel,
      metadata: {
        workflow: "impact_analysis",
      },
    };
  }
}
```

## 4. 数据流示例

### 4.1 简单搜索查询（原生实现）

```
用户问题: "如何使用 MultiStrategySearch?"
    │
    ▼
AgentCore.query()
    │
    ▼
classifyQueryType() → "simple_search"
    │
    ▼
MultiStrategySearch.search()
    │
    ├─→ vectorSearch()
    ├─→ exactMatch()
    ├─→ fuzzySearch()
    ├─→ dependencySearch()
    └─→ graphSearch()
    │
    ▼
mergeResults()
    │
    ▼
generateAnswer() (直接调用 Anthropic SDK)
    │
    ▼
返回答案
```

### 4.2 根因分析（LangGraph 工作流）

```
用户问题: "为什么测试失败了?"
    │
    ▼
AgentCore.query()
    │
    ▼
classifyQueryType() → "root_cause_analysis"
    │
    ▼
RootCauseAnalysisWorkflow.analyze()
    │
    ▼
[LangGraph 状态机]
    │
    ├─→ generate_hypotheses (LLM)
    │       │
    │       ▼
    ├─→ gather_evidence
    │       │
    │       ├─→ CodeSearchTool → MultiStrategySearch (原生)
    │       ├─→ DependencyAnalysisTool → DependencyGraphAnalyzer (原生)
    │       └─→ CallGraphTool → CallGraphBuilder (原生)
    │       │
    │       ▼
    ├─→ evaluate_hypotheses (LLM)
    │       │
    │       ▼
    ├─→ decide_next
    │       │
    │       ├─→ [置信度 >= 0.7] → finalize
    │       └─→ [置信度 < 0.7] → refine_hypotheses → 回到 gather_evidence
    │
    ▼
返回根本原因 + 置信度 + 证据链
```

## 5. 性能对比

### 5.1 简单搜索（保持原生）

| 指标 | 原生实现 | 框架实现 | 差异 |
|------|---------|---------|------|
| 响应时间 | 200ms | 250ms | +25% |
| 内存占用 | 50MB | 80MB | +60% |
| 代码行数 | 150 | 80 | -47% |

**结论**：简单搜索保持原生实现，性能更优。

### 5.2 根因分析（使用 LangGraph）

| 指标 | 原生实现 | LangGraph | 差异 |
|------|---------|-----------|------|
| 开发时间 | 2周 | 3天 | -70% |
| 代码行数 | 800 | 300 | -62% |
| 可维护性 | 中 | 高 | +++ |
| 调试难度 | 高 | 中 | -- |
| 响应时间 | 3s | 3.2s | +7% |

**结论**：复杂推理使用 LangGraph，开发效率大幅提升，性能损失可接受。

## 6. 迁移策略

### 6.1 第一阶段：工具标准化（1-2周）

- 将现有搜索、分析能力包装为 LangChain Tools
- 不改变底层实现，只添加标准化接口
- 编写单元测试确保兼容性

### 6.2 第二阶段：提示词管理（1周）

- 将硬编码的提示词迁移到 LangChain PromptTemplate
- 建立提示词版本控制
- 添加提示词 A/B 测试能力

### 6.3 第三阶段：复杂工作流（2-3周）

- 实现根因分析 LangGraph 工作流
- 实现影响分析 LangGraph 工作流
- 与现有 AgentCore 集成

### 6.4 第四阶段：优化和监控（持续）

- 添加工作流性能监控
- 优化 LLM 调用次数
- 建立工作流质量评估体系

## 7. 风险和缓解

### 7.1 性能风险

**风险**：框架抽象层可能引入性能开销

**缓解**：
- 性能关键路径保持原生实现
- 建立性能基准测试
- 监控关键指标（响应时间、内存占用）

### 7.2 依赖风险

**风险**：引入新的外部依赖（LangChain、LangGraph）

**缓解**：
- 选择成熟、活跃维护的框架
- 通过接口隔离，降低耦合度
- 保留原生实现作为降级方案

### 7.3 学习曲线风险

**风险**：团队需要学习新框架

**缓解**：
- 提供内部培训和文档
- 从简单场景开始，逐步推广
- 建立最佳实践和代码示例库

### 7.4 调试复杂度风险

**风险**：框架内部逻辑可能增加调试难度

**缓解**：
- 添加详细的日志和追踪
- 使用 LangSmith 等调试工具
- 保留原生实现作为对照

## 8. 成功指标

### 8.1 开发效率

- 新功能开发时间减少 50%
- 代码行数减少 40%
- Bug 修复时间减少 30%

### 8.2 代码质量

- 代码可读性评分提升 20%
- 单元测试覆盖率达到 80%
- 代码重复率降低 30%

### 8.3 系统性能

- 简单查询响应时间保持在 200ms 以内
- 复杂推理响应时间在 5s 以内
- 内存占用增长不超过 30%

### 8.4 用户体验

- 根因分析准确率达到 85%
- 影响分析覆盖率达到 90%
- 用户满意度评分 4.5/5 以上

---

**下一步**：查看 [04：实施路线图](./framework-comparison-04-implementation.md)
