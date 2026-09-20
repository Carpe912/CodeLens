# CodeLens 长期笔记

> 部署→skill `codelens-deploy`；评测→skill `codelens-retrieval-eval`；细节→`TECHNICAL-NOTES.md`。

## 铁律

1. **源码改了 ≠ 线上在跑**：判据 = 线上 dist grep 新标识符；只 scp **不重启**⇒ 不生效；
   `migrations/` 不在 dist，要单独带。
2. **最危险 = 静默空转/少做**：`reindex` 0/0+ready、`reembed` 静默留 NULL、`0 chunk ⇒ continue`。
   **计数 == 0 必须显式失败。**
3. 重启：`pm2 restart codelens-api --update-env`（`--only` 可能没真重启），核对 uptime 归零 + `/health` 200。
4. `reindex` 只按 `files` 已登记路径重解析 ⇒ 目录结构一变它就是错的工具（删仓重建或**续跑**）。
5. **失败先续跑别重建**：`POST /repos/:id/resume`（migration 006）；代价 ∝ 剩余量。

## 环境

- **线上配置唯一来源 = `ecosystem.config.js::env_production`**；`.env` 只对手工脚本生效且**值不同**
  ⇒ **别手跑 `reembed.js`**。
- **pm2 把 `console.warn/error` 分流到 `-error.log`** ⇒ out 日志 grep 警告恒空。
- 前端线上 = **nginx `/code/`→alias `/www/wwwroot/codelens-web/`**；API 公开在 **`/code-api/`**。
  本机 https 被拦 → 直连 `http://47.116.6.132/code-api`。
- **curl 通 ≠ 无头 Chrome 通**：headless Chrome 只能走 loopback，fetch 公网 IP 报
  `Failed to fetch`（页面渲染但「统计不可用」）⇒ 浏览器验证**必须走 SSH 隧道**。

## 数据口径（反直觉）

1. `code_chunks.repo_id` **全 NULL** ⇒ 归属一律 JOIN `files.repo_id`（否则恒 0）。
2. `code_chunks.id` 与 `functions`/`string_constants` 的 id 是**两套空间** ⇒ evidence `id` ≠ 主键。
3. call_graph 入边**按 `to_symbol` 分组**反查（按 chunk_id ⇒ 恒 0 caller）；伪自环**勿全砍**（误杀真递归），
   判据见 `TECHNICAL-NOTES.md` §。
4. `url_patterns` **一行 ≠ 一个接口**：原始 **283** → 去重 **277** → 真实接口 **238**，
   加 16 个 method 未判定但路径确认是接口 ⇒ **可调用 254**；余 23 行不是接口（前端路由/
   vite 产物/文案/CDN），由 `classifyUndecidedRow()` 判 —— **规则只此一份**，前端只展示。
   **「列出全部 N」检索无解**（top-K 不完备）⇒ 结构化查询：`GET /repos/:id/url-patterns`、
   `/ask` 枚举（`structured:true`）、MCP `dist/mcp/codelens-mcp.js`。`/stats` 的 `urlPatterns`
   是裸行数，接口数用 `interfacesCallable`。
   ⚠️ helper 展开**必须按「定义所在文件」判作用域**（`scope` 14 文件同名不同义，全局先到先得
   会给出**错但很像真的**路径）。
   ✅ 清单完整性用**双实现集合差**验（硬编码 vs 数据驱动，归一化占位符后差集须 0）。

## 边界

- 索引器只认 **TS/JS/TSX/JSX 与 `.vue`**（Java/Python/Go 不入库）。
- 线上仓：29 `test-repo`（**勿动**）、30 `fastify`、33 `testwire-frontend`（**仅 33 重建过**）。
- 判命中不能按符号名判（关联命中 `symbol_name` 恒空）；BSD grep 的 `\|` 是字面量 → `-E`。
