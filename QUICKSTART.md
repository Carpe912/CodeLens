# 🚀 快速开始 - 服务器部署

## 一键部署（推荐）

```bash
# 1. SSH 到服务器
ssh your-server

# 2. 进入项目目录
cd /root/CodeLens

# 3. 拉取最新代码
git pull origin main

# 4. 执行自动化迁移
cd apps/api
bash migrate-to-dashscope.sh
```

**完成！** 脚本会自动完成所有配置和迁移。

---

## 部署后验证

### 1. 检查服务状态
```bash
pm2 status
pm2 logs codelens-api --lines 20
```

### 2. 测试 Agent 功能
```bash
curl -X POST http://localhost:8787/agent/ask \
  -H "Content-Type: application/json" \
  -d '{"repoId": 1, "query": "登录功能是如何实现的？"}'
```

### 3. 重新索引仓库
```bash
# 获取所有仓库
curl http://localhost:8787/repos

# 重新索引（向量维度变化，必须执行）
curl -X POST http://localhost:8787/repos/1/reindex
curl -X POST http://localhost:8787/repos/2/reindex
```

---

## 📚 完整文档

- **[UPGRADE_COMPLETE.md](UPGRADE_COMPLETE.md)** - 升级完成总结
- **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** - 详细部署指南
- **[AGENT_UPGRADE_SUMMARY.md](AGENT_UPGRADE_SUMMARY.md)** - AgentRAG 功能说明
- **[MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)** - 迁移步骤详解

---

## ⚠️ 重要提醒

1. **向量维度变化**: 1024 → 1536，必须重新索引
2. **API 提供商**: XiaocaseAI → 阿里百炼
3. **新增功能**: 7个 Agent API 端点

---

## 🎯 新功能

### Agent 问答（多轮推理）
```bash
POST /agent/ask
{
  "repoId": 1,
  "query": "为什么用户无法上传头像？"
}
```

### 流式响应（实时查看思考过程）
```bash
POST /agent/ask-stream
{
  "repoId": 1,
  "query": "查找 /api/users 接口"
}
```

### 执行历史
```bash
GET /agent/history?repoId=1&limit=10
```

### 性能统计
```bash
GET /agent/stats
```

---

## 📞 遇到问题？

1. 查看日志: `pm2 logs codelens-api`
2. 检查数据库: `psql $DATABASE_URL -c "SELECT 1;"`
3. 验证 API Key: 测试阿里百炼 API
4. 查看文档: [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)

---

**预计部署时间**: 10-15 分钟  
**重新索引时间**: 5-30 分钟/仓库
