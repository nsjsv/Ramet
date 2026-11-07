// 页面评论的表（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// 评论是页面的附属数据，不进 Y.Doc：viewer 对文档只读却要能评论，锚点写进文档（PM mark）还会污染版本历史与 markdown 往返。
// comment_threads：kind = inline（划词评论，anchor 是前端算的相对位置 + 文字兜底，服务端只存不解析）/ page（整页讨论）。
//   物理删页级联；删号置 NULL（显示「已注销用户」，不让署名挡住删号）
// comments：body 是记号文字口径（@[名字](user:<id>)）；mentions 是服务端从 body 解析、过滤成本空间成员后的 id，收件箱按它判 @我。
//   deleted_at = 首条被删但串里还有回复时留的占位；串里没有活评论了整串物理删除
// comment_reads：我读到这个串的哪一刻，收件箱「新」的判定；删号 / 删串级联
// comments.via：'genet' = Genet 以作者的名义代发（作者在审批卡上点了「发送」，或作者在串里叫了它）；界面上标「Genet 代发」，空 = 本人写的
// comment_genet_calls：评论里 @Genet 的一次呼叫（comments/genet-call.ts），一条评论最多一次。
//   state：waiting（通知写进了 Genet 页、等它处理）/ answered（它回在了串里）/ done（那一轮结束了但没回在这里）/ failed（reason）；
//   home_id = 通知写进的 Genet 页（没写成 = NULL）；created_at 用服务进程的时钟写，与一轮的开始时刻比（谁先谁后决定那一轮管不管它）
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
ALTER TABLE comments ADD COLUMN IF NOT EXISTS via TEXT;
CREATE TABLE IF NOT EXISTS comment_genet_calls (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'answered', 'done', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_genet_calls_waiting ON comment_genet_calls(home_id, created_at) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS idx_genet_calls_thread ON comment_genet_calls(thread_id, user_id) WHERE state = 'waiting';
`

// 评论开关(两种评论各一个):inline_comments = 划词评论,默认开;page_comments = 正文下方的整页讨论,默认关。
// 关掉的那种不显示、不收新评论,已有的串保留,重新打开即恢复。
// 存量库里的 allow_comments 列就是划词评论开关,改名过去(已有 inline_comments 就直接丢掉它);
// 视图按列位置绑定着旧列名,动列前先拆掉;变更日志触发器的 WHEN 也引用着它,丢列前同样先拆(两者 db.ts 随后都会重建)
// 由 db.ts 拼在 pages 加列段、live_pages 视图重建之前（视图的列集合在创建时固定）
export const COMMENT_SWITCHES_DDL = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'allow_comments') THEN
    DROP VIEW IF EXISTS live_pages;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'inline_comments') THEN
      DROP TRIGGER IF EXISTS page_changes_upd ON pages;
      ALTER TABLE pages DROP COLUMN allow_comments;
    ELSE
      ALTER TABLE pages RENAME COLUMN allow_comments TO inline_comments;
    END IF;
  END IF;
END $$;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS inline_comments BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_comments BOOLEAN NOT NULL DEFAULT false;
`
