// ---------- 私人区的表结构、不变量与一次性迁移（拼进 db.ts 的 DDL / MIGRATIONS） ----------
// pages.private_owner 非空 = 这一页在这个人的私人区，只有他看得到（判定只在 page-visibility.ts）；空 = 公共区。
// 区跟着父页走：子页恒与父页同区，由下面两条触发器在数据库里保证，任何写路径（建页、复制、导入、建行、过程页、挪父页）都漏不掉；
// 应用层只在顶层落点上决定区（建页时给值、换区时改顶层页）。

/** 加列：必须排在 db.ts 里 live_pages 视图重建之前（视图的列集合在创建时固定）。
 *  不级联删除：删号必须先删掉他的私人页（user-delete.ts），漏了就删号失败，而不是留下没人认领、也没人看得到的页 */
export const PAGE_AREA_COLUMN_DDL = `
ALTER TABLE pages ADD COLUMN IF NOT EXISTS private_owner TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_pages_private_owner ON pages(private_owner) WHERE private_owner IS NOT NULL;
`

/** 区的不变量。排在 pages 与 page_changes 的触发器之后（每次启动 CREATE OR REPLACE，幂等） */
export const PAGE_AREA_TRIGGERS_DDL = `
-- 子页恒与父页同区：插入 / 换父页 / 改区时按父页改写，顶层页保留写入时给的值（直接改子页的区因此无效）
CREATE OR REPLACE FUNCTION pages_area_inherit() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT p.private_owner INTO NEW.private_owner FROM pages p WHERE p.id = NEW.parent_id;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE OR REPLACE TRIGGER pages_area_inherit BEFORE INSERT OR UPDATE OF parent_id, private_owner ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_area_inherit();
-- 区变了，直接子页跟着改（子页上的这两条触发器再往下传，整棵子树换区）。UPDATE OF 只认 SET 里写到的列，
-- 挪父页（只 SET parent_id）换了区也要传，所以挂两列、比 OLD / NEW
CREATE OR REPLACE FUNCTION pages_area_cascade() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.private_owner IS DISTINCT FROM OLD.private_owner THEN
    UPDATE pages SET private_owner = NEW.private_owner WHERE parent_id = NEW.id AND private_owner IS DISTINCT FROM NEW.private_owner;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE OR REPLACE TRIGGER pages_area_cascade AFTER UPDATE OF parent_id, private_owner ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_area_cascade();
`

/** 存量收进私人区，只跑一次（标记表同 triggers/schema.ts 的 builtin_off_once）：以后主人把页挪回公共区，重启不会再被收回去。
 *  注册时得到的空间（is_personal）没有别的成员：除 skill 页外全部进主人私人区（只改顶层页，触发器带着子树；回收站里的同样）。
 *  有别的成员：只把主人的 Genet 页（连任务页、过程页）收进他的私人区，其余维持公共，成员照常用。其它空间不动 */
export const PAGE_AREA_MIGRATION = `
DO $$ BEGIN
  IF to_regclass('private_area_once') IS NULL THEN
    CREATE TABLE private_area_once ();
    UPDATE pages p SET private_owner = s.owner_id FROM spaces s
     WHERE p.space_id = s.id AND s.is_personal AND p.parent_id IS NULL AND p.kind <> 'skill' AND p.private_owner IS NULL
       AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id <> s.owner_id);
    UPDATE pages p SET private_owner = a.user_id FROM assistants a, spaces s
     WHERE p.id = a.page_id AND s.id = p.space_id AND s.owner_id = a.user_id AND s.is_personal AND p.private_owner IS NULL;
  END IF;
END $$;
`
