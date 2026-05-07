-- Agent 相关数据库表迁移
-- 用于存储 Agent 执行历史、学习记录和对话记忆

-- 1. Agent 对话表（简化版）
CREATE TABLE IF NOT EXISTS agent_conversations (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  response JSONB,
  execution_time_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_session ON agent_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_repo ON agent_conversations(repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_created ON agent_conversations(created_at DESC);

-- 2. Agent 执行历史表
CREATE TABLE IF NOT EXISTS agent_executions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100),
  repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  task_type VARCHAR(50),
  plan JSONB,
  steps JSONB,
  result JSONB,
  success BOOLEAN DEFAULT false,
  confidence FLOAT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_executions_session ON agent_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_executions_repo ON agent_executions(repo_id);
CREATE INDEX IF NOT EXISTS idx_agent_executions_created ON agent_executions(created_at DESC);

-- 2. Agent 学习记录表
CREATE TABLE IF NOT EXISTS agent_lessons (
  id SERIAL PRIMARY KEY,
  task_type VARCHAR(50) NOT NULL,
  failure_reason TEXT,
  solution TEXT,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  success_rate FLOAT DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_lessons_task_type ON agent_lessons(task_type);
CREATE INDEX IF NOT EXISTS idx_agent_lessons_success_rate ON agent_lessons(success_rate DESC);

-- 3. 对话记忆表
CREATE TABLE IF NOT EXISTS conversation_memory (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  message_type VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_memory_session ON conversation_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_created ON conversation_memory(created_at DESC);

-- 4. 工具调用日志表
CREATE TABLE IF NOT EXISTS tool_calls (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER REFERENCES agent_executions(id) ON DELETE CASCADE,
  tool_name VARCHAR(50) NOT NULL,
  params JSONB,
  result JSONB,
  duration_ms INTEGER,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_execution ON tool_calls(execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at DESC);

-- 5. Agent 反思记录表
CREATE TABLE IF NOT EXISTS agent_reflections (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER REFERENCES agent_executions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  on_track BOOLEAN,
  confidence FLOAT,
  issues JSONB,
  suggestions JSONB,
  reasoning TEXT,
  needs_replan BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_reflections_execution ON agent_reflections(execution_id);

-- 6. 添加注释
COMMENT ON TABLE agent_executions IS 'Agent 任务执行历史记录';
COMMENT ON TABLE agent_lessons IS 'Agent 从失败中学习的经验记录';
COMMENT ON TABLE conversation_memory IS '对话记忆存储';
COMMENT ON TABLE tool_calls IS '工具调用日志';
COMMENT ON TABLE agent_reflections IS 'Agent 自我反思记录';

-- 7. 创建视图：Agent 性能统计
CREATE OR REPLACE VIEW agent_performance_stats AS
SELECT
  task_type,
  COUNT(*) as total_executions,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful_executions,
  ROUND(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 2) as success_rate,
  ROUND(AVG(duration_ms), 0) as avg_duration_ms,
  ROUND(AVG(confidence), 2) as avg_confidence,
  MAX(created_at) as last_execution
FROM agent_executions
GROUP BY task_type;

COMMENT ON VIEW agent_performance_stats IS 'Agent 性能统计视图';

-- 8. 创建函数：清理旧的对话记忆（保留最近30天）
CREATE OR REPLACE FUNCTION cleanup_old_conversation_memory()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM conversation_memory
  WHERE created_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_conversation_memory IS '清理30天前的对话记忆';

-- 9. 创建函数：更新学习记录的成功率
CREATE OR REPLACE FUNCTION update_lesson_success_rate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.success_count + NEW.failure_count > 0 THEN
    NEW.success_rate := NEW.success_count::FLOAT / (NEW.success_count + NEW.failure_count);
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器
DROP TRIGGER IF EXISTS trigger_update_lesson_success_rate ON agent_lessons;
CREATE TRIGGER trigger_update_lesson_success_rate
  BEFORE UPDATE ON agent_lessons
  FOR EACH ROW
  EXECUTE FUNCTION update_lesson_success_rate();

COMMENT ON FUNCTION update_lesson_success_rate IS '自动更新学习记录的成功率';
