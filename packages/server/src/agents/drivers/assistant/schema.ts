// Genet 与空间 AI 的表 + 一条存量修正（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// assistants：每个用户的 Genet 页。page_id 指向的页进了回收站就当没有（读路径按 live_pages 判），下次唤起另建一页再改写这一行；
//   页面物理删除置空。删号级联。
// assistant_sessions：Genet 会话的消息历史（中性格式，见 drivers/assistant/model.ts 的 AssistantMessage）。每一轮结束（含停止 / 出错）
//   整份写一次；loadSession 从这里读回来。里面有工具结果（页面内容的片段），删号级联删除。不存模型 key、不存图片字节。
// assistant_tasks：Genet 派出去的任务（agents/task-watch.ts）。派出去的那一轮结束时回报一次：reported_at 落值 = 已回报 / 结果已交给
//   wait_task / 被手动停止而作废，之后同一页上的轮次不再回报。label = 派活时 agent 的显示名（通知里用）。任务页、Genet 页物理删除或删号级联。
// 中间的 UPDATE：Genet 页不进页面树（新建时就写 false，见 assistant-agent.ts 的 ensureAssistantPage），这条把早先建在树里的收编过来；
//   每次启动重跑，已经是 false 的行不再命中。回收站里的也一并改：恢复出来的仍是 Genet 页，同样不该进树。
//
// 空间 AI（agents/space-ai.ts）复用同一个驱动，追加在串尾：
// assistant_sessions.space_id：空间 AI 的会话属于空间（同空间的成员接着同一段对话），这时 user_id 为空；Genet 的会话 space_id 为空。
//   空间删掉连会话一起删（里面有那个空间的页面片段）。
// space_ai：团队空间的 AI 配置。connection_id 是空间 owner 自己的模型连接（owner 删了连接就置空 = 停用）；
//   连接属不属于此刻的 owner 在读的时候判（spaces.owner_id 会因删号转交而变），这里不约束。
export const ASSISTANT_DDL = `
CREATE TABLE IF NOT EXISTS assistants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user ON assistant_sessions(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_tasks (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  home_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_at TIMESTAMPTZ
);
UPDATE pages SET in_page_tree = false
  WHERE in_page_tree AND id IN (SELECT page_id FROM assistants WHERE page_id IS NOT NULL);
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE;
ALTER TABLE assistant_sessions ALTER COLUMN user_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_space ON assistant_sessions(space_id, updated_at DESC) WHERE space_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS space_ai (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES user_ai_connections(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'AI',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`
