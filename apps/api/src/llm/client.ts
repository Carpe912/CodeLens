/**
 * LLM 客户端抽象层 —— 基于 LangChain ChatOpenAI (DeepSeek OpenAI 兼容协议)
 *
 * 背景：
 * 本项目的问答链路（llm/qa.ts）与 Agent（agent/core.ts）历史上直接依赖
 * 手写的 SDK 适配层（334 行，其中非注释代码 188 行）。改用 LangChain 的收益
 * **只有一项**：两个手写厂商类收敛成一个由 @langchain/openai 支撑的类，
 * 非注释代码降到 131 行（-57）；总行数 334 → 257，差额主要是注释体量变化 ——
 * 少维护一层适配，SDK 细节交给了框架。
 *
 * （行数按"非注释代码行"口径统计，因为总行数会随注释增减而变，算收益会失真。）
 *
 * ⚠️ 这里刻意不列举"结构化输出""Prompt 模板"之类的收益，因为它们没有发生：
 * withStructuredOutput 与 ChatPromptTemplate 在全仓零使用，提示词仍是模板字符串。
 * 尤其 withStructuredOutput 对本项目是**不该用**的 —— 引用校验必须独立于模型
 * 自述，理由见 docs/design/framework-comparison-05-boundaries.md §4.9（查伪 ≠ 自证）。
 * 之前把"能力可用"写成"收益已获得"，又被反复引来当作"已迁移"的证据，
 * 因此这句负面清单本身就是注释的一部分，勿删。
 *
 * 环境变量：
 * - LLM_MODEL             覆盖模型名（优先级最高），默认 deepseek-chat
 * - DEEPSEEK_API_KEY      DeepSeek 密钥（必填）
 * - DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 *
 * 注意：向量嵌入不在此模块范围内，仍由 llm/embeddings.ts 通过 EMBED_* 配置独立完成。
 */

import { ChatOpenAI } from '@langchain/openai';
import { describeError } from '../utils/errors.js';

/**
 * LLM 厂商
 *
 * 本项目只用 DeepSeek，因此这里只有一个成员。它保留为类型（而不是直接写死
 * 字面量）是为了给 `provider` 字段与启动日志一个具名锚点：将来真的接入第二家
 * 厂商时，从这里加成员、并让 resolveModel/getApiKey 分派即可。
 */
export type LlmProvider = 'deepseek';

/** 单条对话消息（Anthropic 与 OpenAI 兼容接口的共同子集） */
export interface LlmChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 发起一次对话所需的参数
 *
 * 刻意声明为 Anthropic Messages API 的子集，使既有调用点无需改造即可编译通过。
 */
export interface LlmMessageParams {
  /** 模型名；留空则由本模块按当前厂商解析默认值 */
  model?: string;
  max_tokens: number;
  temperature?: number;
  /** 系统提示词（Anthropic 的顶层 system 字段） */
  system?: string;
  messages: LlmChatMessage[];
}

/** 返回内容块的最小结构，与 Anthropic 的 TextBlock 兼容 */
export interface LlmContentBlock {
  type: string;
  text?: string;
}

/** 返回结构的最小形状，保证 `response.content[0].text` 这种既有取法可用 */
export interface LlmMessageResponse {
  content: LlmContentBlock[];
  /** 实际生效的模型名（由厂商回包给出，便于日志核对） */
  model?: string;
}

/** 上层统一使用的客户端接口 */
export interface LlmClient {
  readonly provider: LlmProvider;
  /** 当前厂商的默认模型名（仅用于日志展示） */
  readonly defaultModel: string;
  messages: {
    create(params: LlmMessageParams): Promise<LlmMessageResponse>;
  };
}

/**
 * 从回包中取出纯文本内容
 *
 * 历史上调用点写的是 `response.content[0].text`——这有两个隐含假设：
 * 1. 第一个内容块一定是文本块；
 * 2. 文本块一定有 text 字段。
 * 接第三方（尤其带思维链的模型）时这两个假设都不再成立，因此统一在这里取，
 * 既避免类型上的 `string | undefined`，也避免上层各写一遍。
 *
 * @returns 第一个文本块的内容；没有文本块时返回空字符串
 */
export function getResponseText(response: LlmMessageResponse): string {
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock?.text ?? '';
}

/** DeepSeek 官方稳定别名；底层实际生效模型由回包中的 model 字段体现 */
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * 解析真正发给厂商的模型名
 *
 * 存在关键原因：调用点里可能写死旧模型名，这里做一次归一化，
 * 让「换模型」不必同时改所有调用点。
 */
export function resolveModel(requested?: string): string {
  const configured = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL;
  if (configured) {
    return configured;
  }
  if (requested && !/^claude/i.test(requested)) {
    return requested;
  }
  return DEFAULT_DEEPSEEK_MODEL;
}

