# CodeLens 升级说明

## 🎉 重大更新

CodeLens 已完成两项重大升级：

1. **AgentRAG 架构** - 从 GraphRAG 升级到 AgentRAG
2. **阿里百炼 API** - 从 XiaocaseAI 切换到阿里百炼

---

## 📊 升级内容

### AgentRAG 核心能力
- ✅ 多轮推理（最多5轮）
- ✅ 任务分解和规划
- ✅ 自我反思和调整
- ✅ 对话记忆管理
- ✅ 6种工具调用
- ✅ 流式响应支持

### API 变更
- ✅ 向量维度: 1024 → 1536
- ✅ Rerank 模型: bge-reranker-v2-m3 → qwen3-rerank
- ✅ 新增 7 个 Agent API 端点

---

## 🚀 快速部署

```bash
# 服务器端执行
cd /root/CodeLens
git pull origin main
cd apps/api
bash migrate-to-dashscope.sh
```

详见: [QUICKSTART.md](QUICKSTART.md)

---

## 📚 文档导航

| 文档 | 说明 |
|------|------|
| [QUICKSTART.md](QUICKSTART.md) | 快速开始指南 |
| [UPGRADE_COMPLETE.md](UPGRADE_COMPLETE.md) | 升级完成总结 |
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | 详细部署指南 |
| [AGENT_UPGRADE_SUMMARY.md](AGENT_UPGRADE_SUMMARY.md) | AgentRAG 功能说明 |
| [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md) | 迁移步骤详解 |

---

## ⚠️ 重要提醒

**向量维度变化，必须重新索引所有仓库！**

```bash
curl -X POST http://your-server:8787/repos/1/reindex
```

---

**升级日期**: 2026年5月6日  
**状态**: ✅ 本地配置完成，待服务器部署
