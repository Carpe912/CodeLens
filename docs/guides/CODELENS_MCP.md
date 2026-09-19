# CodeLens MCP Server

把 CodeLens 的「接口清单 / 问答」能力以 MCP 工具形式暴露给任意 MCP 客户端
（Claude Desktop、Cursor、以及支持 MCP 的 Agent 框架）。

## 它解决什么问题

「**列出这个仓库的所有接口**」这类问题，在 MCP 客户端里同样会翻车：
客户端自己去搜代码，拿到的还是 **top-K**（最相似的几条），不是全集。

这个 server 把问题路由到**结构化查询**（`GET /repos/:id/url-patterns`，
直接读 `url_patterns` 表），返回的就是全集。工具描述里也明确写了
「条数即全集，不是 top-K」，避免客户端自己退回去做检索。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `list_repos` | 列出已索引的仓库（拿 `repoId`） |
| `list_url_patterns` | **列出某仓库的全部 HTTP 接口**（支持 `method` / `q` 过滤，返回全集） |
| `ask_codelens` | 检索式问答（基于代码证据）。**不适合**「列出所有…」这类问题 |

## 配置

先构建：

```bash
cd apps/api
npm run build
```

然后在 MCP 客户端里加一段配置（以 Claude Desktop 的 `claude_desktop_config.json` 为例）：

```json
{
  "mcpServers": {
    "codelens": {
      "command": "node",
      "args": ["/绝对路径/CodeLens/apps/api/dist/mcp/codelens-mcp.js"],
      "env": {
        "CODELENS_API_URL": "https://sunlingyue.cn/code-api"
      }
    }
  }
}
```

可用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODELENS_API_URL` | `https://sunlingyue.cn/code-api` | CodeLens API 地址。走 HTTP 直连服务器 IP 时用 `http://47.116.6.132/code-api` |
| `CODELENS_MCP_TIMEOUT_MS` | `120000` | 单次 API 调用超时 |

> **为什么走 HTTP API 而不是直连数据库**：Postgres 只在服务器本机监听
> （`127.0.0.1:5432`），而 API 已经由 nginx 暴露在 `/code-api/`。
> 走 API 还顺带复用了 server 侧已经做好的「helper 展开 + 去重」逻辑，
> 避免客户端和 server 两套实现各算各的、慢慢漂移。

## 自检

```bash
cd apps/api
CODELENS_API_URL=http://47.116.6.132/code-api npm run check:mcp
```

这个脚本把 server 当**真实 MCP 客户端**驱动一遍：
`initialize` → `tools/list` → 逐个 `tools/call`，并断言

- 协议版本 / `serverInfo` 回填正确
- 三个工具都在，`inputSchema` 正确
- **清单完整性**：正文里实际列出的行数 == 声明的总数（防截断）
- `method` 过滤真的生效（过滤结果 ≤ 全量）
- 未知工具返回 `-32602`、未知方法返回 `-32601`
- **stdout 洁净**：协议通道里没有混进调试输出（MCP 最常见的翻车方式）
- 排序：可判定 method 的接口排在前，未判定的诊断行排最后

## 实现说明

- **零依赖**：MCP 的 stdio 传输就是「换行分隔的 JSON-RPC 2.0」，
  handler 只有 `initialize` / `tools/list` / `tools/call` 三个，
  自己实现约 120 行即可，不需要 `@modelcontextprotocol/sdk`，
  也就没有版本漂移和安装步骤。
- **stdout 是协议通道**：所有日志必须走 stderr，否则会污染 JSON-RPC。

## 相关

- 接口清单的还原逻辑（helper 作用域展开、去重）：`src/analysis/url-inventory.ts`
- 与 `/ask` 的关系：`/ask` 在识别到「列全集」类问题时会走同一条结构化查询路径，
  返回里带 `structured: true` 和 `inventory` 汇总。
