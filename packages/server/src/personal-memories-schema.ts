// ---------- 个人记忆的表结构与一次性迁移（拼进 db.ts 的 DDL / MIGRATIONS；读写在 personal-memories.ts） ----------

export const PERSONAL_MEMORIES_DDL = `
-- 个人记忆：按人存、只有本人看得到、只给 Genet（personal-memories.ts）。删号随之消失；source_page_id 页面物理删后置空
CREATE TABLE IF NOT EXISTS user_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, created_at);
`

/** 只跑一次（标记表同 page-area-schema.ts 的 private_area_once）：注册时得到、只有主人一个成员的空间里的记忆，本来就是他一个人的偏好，
 *  迁成他的个人记忆（用原 id）。有别人的空间不动。以后在这种空间的公共页上 /记住 仍是空间记忆，重启不会再被搬走 */
export const PERSONAL_MEMORIES_MIGRATION = `
DO $$ BEGIN
  IF to_regclass('personal_memories_once') IS NULL THEN
    CREATE TABLE personal_memories_once ();
    WITH solo AS (
      SELECT s.id, s.owner_id FROM spaces s WHERE s.is_personal
        AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id <> s.owner_id)
    ), moved AS (
      INSERT INTO user_memories (id, user_id, text, source_page_id, created_at)
      SELECT mm.id, solo.owner_id, mm.text, mm.source_page_id, mm.created_at FROM space_memories mm JOIN solo ON solo.id = mm.space_id
      ON CONFLICT (id) DO NOTHING RETURNING id
    )
    DELETE FROM space_memories WHERE id IN (SELECT id FROM moved);
  END IF;
END $$;
`
