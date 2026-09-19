# 服务器验证报告

> 🗓️ **历史快照（2026-05-13）**：本文记录的是**当时**的服务器状态，其中的模型名
> （如 `text-embedding-v4`）与路径反映的是排查当时的实际情况，**不代表当前配置**。
> 当前技术栈与配置以 `ecosystem.config.js` + `docs/deployment/SERVER_RUNBOOK.md` 为准：
> LLM = DeepSeek `deepseek-chat`、Embedding = `qwen3.7-text-embedding`（1536 维）、
> Rerank = `qwen3.7-text-rerank`。

## 验证时间
2026-05-13

## 服务器信息
- 地址: 47.116.6.132
- 项目路径: /root/CodeLens

## 验证结果

### ✅ 数据库实际状态（已经是 1536 维）

| 表名 | 总行数 | 有向量的行数 | 实际维度 |
|------|--------|-------------|---------|
| code_chunks | 257 | 257 | **1536** ✅ |
| string_constants | 760 | 152 | **1536** ✅ |
| functions | 103 | 103 | **1536** ✅ |
| classes | 10 | 10 | **1536** ✅ |
| url_patterns | 65 | 0 | - |

**结论**: 数据库中所有表的向量都是 1536 维，与环境变量配置一致。

### ⚠️ 代码定义（仍然是 1024 维）

服务器上的代码文件 `/root/CodeLens/apps/api/dist/db/index.js:120` 中：
```javascript
embedding vector(1024),  // ❌ 代码中定义的是 1024
```

但数据库实际已经是 1536 维。

### ✅ 环境变量配置

```javascript
EMBED_MODEL: 'text-embedding-v4'
EMBED_DIMENSIONS: '1536'
```

## 问题分析

### 为什么线上可以正常运行？

**答案**: 数据库已经手动迁移过了！

1. **数据库实际状态**: 所有表都是 1536 维
2. **环境变量配置**: 1536 维
3. **实际生成的向量**: 1536 维
4. **代码中的定义**: 1024 维（但这只在建表时使用，表已经存在）

因为数据库表已经创建并且是 1536 维，代码中的 `CREATE TABLE IF NOT EXISTS` 不会重新执行，所以不会有问题。

### 潜在风险

如果：
- 删除数据库重新初始化
- 在新环境部署
- 执行 DROP TABLE 后重建

那么会按照代码中的 1024 维创建表，导致与环境变量（1536 维）不匹配。

## 建议操作

### 1. 更新服务器代码（推荐）

将修复后的代码部署到服务器，保持代码与实际数据库一致：

```bash
# 在本地
cd /Users/coopwire-test/remote-project/CodeLens
git add .
git commit -m "fix: 统一向量维度为 1536"
git push

# 或者直接上传编译后的文件
scp apps/api/dist/db/index.js root@47.116.6.132:/root/CodeLens/apps/api/dist/db/
scp apps/api/dist/index.js root@47.116.6.132:/root/CodeLens/apps/api/dist/

# 重启服务
ssh root@47.116.6.132 "pm2 restart codelens-api"
```

### 2. 验证更新后的代码

```bash
ssh root@47.116.6.132 "grep -n 'embedding vector' /root/CodeLens/apps/api/dist/db/index.js | head -1"
# 应该显示: embedding vector(1536)
```

## 总结

✅ **无需迁移数据库** - 数据库已经是正确的 1536 维
✅ **服务可以正常运行** - 环境变量和数据库都是 1536 维
⚠️ **需要更新代码** - 将代码定义从 1024 改为 1536，避免未来重建表时出问题

## 数据统计

- **code_chunks**: 257 个代码块，全部有向量
- **string_constants**: 760 个字符串常量，152 个有向量
- **functions**: 103 个函数，全部有向量
- **classes**: 10 个类，全部有向量
- **url_patterns**: 65 个 URL 模式，0 个有向量

数据库运行良好，向量索引正常工作。
