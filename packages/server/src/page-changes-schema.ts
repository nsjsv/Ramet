// ---------- 页面变更日志的表与触发器（页面列表增量同步 page-sync.ts 的唯一采集点；拼进 db.ts 的 DDL） ----------
import { COVER_COLUMNS } from './page-cover.js'
import { API_PAGE_FIELDS } from './page-icon.js'

// UPDATE 触发列：对外字段（API_PAGE_FIELDS，含 position、private_owner）+ 图标两列 + 封面三列 + deleted_at。
// 由白名单拼出，不另抄一份列清单，对外字段加列时触发条件跟着变。content_text / agent_session /
// content_updated_at 每次存储都在写又不下发，不在内，正文存盘不产生日志。
const PAGE_CHANGE_COLUMNS = [...API_PAGE_FIELDS, 'icon_emoji', 'icon_file_id', ...COVER_COLUMNS, 'deleted_at']
const PAGE_CHANGE_WHEN = PAGE_CHANGE_COLUMNS.map((col) => `OLD.${col} IS DISTINCT FROM NEW.${col}`).join(' OR ')

/** 排在 pages 加列（含 private_owner）之后：触发条件的 WHEN 引用这些列 */
export const PAGE_CHANGES_DDL = `
-- 页面变更日志(page-sync.ts):页面列表的增量同步只拉日志里出现过的页。唯一采集点是下面 pages 上的触发器
-- —— 改父页 / 标题 / 回收 / 恢复 / 删除的写路径有几十处,一处都不用挂回调。
-- xid = 写入它的事务号:客户端游标取读取时快照的 xmin,下次取 xid >= 它的行,晚提交的事务也不会漏(推理见 page-sync.ts)。
-- page_id 不加外键:物理删除后日志还要留着(要告诉客户端摘掉它)。space_id = 变更时所在空间,按它判可见,
-- 换空间时新旧各记一条。7 天前的行由 prunePageChanges 清掉,同时把 floor 推过被删的最大 xid:游标比它旧就整表
CREATE TABLE IF NOT EXISTS page_changes (
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  page_id TEXT NOT NULL,
  space_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_changes_xid ON page_changes (xid);
-- 变更时页面所在的区(pages.private_owner):私人页的变更只发给它的主人;换区像换空间一样新旧各记一条
ALTER TABLE page_changes ADD COLUMN IF NOT EXISTS private_owner TEXT;
CREATE TABLE IF NOT EXISTS page_changes_floor (
  one BOOLEAN PRIMARY KEY DEFAULT true CHECK (one),
  xid xid8 NOT NULL
);
CREATE OR REPLACE FUNCTION page_changes_log() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO page_changes (page_id, space_id, private_owner) VALUES (OLD.id, OLD.space_id, OLD.private_owner);
    RETURN NULL;
  END IF;
  INSERT INTO page_changes (page_id, space_id, private_owner) VALUES (NEW.id, NEW.space_id, NEW.private_owner);
  IF TG_OP = 'UPDATE' AND (OLD.space_id IS DISTINCT FROM NEW.space_id OR OLD.private_owner IS DISTINCT FROM NEW.private_owner) THEN
    INSERT INTO page_changes (page_id, space_id, private_owner) VALUES (OLD.id, OLD.space_id, OLD.private_owner);
  END IF;
  RETURN NULL;
END
$fn$;
-- 增删(含外键级联的物理删除)一律记;UPDATE 只在对外可见的列变了才记(WHEN 由 API_PAGE_FIELDS 拼出,见文件头)。
-- 每次启动 CREATE OR REPLACE:白名单变了,触发条件随之更新
CREATE OR REPLACE TRIGGER page_changes_ins_del AFTER INSERT OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION page_changes_log();
CREATE OR REPLACE TRIGGER page_changes_upd AFTER UPDATE ON pages
  FOR EACH ROW WHEN (${PAGE_CHANGE_WHEN}) EXECUTE FUNCTION page_changes_log();
`
