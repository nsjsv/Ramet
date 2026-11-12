// 浏览器推送的表（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// push_keys：这台服务器的 VAPID 密钥对，只有一行（id = 1），首次启动生成。私钥不出现在任何响应 / 日志里。
// push_subscriptions：每个浏览器订阅一行，按 endpoint 认（推送服务给的地址，同一个浏览器换号登录后归新的人）。
//   origin = 订阅时页面的源，用作 VAPID 的 sub（Apple 要求是 https 地址或 mailto）；
//   ok_at / failed_at / last_error = 最近一次推送的结局，设置页据此告诉用户推送通不通。
// push_sent：每个人通知过（或人在跟前、记下不发）的条目身份（inbox-notice.ts 的 noticeIdent），
//   收件箱里已经没有的身份由派发时清掉，表一直很小。
export const PUSH_DDL = `
CREATE TABLE IF NOT EXISTS push_keys (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS push_sent (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ident TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ident)
);
`
