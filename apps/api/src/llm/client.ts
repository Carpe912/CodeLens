/**
 * LLM 客户端抽象层 —— 基于 LangChain ChatOpenAI (DeepSeek OpenAI 兼容协议)
 *
 * 背景：
 * 本项目的问答链路（llm/qa.ts）与 Agent（agent/core.ts）历史上直接依赖
 * 手写的 OpenAI SDK 适配层。改用 LangChain 后有三个收益：
 * 1. 代码量减少 ~280 行，维护成本降低；
 * 2. 获得结构化输出能力（withStructuredOutput），替代正则提取引用；
 * 3. Prompt 模板管理（ChatPromptTemplate），实现提示词与代码分离。
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

/** 支持的 LLM 厂商 */
export type LlmProvider = 'deepseek' | 'anthropic';

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
 * 通过 @langchain/openai 把 Chat Completions 的出入参翻译成 Anthropic 形状，
 * 使上层调用点无需感知框架差异。
 */
class LangChainLlmClient implements LlmClient {
  readonly provider: LlmProvider = 'deepseek';
  readonly defaultModel: string;
  private readonly client: ChatOpenAI;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.defaultModel = resolveModel();
    this.apiKey = apiKey;
    this.client = new ChatOpenAI({
      modelName: this.defaultModel,
      apiKey: apiKey || 'missing',
      configuration: {
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      },
      temperature: 0.7, // 默认值，实际调用时会被 params.temperature 覆盖
      maxTokens: 2000,  // 默认值，实际调用时会被 params.max_tokens 覆盖
    });
  }

  readonly messages = {
    create: async (params: LlmMessageParams): Promise<LlmMessageResponse> => {
      // 密钥校验放在调用时而非构造时：构造发生在模块导入阶段，一旦构造即抛错，
      // 会让「只是 import 了本模块」的脚本（校验脚本、迁移脚本）整体崩溃。
      if (!this.apiKey) {
        throw new Error('缺少 DEEPSEEK_API_KEY：请在 .env.production 中配置 DeepSeek 密钥');
      }

      const model = resolveModel(params.model);

      // system 在 LangChain 里是首条 system 消息
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      if (params.system) {
        messages.push({ role: 'system', content: params.system });
      }
      for (const m of params.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      try {
        // LangChain 的 invoke 接受数组或字符串，返回 AIMessageChunk
        const response = await this.client.invoke(messages, {
          modelName: model,
          maxTokens: params.max_tokens,
          temperature: params.temperature ?? 0.7,
        });

        // AIMessageChunk.content 可能是 string 或 Array，统一转成字符串
        const text = typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content.map((c: unknown) => typeof c === 'string' ? c : '').join('')
            : String(response.content ?? '');

        return {
          content: [{ type: 'text', text }],
          model: model,
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

/**
 * 解析当前应使用的厂商（保留以兼容既有配置解析逻辑）
 *
 * 由于本项目当前只用 DeepSeek，此函数固定返回 'deepseek'。
 * 保留此函数的意义是让 server/context.ts 等既有导入点无需改动即可编译通过。
 */
export function resolveProvider(): LlmProvider {
  return 'deepseek';
}
