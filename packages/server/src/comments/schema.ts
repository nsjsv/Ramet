// 页面评论的表（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// 评论是页面的附属数据，不进 Y.Doc：viewer 对文档只读却要能评论，锚点写进文档（PM mark）还会污染版本历史与 markdown 往返。
// comment_threads：kind = inline（划词评论，anchor 是前端算的相对位置 + 文字兜底，服务端只存不解析）/ page（整页讨论）。
//   物理删页级联；删号置 NULL（显示「已注销用户」，不让署名挡住删号）
// comments：body 是记号文字口径（@[名字](user:<id>)）；mentions 是服务端从 body 解析、过滤成本空间成员后的 id，收件箱按它判 @我。
//   deleted_at = 首条被删但串里还有回复时留的占位；串里没有活评论了整串物理删除
// comment_reads：我读到这个串的哪一刻，收件箱「新」的判定；删号 / 删串级联
export const COMMENTS_DDL = `
CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inline', 'page')),
  anchor JSONB,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((kind = 'inline') = (anchor IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_comment_threads_page ON comment_threads(page_id, created_at);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  mentions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_mentions ON comments USING GIN (mentions);
CREATE TABLE IF NOT EXISTS comment_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);
`
