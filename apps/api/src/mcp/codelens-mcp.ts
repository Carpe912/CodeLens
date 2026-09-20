#!/usr/bin/env node
/**
 * CodeLens MCP Server（stdio）
 *
 * ============================================================
 * 它解决什么问题
 * ============================================================
 * 「列出这个仓库的所有接口」在 MCP 客户端（Claude Desktop / Cursor / 任意 Agent）
 * 里同样是**集合类问题**：如果客户端自己去检索代码，得到的还是 top-K。
 *
 * 本 server 把这些能力以**工具**形式暴露出去，工具内部走
 * `GET /repos/:id/url-patterns` —— 结构化查询，返回全集，不是 top-K。
 *
 * ============================================================
 * 两个刻意的设计选择
 * ============================================================
 * 1. **不依赖 `@modelcontextprotocol/sdk`。**
 *    MCP 的 stdio 传输就是「换行分隔的 JSON-RPC 2.0」，handler 只有
 *    initialize / tools/list / tools/call 三个。自己实现 ~120 行，
 *    换来的是零依赖、零版本漂移、零安装步骤。
 *
 * 2. **数据源是 HTTP API，不是直连数据库。**
 *    数据库只在服务器本机监听（127.0.0.1:5432），而 API 已由 nginx
 *    暴露在 `/code-api/`。走 API 还顺带复用了 server 侧已经做好的
 *    「helper 展开 + 去重」逻辑，避免两套实现漂移。
 *
 * 用法（Claude Desktop / Cursor 的 MCP 配置）：
 *   {
 *     "mcpServers": {
 *       "codelens": {
 *         "command": "node",
 *         "args": ["/abs/path/to/CodeLens/apps/api/dist/mcp/codelens-mcp.js"],
 *         "env": { "CODELENS_API_URL": "https://sunlingyue.cn/code-api" }
 *       }
 *     }
 *   }
 *
 * ⚠️ stdout 属于协议通道：任何调试输出都必须走 stderr，否则会破坏 JSON-RPC。
 */

import { createInterface } from 'node:readline';

const API_URL = (process.env.CODELENS_API_URL ?? 'https://sunlingyue.cn/code-api').replace(/\/+$/, '');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'codelens';
const SERVER_VERSION = '1.0.0';
const REQUEST_TIMEOUT_MS = Number(process.env.CODELENS_MCP_TIMEOUT_MS ?? 120_000);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// ---------------------------------------------------------------------------
// HTTP 调用
// ---------------------------------------------------------------------------