/**
 * LangChain ChatOpenAI 客户端（DeepSeek OpenAI 兼容协议）
 *
 * 通过 @langchain/openai 接 DeepSeek 的 OpenAI 兼容端点，并把结果收敛成
 * 上层既有的 `messages.create` 契约（见 LlmMessageResponse），
 * 使调用点无需感知 LangChain 的存在。
 *
 * ⚠️ 为什么按 (model, maxTokens, temperature) 缓存实例：
 * LangChain v1 的 `invoke(input, options)` **不接受** model / maxTokens / temperature
 * 这三个参数（它们只能在构造时指定，见 BaseChatOpenAIFields）。
 * 而本项目各调用点的 max_tokens（64 / 2000）、temperature（0 / 未指定）确实不同，
 * 所以这里按参数组合做实例缓存：既保住「按次覆盖」的既有语义，
 * 又避免每次调用都新建客户端（重复建连）。
 * 组合数极少（模型名基本被 resolveModel 收敛成 1 个），缓存不会膨胀。
 */
class LangChainLlmClient implements LlmClient {
  readonly provider: LlmProvider = 'deepseek';
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly instances = new Map<string, ChatOpenAI>();

  constructor(apiKey: string) {
    this.defaultModel = resolveModel();
    this.apiKey = apiKey;
  }

  /** 取（或创建）指定参数组合对应的实例 */
  private getClient(model: string, maxTokens: number, temperature: number): ChatOpenAI {
    const key = `${model}|${maxTokens}|${temperature}`;
    let client = this.instances.get(key);
    if (!client) {
      client = new ChatOpenAI({
        model,
        apiKey: this.apiKey || 'missing',
        configuration: {
          baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        },
        maxTokens,
        temperature,
      });
      this.instances.set(key, client);
    }
    return client;
  }

  readonly messages = {
    create: async (params: LlmMessageParams): Promise<LlmMessageResponse> => {
      // 密钥校验放在调用时而非构造时：构造发生在模块导入阶段，一旦构造即抛错，
      // 会让「只是 import 了本模块」的脚本（校验脚本、迁移脚本）整体崩溃。
      if (!this.apiKey) {
        throw new Error('缺少 DEEPSEEK_API_KEY：请在 .env.production 中配置 DeepSeek 密钥');
      }

      const model = resolveModel(params.model);
      // 未显式传 temperature 时用 0.7，与改造前 OpenAI SDK 的缺省行为一致
      const client = this.getClient(model, params.max_tokens, params.temperature ?? 0.7);

      // system 在 LangChain 里是首条 system 消息
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      if (params.system) {
        messages.push({ role: 'system', content: params.system });
      }
      for (const m of params.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      try {
        // LangChain 的 invoke 接受消息数组或字符串，返回 AIMessageChunk
        const response = await client.invoke(messages);

        // AIMessageChunk.content 可能是 string 或内容块数组，统一转成字符串
        const text = typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content.map((c: unknown) => typeof c === 'string' ? c : '').join('')
            : String(response.content ?? '');

        return {
          content: [{ type: 'text', text }],
          model,
        };
      } catch (error) {
        // 带上模型名和展开后的错误：空的 AggregateError message 曾让线上排查寸步难行
        throw new Error(`DeepSeek 调用失败 (model=${model}): ${describeError(error)}`);
      }
    },
  };
}

/**
 * 取当前厂商所需的凭据
 *
 * 刻意**不抛错**，缺失时返回空字符串：调用方（getLlmClient 发生在模块导入阶段）
 * 一旦抛错会让所有 import 本模块的脚本整体挂掉。真正的报错交给
 * messages.create 内的校验，以及服务启动时的 validateEnv()。
 */
function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || '';
}

/** 当前厂商的凭据是否已配置（供启动日志与校验脚本使用） */
export function hasApiKey(): boolean {
  return Boolean(getApiKey());
}

/**
 * 按当前配置构造客户端（每次调用都会新建，仅测试或需要独立实例时使用）
 */
export function createLlmClient(): LlmClient {
  const apiKey = getApiKey();
  return new LangChainLlmClient(apiKey);
}

// 进程内单例：整个 API 只应存在一份客户端，避免重复建连
let cachedClient: LlmClient | null = null;

/**
 * 获取共享的 LLM 客户端（懒加载单例）
 *
 * 上层所有调用点都应使用本函数，以保证与改造前「单例共享」的行为一致。
 */
export function getLlmClient(): LlmClient {
  if (!cachedClient) {
    cachedClient = createLlmClient();
    console.log(
      `[LLM] provider=${cachedClient.provider} model=${cachedClient.defaultModel}`
    );
  }
  return cachedClient;
}

/**
 * 描述当前 LLM 配置，用于启动日志与运维核对
 *
 * 刻意只输出 baseURL 的 host 和「密钥是否存在」，不输出密钥本身。
 */
export function describeLlmConfig(): string {
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let host = baseURL;
  try {
    host = new URL(baseURL).host;
  } catch {
    // baseURL 非法时原样展示，便于发现配置错误
  }
  const keyState = hasApiKey() ? '已配置' : '缺失';
  return `provider=deepseek model=${resolveModel()} baseURL=${host} apiKey=${keyState}`;
}
