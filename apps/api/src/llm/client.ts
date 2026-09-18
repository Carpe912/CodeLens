/**
 * LLM 客户端抽象层 —— 让上层代码与具体模型厂商解耦
 *
 * 背景：
 * 本项目的问答链路（llm/qa.ts）与 Agent（agent/core.ts）历史上直接依赖
 * `@anthropic-ai/sdk`，并在代码里写死了 Claude 模型名。要换成 DeepSeek 时，
 * 如果逐个调用点改写，会有三个问题：
 * 1. 调用点散落（qa.ts 两处 + agent/core.ts 一处），容易漏改；
 * 2. 模型名硬编码，换厂商必然 400（Model Not Exist）；
 * 3. 回滚需要改代码，而不是改配置。
 *
 * 因此这里把「调哪个厂商」收敛成一个工厂函数，并对外暴露**与 Anthropic
 * Messages API 同形状**的调用面（`client.messages.create(...)`）。这样：
 * - 上层调用点一行不用改，行为与改造前逐字一致；
 * - 换厂商 / 回滚 = 改一个环境变量（LLM_PROVIDER），零代码改动；
 * - 模型名由本模块统一解析，历史上写死的 `claude-sonnet-4-6` 会被自动
 *   映射成当前厂商的默认模型。
 *
 * 依赖说明：
 * DeepSeek 提供的是 OpenAI 兼容接口，而 `openai` 包本来就是本项目的直接依赖
 * （llm/embeddings.ts 用它做向量嵌入），且已随产物一起安装在服务器上。
 * 因此接入 DeepSeek **不需要新增任何 npm 包**——这一点对服务器部署很重要，
 * 历史上正是漏装依赖导致过线上崩溃。
 *
 * 环境变量：
 * - LLM_PROVIDER          显式指定厂商：deepseek | anthropic（默认按凭据自动判断）
 * - LLM_MODEL             覆盖模型名（优先级最高）
 * - DEEPSEEK_API_KEY      DeepSeek 密钥（必填）
 * - DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 * - DEEPSEEK_MODEL        仅在 LLM_MODEL 未设置时生效，默认 deepseek-chat
 * - ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL   Anthropic 侧配置
 *
 * 注意：向量嵌入**不**在本模块范围内。DeepSeek 不提供嵌入模型，嵌入仍由
 * llm/embeddings.ts 通过 EMBED_* 配置独立完成，两者互不影响。
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

/** 判断是否是 Claude 模型名——这类名字不能透传给 DeepSeek，否则会 400 */
const CLAUDE_MODEL_PATTERN = /^claude/i;

/**
 * 解析当前应使用的厂商
 *
 * 优先级：显式 LLM_PROVIDER > 凭据自动判断 > 默认 deepseek。
 * 自动判断的意义：部署时只补一个 DEEPSEEK_API_KEY 就能完成切换，
 * 不必同时记得改 LLM_PROVIDER。
 */
export function resolveProvider(): LlmProvider {
  const explicit = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'deepseek' || explicit === 'anthropic') {
    return explicit;
  }
  if (explicit) {
    console.warn(`[LLM] 无法识别的 LLM_PROVIDER=${explicit}，将按凭据自动判断`);
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return 'deepseek';
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return 'anthropic';
  }
  // 两者都没有时默认 deepseek：本项目当前的既定方向，便于尽早暴露配置缺失
  return 'deepseek';
}

/**
 * 解析真正发给厂商的模型名
 *
 * 存在的关键原因：调用点里写死的 `claude-sonnet-4-6` 原样发给 DeepSeek 会
 * 直接 400。这里做一次归一化，让「换厂商」不必同时改所有调用点。
 */
export function resolveModel(provider: LlmProvider, requested?: string): string {
  const configured = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL;
  if (configured) {
    return configured;
  }
  if (provider === 'anthropic') {
    return requested || DEFAULT_ANTHROPIC_MODEL;
  }
  // DeepSeek：Claude 风格的名字一律换成 DeepSeek 默认模型，其余（如显式传入的
  // deepseek-v4-pro）原样保留，保留上层按场景切换模型的自由度。
  if (requested && !CLAUDE_MODEL_PATTERN.test(requested)) {
    return requested;
  }
  return DEFAULT_DEEPSEEK_MODEL;
}