async function callApi(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`CodeLens API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function asNumber(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`参数 ${field} 必须是数字，收到：${JSON.stringify(value)}`);
  return n;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

interface UrlPatternRow {
  method: string | null;
  pattern: string;
  normalizedPattern: string;
  realPath: string | null;
  definitionFile: string | null;
  definitionLine: number | null;
  usageCount: number;
}

/** 把结构化清单渲染成稳定的文本：**不做任何截断**，条数即全集 */
function renderRows(rows: UrlPatternRow[]): string {
  return rows
    .map((r) => {
      const method = (r.method ?? '(未判定)').padEnd(8);
      const path = r.realPath ?? `${r.pattern}  [未能展开：依赖运行时变量]`;
      const loc = r.definitionFile ? `  @${r.definitionFile}:${r.definitionLine ?? 0}` : '';
      return `${method} ${path}${loc}`;
    })
    .join('\n');
}

const tools: ToolDef[] = [
  {
    name: 'list_repos',
    description: '列出 CodeLens 里已索引的所有代码仓库（含 id、名称、状态）。调用其它工具前先用它拿 repoId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const repos = (await callApi('/repos')) as Array<Record<string, unknown>>;
      if (!Array.isArray(repos) || repos.length === 0) return '（没有任何仓库）';
      const lines = repos.map(
        (r) => `#${r.id}  ${r.name}  status=${r.status ?? '?'}  files=${r.file_count ?? '-'}`
      );
      return `共 ${repos.length} 个仓库：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'list_url_patterns',
    description:
      '列出某个仓库的全部 HTTP 接口（**全集，不是最相似的几条**）。' +
      '数据来自结构化查询（url_patterns 表），并把源码里的 URL 前缀 helper 展开成真实路径。' +
      '当用户要求「列出所有接口 / 有哪些 POST 接口 / 接口清单」时用这个工具，不要用代码检索。',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'number', description: '仓库 id（先用 list_repos 获取）' },
        method: {
          type: 'string',
          description: '可选，只看某个 HTTP method：GET / POST / PUT / DELETE / PATCH',
        },
        q: { type: 'string', description: '可选，路径关键词过滤，例如 /rest/quality' },
      },
      required: ['repoId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const repoId = asNumber(args.repoId, 'repoId');
      const params = new URLSearchParams();
      if (typeof args.method === 'string' && args.method) params.set('method', args.method);
      if (typeof args.q === 'string' && args.q) params.set('q', args.q);
      const qs = params.toString();

      const data = (await callApi(`/repos/${repoId}/url-patterns${qs ? `?${qs}` : ''}`)) as {
        total: number;
        distinctInterfaces: number;
        byMethod: Record<string, number>;
        rows: UrlPatternRow[];
      };

      const byMethod = Object.entries(data.byMethod)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ');

      if (!data.rows || data.rows.length === 0) {
        return `仓库 #${repoId} 在当前过滤条件下没有接口记录（原始行 ${data.total} 条）。`;
      }

      return [
        `仓库 #${repoId} 共 ${data.rows.length} 个接口（原始 url_patterns 行 ${data.total} 条，去重后真实接口 ${data.distinctInterfaces} 个）。`,
        `按 method 分布：${byMethod}`,
        '',
        '本清单来自结构化查询，**条数即全集**，不是 top-K 检索结果。',
        '',
        renderRows(data.rows),
      ].join('\n');
    },
  },
  {
    name: 'ask_codelens',
    description:
      '向 CodeLens 提问代码问题（检索式问答，返回基于代码证据的回答）。' +
      '⚠️ 不适合「列出所有…」这类要求全集的问题 —— 那种情况请用 list_url_patterns。',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'number', description: '仓库 id' },
        query: { type: 'string', description: '自然语言问题，例如「登录功能是怎么实现的」' },
      },
      required: ['repoId', 'query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const repoId = asNumber(args.repoId, 'repoId');
      const query = String(args.query ?? '');
      if (!query) throw new Error('参数 query 不能为空');

      const res = (await callApi('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, query }),
      })) as { answer?: string; structured?: boolean; inventory?: { byMethod?: Record<string, number> } };

      const parts = [res.answer ?? '（无回答）'];
      if (res.inventory?.byMethod) {
        parts.push(
          '',
          `[结构化] byMethod=${JSON.stringify(res.inventory.byMethod)}`
        );
      }
      return parts.join('\n');
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC 主循环
// ---------------------------------------------------------------------------

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id: JsonRpcResponse['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcResponse['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(...args: unknown[]): void {
  // 必须走 stderr：stdout 是协议通道
  process.stderr.write(`[codelens-mcp] ${args.map(String).join(' ')}\n`);
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知不需要回复

    case 'ping':
      sendResult(id, {});
      return;

    case 'tools/list':
      sendResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;

    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = toolMap.get(name);
      if (!tool) {
        sendError(id, -32602, `未知工具：${name}`);
        return;
      }
      try {
        const text = await tool.handler(args);
        sendResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`tool ${name} failed:`, message);
        sendResult(id, { content: [{ type: 'text', text: `调用失败：${message}` }], isError: true });
      }
      return;
    }

    default:
      sendError(id, -32601, `不支持的方法：${req.method}`);
  }
}

export function startServer(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  log(`started · API=${API_URL} · ${tools.length} tools`);

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      sendError(null, -32700, 'JSON 解析失败');
      return;
    }
    void handle(req).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('unhandled:', message);
      sendError(req.id ?? null, -32603, message);
    });
  });

  rl.on('close', () => process.exit(0));
}

startServer();
