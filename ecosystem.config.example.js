// PM2 生态配置示例。
//
// 用法：复制为 ecosystem.config.js 后填入真实值（该文件已被 .gitignore 忽略）。
//   cp ecosystem.config.example.js ecosystem.config.js
//
// ⚠️ 这是**线上真正的配置来源**：pm2 读的是本文件的 env_production，
//    而不是根目录的 .env.production（后者只对「手动执行的脚本」生效，
//    且两者的嵌入模型/Dimensions 取值不同，别混用）。
//
// ⚠️ 取线上实际生效的环境变量（排查配置漂移时最可靠的一招）：
//   tr '\0' '\n' < /proc/$(pm2 pid codelens-api | tail -1)/environ
module.exports = {
  apps: [
    {
      name: 'codelens-api',
      script: './apps/api/dist/index.js',
      cwd: '/root/CodeLens',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=2560',
      env_production: {
        NODE_ENV: 'production',
        PORT: 8787,

        // ============================================================
        // LLM：本项目只用 DeepSeek（llm/client.ts 经 LangChain ChatOpenAI 适配）
        //   LLM_PROVIDER / ANTHROPIC_* 已从代码中移除，设了也不会生效。
        // ============================================================
        LLM_MODEL: 'deepseek-chat',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_API_KEY: '<your-deepseek-api-key>',

        // ⚠️ 向量嵌入与 LLM 无关（DeepSeek 不提供嵌入模型），不要改 Base URL。
        //    原生维度是 1024，靠 EMBED_DIMENSIONS=1536 指定为 1536，
        //    才能与库里既有的 vector(1536) 列兼容。**改这个值会与现有向量不兼容。**
        EMBED_API_KEY: '<your-dashscope-api-key>',
        EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        EMBED_MODEL: '<your-embedding-model>',
        EMBED_DIMENSIONS: '1536',
        DASHSCOPE_API_KEY: '<your-dashscope-api-key>',

        // rerank 精排：检索链路的第二阶段（宽召回 → 模型语义重排 → 截断）。
        // ⚠️ 模型名不可用 / 超时 / 配额不足时自动降级回规则排序并进入 60s 冷却，
        //    检索不会因为 rerank 挂掉而失败。
        RERANK_ENABLED: 'true',
        RERANK_MODEL: '<your-rerank-model>',
        RERANK_API_KEY: '<your-dashscope-api-key>',
        RERANK_BASE_URL: 'https://dashscope.aliyuncs.com',
        RERANK_CANDIDATES: '50',
        RERANK_TIMEOUT_MS: '3000',
        DASHSCOPE_RERANK_MODEL: '<your-rerank-model>',

        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_NAME: 'codelens',
        DB_USER: 'postgres',
        DB_PASSWORD: '<your-db-password>',
        REDIS_HOST: 'localhost',
        REDIS_PORT: '6379',
      },
      error_file: '/var/log/codelens-api-error.log',
      out_file: '/var/log/codelens-api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '2560M',
    },
    {
      name: 'codelens-web',
      script: 'npx',
      args: 'serve -s dist -p 5173',
      cwd: '/root/CodeLens/apps/web',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/codelens-web-error.log',
      out_file: '/var/log/codelens-web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