/**
 * DeepSeek 客户端（OpenAI 兼容协议）
 *
 * 通过 openai 包把 Chat Completions 的出入参翻译成 Anthropic 形状，
 * 使上层调用点无需感知厂商差异。
 */
class DeepSeekLlmClient implements LlmClient {
  readonly provider: LlmProvider = 'deepseek';
  readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.defaultModel = resolveModel('deepseek');
    this.apiKey = apiKey;
    this.client = new OpenAI({
      apiKey: apiKey || 'missing',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    });
  }

  readonly messages = {
    create: async (params: LlmMessageParams): Promise<LlmMessageResponse> => {
      // 密钥校验放在调用时而非构造时：构造发生在模块导入阶段，一旦构造即抛错，
      // 会让「只是 import 了本模块」的脚本（校验脚本、迁移脚本）整体崩溃。
      if (!this.apiKey) {
        throw new Error('缺少 DEEPSEEK_API_KEY：请在 .env.production 中配置 DeepSeek 密钥');
      }

      const model = resolveModel(this.provider, params.model);

      // system 在 Anthropic 里是顶层字段，在 OpenAI 兼容协议里是首条消息
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (params.system) {
        messages.push({ role: 'system', content: params.system });
      }
      for (const m of params.messages) {
        messages.push({ role: m.role, content: m.content });
      }

      try {
        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: params.max_tokens,
          temperature: params.temperature,
        });
        const text = completion.choices?.[0]?.message?.content ?? '';
        return { content: [{ type: 'text', text }], model: completion.model };
      } catch (error) {
        // 带上模型名和展开后的错误：空的 AggregateError message 曾让线上排查寸步难行
        throw new Error(`DeepSeek 调用失败 (model=${model}): ${describeError(error)}`);
      }
    },
  };
}

/**
 * Anthropic 客户端
 *
 * 保留原有实现，只是包装成统一接口，以便随时用 LLM_PROVIDER=anthropic 回滚。
 */
class AnthropicLlmClient implements LlmClient {
  readonly provider: LlmProvider = 'anthropic';
  readonly defaultModel: string;
  private readonly client: Anthropic;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.defaultModel = resolveModel('anthropic');
    this.apiKey = apiKey;
    this.client = new Anthropic({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  readonly messages = {
    create: async (params: LlmMessageParams): Promise<LlmMessageResponse> => {
      // 与 DeepSeek 侧同理：构造期不抛错，避免 import 即崩溃
      if (!this.apiKey) {
        throw new Error(
          '缺少 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY：请配置 Anthropic 凭据，或改用 LLM_PROVIDER=deepseek'
        );
      }

      const model = resolveModel(this.provider, params.model);

      try {
        const message = await this.client.messages.create({
          model,
          max_tokens: params.max_tokens,
          temperature: params.temperature,
          system: params.system,
          messages: params.messages,
        });
        return {
          content: message.content.map((block) => ({
            type: block.type,
            text: 'text' in block ? block.text : undefined,
          })),
          model: message.model,
        };
      } catch (error) {
        throw new Error(`Anthropic 调用失败 (model=${model}): ${describeError(error)}`);
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
function getApiKey(provider: LlmProvider): string {
  if (provider === 'deepseek') {
    return process.env.DEEPSEEK_API_KEY || '';
  }
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
}

/** 当前厂商的凭据是否已配置（供启动日志与校验脚本使用） */
export function hasApiKey(provider: LlmProvider = resolveProvider()): boolean {
  return Boolean(getApiKey(provider));
}

/**
 * 按当前配置构造客户端（每次调用都会新建，仅测试或需要独立实例时使用）
 */
export function createLlmClient(provider: LlmProvider = resolveProvider()): LlmClient {
  const apiKey = getApiKey(provider);
  return provider === 'deepseek'
    ? new DeepSeekLlmClient(apiKey)
    : new AnthropicLlmClient(apiKey);
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
  const provider = resolveProvider();
  const baseURL =
    provider === 'deepseek'
      ? process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
      : process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  let host = baseURL;
  try {
    host = new URL(baseURL).host;
  } catch {
    // baseURL 非法时原样展示，便于发现配置错误
  }
  const keyState = hasApiKey(provider) ? '已配置' : '缺失';
  return `provider=${provider} model=${resolveModel(provider)} baseURL=${host} apiKey=${keyState}`;
}
