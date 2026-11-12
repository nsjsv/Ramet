// AI 使用量流水的表（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// ai_usage：每次花了模型连接（API key）的调用记一行（ai-usage.ts 的 recordUsage 是唯一写入口）：Genet / 空间 AI 一轮、⌘J 一次、
//   AI 块 / AI 属性生成一次。机器上的 agent 与 ⌘J 本地通道花的是各人自己的 CLI 订阅，不记。不记正文，只有 token 与请求次数。
//   payer_id = 花的是谁的连接（空间 AI 记在空间 owner 名下）；actor_id = 谁叫的（空间 AI 按成员分），不挂外键：删号不改写流水；
//   space_id = 空间 AI 的那个空间（别的来源为空），删空间置空；requests = 这一行里问了模型几次（Genet / 空间 AI 一轮可能多次）。
export const AI_USAGE_DDL = `
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT,
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('genet', 'space_ai', 'quick', 'ai_gen', 'ai_prop')),
  model TEXT NOT NULL,
  requests INT NOT NULL DEFAULT 1,
  input BIGINT NOT NULL DEFAULT 0,
  output BIGINT NOT NULL DEFAULT 0,
  cache_read BIGINT NOT NULL DEFAULT 0,
  cache_write BIGINT NOT NULL DEFAULT 0,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_payer ON ai_usage(payer_id, at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_space ON ai_usage(space_id, at) WHERE space_id IS NOT NULL;
`
