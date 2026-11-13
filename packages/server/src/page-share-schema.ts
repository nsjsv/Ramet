// ---------- 单页分享的表结构（拼进 db.ts 的 DDL） ----------
// 一行 = 这一页（连同子页）单独给了这个人：edit 可编辑 / view 只读。判定只在 page-visibility.ts，读写只在 routes/page-shares.ts。
// 分享即权限：对方不是空间成员就是访客。人被移出空间时他在这个空间收到的分享随成员行一起删（routes/spaces.ts），
// 否则「移除」只拿掉了区，被分享过的页他照样看得到。页面物理删除、删号随之消失；给的人删号只把 granted_by 置空（分享照旧有效）。
// spaces.members_invite_guests：成员能不能把页分享给空间外的人（owner 一直能）。

export const PAGE_SHARES_DDL = `
CREATE TABLE IF NOT EXISTS page_shares (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('edit', 'view')),
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_page_shares_user ON page_shares(user_id);
-- 分享给这个人的所有页：每个分享的根连同整棵子树（含回收站里的），带档位；同一页可能出现多行（祖先、子页各给了一次）。
-- 写成 plpgsql 而不是内联 SQL：规划器按 ROWS / COST 估它，不去估递归本身（递归的估算随全库页数线性涨，
-- 拼进页面列表那种大查询会把成本估到触发 JIT，白白多出几百毫秒）；按参数调用时整条查询只算一次，结果走哈希判定。
-- 判定只在 page-visibility.ts
CREATE OR REPLACE FUNCTION page_share_reach(uid TEXT) RETURNS TABLE (shared_id TEXT, shared_level TEXT)
  LANGUAGE plpgsql STABLE ROWS 50 AS $fn$
BEGIN
  RETURN QUERY WITH RECURSIVE dn(id, lv, n) AS (
      SELECT s.page_id, s.level, 0 FROM page_shares s WHERE s.user_id = uid
      UNION ALL SELECT c.id, dn.lv, dn.n + 1 FROM pages c JOIN dn ON c.parent_id = dn.id WHERE dn.n < 64
    )
    SELECT dn.id, dn.lv FROM dn;
END
$fn$;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS members_invite_guests BOOLEAN NOT NULL DEFAULT true;
`
