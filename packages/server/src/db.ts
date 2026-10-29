import { Pool, type PoolClient } from 'pg'
import { API_PAGE_FIELDS } from './page-icon.js'

// 页面变更日志（page-sync.ts）的 UPDATE 触发列：对外字段（API_PAGE_FIELDS，含 position）+ 图标两列 + deleted_at。
// 由白名单拼出，不另抄一份列清单，对外字段加列时触发条件跟着变。content_text / agent_session /
// content_updated_at 每次存储都在写又不下发，不在内，正文存盘不产生日志。
const PAGE_CHANGE_COLUMNS = [...API_PAGE_FIELDS, 'icon_emoji', 'icon_file_id', 'deleted_at']
const PAGE_CHANGE_WHEN = PAGE_CHANGE_COLUMNS.map((col) => `OLD.${col} IS DISTINCT FROM NEW.${col}`).join(' OR ')

// owner_id 保持可空:避免在有数据的老库上加 NOT NULL 的迁移复杂度,新建页面由应用层必写,
// 残留 NULL 的只是记录缺失,可见性只看 space_id。
const DDL = `
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  -- 同父子页排序（侧栏拖拽插中间）：NULL = 未排过（按 created_at 兜底排在有值之后）
  position DOUBLE PRECISION,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, -- scrypt 存 "salt:hash" hex,永不明文
  role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
  must_change_password BOOLEAN NOT NULL DEFAULT false, -- 临时密码建的号首次登录强制改密
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS yjs_documents (
  doc_name TEXT PRIMARY KEY,
  state BYTEA NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS yjs_updates (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_name TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_yjs_updates_doc ON yjs_updates(doc_name, seq);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
-- 用户头像:对 files.id 的引用(图片;对外读 /api/files/:id/icon 的 160px 方图派生)。
-- NULL = 没上传,前端画「用户名首字 + 固定色」。文件永不删除,与 pages.icon_file_id 同样无外键清理负担
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file_id TEXT;
-- 空间三表:个人空间(owner 建号即得)与自建共享空间同一张表,靠 is_personal 区分;
-- space_members 主键 (space_id,user_id) 天然防重复加入;邀请永不授 owner(role 只有 member|viewer)
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  is_personal BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'owner' | 'member' | 'viewer'
  created_at TEXT NOT NULL DEFAULT (now()::text),
  PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_invites (
  token TEXT PRIMARY KEY, -- randomBytes(32).hex,与 session 同源;库存原值
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'member' | 'viewer'
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES spaces(id);
-- 页面快照:onStoreDocument 按间隔自动存 + REST 手动存;
-- 增量链存储:每页首条为全量锚点,其余为相对前一条状态向量的增量,页面删除靠外键级联清理
CREATE TABLE IF NOT EXISTS page_snapshots (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',      -- 快照时的页面标题(列表展示用,取自 Y.Doc title fragment)
  origin TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual'
  data BYTEA NOT NULL,                 -- 首行 Y.encodeStateAsUpdate 全量(锚点);其余为相对前一条的增量
  sv BYTEA,                            -- 快照时的 Y.encodeStateVector;旧格式全量行为 NULL(读时现算)
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_page_snapshots_page ON page_snapshots(page_id, created_at DESC);
-- 存量库补列:旧行 sv 为 NULL,insertSnapshot 用 encodeStateVectorFromUpdate 现算
ALTER TABLE page_snapshots ADD COLUMN IF NOT EXISTS sv BYTEA;
-- 快照作者:auto = 批次内最后编辑者,manual = 触发用户;老行为 NULL(前端省略作者名)。
-- 删号置 NULL 快照保留(前端显示「有人」),否则删号会被 NO ACTION 外键挡住
ALTER TABLE page_snapshots ADD COLUMN IF NOT EXISTS author_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- 上传文件:原图落盘 UPLOAD_DIR/<uuid>,库只存元数据;文件名只用于 Content-Disposition,永不落成磁盘名。
-- 刻意无 DELETE 端点:文件永不删除(历史快照里的图片引用必须仍可加载),删节点只从 doc 移除引用
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL, -- bodyLimit 压在 10MB,int4 足够
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
-- 页面公开标记:自己或任一祖先 published 即匿名可见(/p/ 预览与公开克隆的闸门);
-- 发布页面即发布整棵子树,默认一律不公开
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false;
-- 上传查重:内容 sha256 指纹,同 hash 静默复用已有行(不落盘/不插表/不生成 display 版);
-- 存量行 NULL 不回填(永不命中,重传多落一份属可接受);无唯一约束,并发双传双双落盘无害
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files (content_hash);
-- 版本检查点(快照永不删除):is_base = 该行 data 是全量 state,物化与流水可以从这行起 apply;
-- 每页首行必为 base,此后每 CHECKPOINT_EVERY 行一个(见 collab.ts),其余行仍是相对上一条的增量。
-- 历史上被裁剪逻辑改写成全量的行无法事后识别,保持 false 当增量 apply(幂等无害)
ALTER TABLE page_snapshots ADD COLUMN IF NOT EXISTS is_base BOOLEAN NOT NULL DEFAULT false;
-- 快照是谁写的：user = 登录用户自己打的字；agent = 机器人客户端或过程页归档。
-- actor_agent 是 catalog id（展示名由前端目录解析）。老行默认 user、agent 为空。
ALTER TABLE page_snapshots ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'user';
ALTER TABLE page_snapshots ADD COLUMN IF NOT EXISTS actor_agent TEXT;
-- 回收站:删页是软删除,deleted_at NULL = 活,now()::text = 回收时刻。行留在 pages
-- (树/外键/空间归属全不动),正文(yjs 两表)与版本历史(page_snapshots)原地保留,恢复只是清标记
ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TEXT;
-- Agent 会话状态:{sessions: {<agentId>: {sessionId, cwd, lastSyncedHash}}},由 agent 适配层读写
ALTER TABLE pages ADD COLUMN IF NOT EXISTS agent_session jsonb;
-- 正文纯文本索引:collab onStoreDocument 时从 Y.Doc 正文 fragment 抽取填充;
-- 老数据不做回填,首次存储自然覆盖。供 /api/search 模糊匹配
ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_text text;
-- 页面图标:emoji 字面量与图片文件引用是两类数据,分两列存;对外只暴露派生的
-- icon={kind,value} 单字段(见 page-icon.ts)。不变量「至多一个非空」由 DB 约束表达,
-- 任何写入路径都造不出非法行。图片列是对 files.id 的引用:文件永不删除故无外键清理负担
ALTER TABLE pages ADD COLUMN IF NOT EXISTS icon_emoji TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS icon_file_id TEXT;
-- PG 没有 ADD CONSTRAINT IF NOT EXISTS:按约束名探测,保证 DDL 重复执行幂等
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_icon_at_most_one') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_icon_at_most_one
      CHECK (num_nonnulls(icon_emoji, icon_file_id) <= 1);
  END IF;
END $$;
-- 页面判别:'doc' = 用户文档,'run' = agent 一轮运行的过程归档(见 agents/runs.ts),
-- 'skill' = 空间 skill(SKILL.md 正文,见 skills.ts)。
-- kind 只决定策略(搜索默认不见、不可单独发布、克隆不带),不决定能不能改。
-- 过程页 / skill 页正文是协同文档,和 doc 走同一条 collab 闸门
ALTER TABLE pages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'doc';
-- 「连工具调用过程一起公开」的发布选项(只对 doc 页有意义):默认 false,过程默认不外泄
ALTER TABLE pages ADD COLUMN IF NOT EXISTS publish_includes_runs BOOLEAN NOT NULL DEFAULT false;
DO $$ BEGIN
  -- 判别值随功能增加:老库里的定义不含 skill 就换掉(DROP + ADD 只发生一次,之后探测到 skill 即跳过)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_kind_known' AND pg_get_constraintdef(oid) NOT LIKE '%skill%') THEN
    ALTER TABLE pages DROP CONSTRAINT pages_kind_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_kind_known') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_kind_known CHECK (kind IN ('doc', 'run', 'skill'));
  END IF;
  -- 过程页 / skill 页恒不可单独发布:发布态只有 doc 页能承载,任何写入路径都造不出"公开的过程页"
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_run_never_published') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_run_never_published CHECK (kind = 'doc' OR published = false);
  END IF;
END $$;
-- 一轮 run 的结构化记录(思考/说明/工具条目、用时、用量,见 agents/run-record.ts)。
-- 页面正文不在这张表里:归档时写成 Yjs,用户改的是文档。页面物理删除时 record 随外键级联
CREATE TABLE IF NOT EXISTS runs (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  record JSONB NOT NULL
);
-- 空间 skill(Agent Skills 开放标准):一个 skill = 一个 kind='skill' 的页面。页面正文是 SKILL.md 的 markdown
-- 正文(协同文档);frontmatter 的 name / description 不是正文,在这里;scripts / references / assets 在 skill_files。
-- space_id 是页面空间的副本(页面建后不换空间,只在建时写一次):UNIQUE (space_id, name) 把「同空间 skill 名唯一」
-- 变成数据库不变量,含回收站里的行:名字在回收站期间一直被占着,恢复永远不会撞名;同名再导入 = 更新(并把它从回收站带回来)
CREATE TABLE IF NOT EXISTS skills (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  -- frontmatter 里除 name / description 之外的键(license / compatibility / metadata / allowed-tools …),原样保留
  extra JSONB NOT NULL DEFAULT '{}',
  -- 最近一次导入的来源:{type:'zip'|'folder'|'github', url?, at}。手动新建的为空
  source JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (space_id, name)
);
-- skill 的附件(相对 skill 根的路径,不含 SKILL.md)。内容进库而不是文件系统:重新导入 = 一个事务里整套替换,
-- 页面物理删除时随外键级联清掉,不留孤儿文件;agent 按 sha256 判断本地缓存要不要重拉
CREATE TABLE IF NOT EXISTS skill_files (
  page_id TEXT NOT NULL REFERENCES skills(page_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  data BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (page_id, path)
);
-- 收藏:每个用户私有的「页面或块」书签。page_id 不设外键 —— 页面被物理删除后收藏仍留着存档;
-- block_id '' = 收藏整页。archive / block_type / title / gone 跟着每次存页面刷新(collab 存储钩子,见 favorites.ts):
-- 列表直接读这几列(不为每条收藏加载文档),原块没了(gone)就展示存档并标「原块已删」
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  block_id TEXT NOT NULL DEFAULT '',
  archive TEXT NOT NULL DEFAULT '',
  block_type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  -- 存页面时发现原块已不在正文里（collab 存储钩子维护）。列表只读这一列，不为每条收藏去加载文档
  gone BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, page_id, block_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_page ON favorites (page_id);
-- 反向链接索引:从正文已有的 page_mention / block_ref / block_sync / 站内页面链接派生,
-- collab 存储钩子维护(见 page-links.ts),可由正文完全重建 —— 不是用户手写的关系。
-- source_block_id = 引用所在的可寻址块(没有 id 的块记 '');target_block_id '' = 整页。两端页面物理删除时级联清掉
CREATE TABLE IF NOT EXISTS page_links (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_block_id TEXT NOT NULL DEFAULT '',
  target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_block_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  -- 引用所在块的文字(建索引时截好):反链列表直接读它,不为每个来源页加载文档
  snippet TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source_page_id, source_block_id, target_page_id, target_block_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links (target_page_id);
-- 哪些页已经建过反链索引(启动时只补没建过的;存页面时顺带标记)
CREATE TABLE IF NOT EXISTS page_links_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 活页面的唯一读入口:所有"活页面"读路径一律 FROM live_pages(纯视图,Postgres 内联,计划不变)。
-- 只有回收站一族查询直接读 pages 并显式判 deleted_at(见 routes/pages.ts);
-- 写路径(INSERT/UPDATE/DELETE)仍打基表。每次启动重建:pages 后加列时视图跟着带上
CREATE OR REPLACE VIEW live_pages AS SELECT * FROM pages WHERE deleted_at IS NULL;
-- 侧栏拖拽排序:同父子页按 position(小数,可插中间),后建页 position 为空排最后(created_at 兜底)。
-- 幂等:列已存在(老库)才补列+按 created_at 回填排名;新库建表自带列,回填跳过(空表)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pages' AND column_name = 'position'
  ) THEN
    ALTER TABLE pages ADD COLUMN position DOUBLE PRECISION;
    UPDATE pages SET position = sub.rn - 1 FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(parent_id, '~root~') ORDER BY created_at, id
      ) AS rn
      FROM pages
    ) sub WHERE pages.id = sub.id;
  END IF;
END $$;
-- 页面树成员:false = 目录树自建文档。它仍属空间,但不进页面树;
-- 子孙是否显示由祖先链决定(见 pagesInPageTree),不靠这一列继承。
-- 必须排在下面的视图重建之前,否则 live_pages 的列集合带不上它
ALTER TABLE pages ADD COLUMN IF NOT EXISTS in_page_tree BOOLEAN NOT NULL DEFAULT true;
-- 正文文字最后一次真变的时间:搜索同档按它排(collab.ts 的 syncContentText 只在 content_text 变了才写)。
-- 同样必须排在视图重建之前
ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_updated_at TEXT;
-- 页面模板:true = 出现在「从模板新建」列表里(页面本身照常可读可改)。同样排在视图重建之前
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;
-- 全宽:true = 正文不收 720 列、铺满画面。页面属性(协作者与公开页同看),同样排在视图重建之前
ALTER TABLE pages ADD COLUMN IF NOT EXISTS full_width BOOLEAN NOT NULL DEFAULT false;
-- 视图重建必须排在加列之后:视图的列集合在创建时固定,SELECT * 不会自动带出新列
CREATE OR REPLACE VIEW live_pages AS SELECT * FROM pages WHERE deleted_at IS NULL;
-- 本地 connector(托管云拓扑):归属空间,出站 WSS 反连中心。明文 token 只在配对响应里
-- 出现一次,库里只存 sha256;agents 是最近一次上报的本机 agent 列表(离线时仍可展示)
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  agents jsonb NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_connectors_space ON connectors(space_id);
-- 在飞的远端回合绑定(见 agents/remote-run.ts):中心只是一轮 prompt 的投影,寿命所有者
-- 是 connector 上的 agent 进程。这一行在 adapter.prompt 之前写好,server 重启后它还在 ——
-- 新进程凭它 + connector 重连 hello.inflight 续上同一块 agent_reply。不存事件日志,不存 cookie。
-- 回合以 end/cancelled/error 收尾时删行;删页面靠外键级联。cancel_requested = 断线期间点的停止,
-- 认领时补发给 connector(否则停止会随 server 一起丢)。
CREATE TABLE IF NOT EXISTS open_runs (
  run_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  reply_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  msg_opts JSONB NOT NULL DEFAULT '{}',   -- 这条消息的配置覆盖
  msg_before JSONB NOT NULL DEFAULT '{}', -- 覆盖前的值(收尾要还原,见 applyMsgOpts)
  cancel_requested BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_open_runs_connector ON open_runs(connector_id);
CREATE INDEX IF NOT EXISTS idx_open_runs_page ON open_runs(page_id);
-- boards 只有「空间目录树」一行(一空间至多一行,UNIQUE(space_id))。
-- 页面树不是实体:它是该空间 pages 按 parent_id 组成的森林,由空间派生(有页面即渲染),
-- 没有行、不可建、不可删。目录树承载 folders + folder_items,行按需惰性落库(首次写入时
-- ENSURE_DIR_TREE),可删除、删后可按需重建。名字不存储:两棵树恒叫「页面树」「目录树」。
-- folders 嵌套(自引用级联),folder_items 挂页面/文件,UNIQUE (kind,item_id) = 单一归属全局不变量
-- (重复挂载走 UPSERT = 移动)。删除目录树行只级联掉目录与挂载关系,pages/files 本体不动(脱挂)。
-- 条目归属不变量:每条 folder_items 必属该空间目录树行(board_id NOT NULL),
-- folder_id 可空 = 挂在树顶层;非空时必须是同树目录。删行级联清掉全部条目(含根级)
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  -- 一空间至多一行。具名约束:迁移按名 DROP IF EXISTS + ADD 回装
  CONSTRAINT boards_space UNIQUE (space_id)
);
CREATE INDEX IF NOT EXISTS idx_boards_space ON boards(space_id);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position DOUBLE PRECISION,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);
CREATE TABLE IF NOT EXISTS folder_items (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('page','file')),
  item_id TEXT NOT NULL,
  position DOUBLE PRECISION,
  created_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE (kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_folders_board ON folders(board_id);
CREATE INDEX IF NOT EXISTS idx_folder_items_folder ON folder_items(folder_id);
-- 存量库迁移:补 board_id 归属(从目录回填)→ 收紧 NOT NULL → 放开 folder_id。
-- UPDATE 在 SET NOT NULL 之前,重启即自愈;folder_id DROP NOT NULL 对已是可空的列幂等
ALTER TABLE folder_items ADD COLUMN IF NOT EXISTS board_id TEXT REFERENCES boards(id) ON DELETE CASCADE;
UPDATE folder_items fi SET board_id = f.board_id FROM folders f
  WHERE fi.folder_id = f.id AND fi.board_id IS NULL;
ALTER TABLE folder_items ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE folder_items ALTER COLUMN folder_id DROP NOT NULL;
-- 索引必须在 ADD COLUMN 之后(存量库上先建会报列不存在)
CREATE INDEX IF NOT EXISTS idx_folder_items_board ON folder_items(board_id);
-- 存量库里 boards 若是带 kind/root_page_id/name/position/user_id 的老形状,由 migrateBoardsV4 收编成
-- 上面的形状:删页面树行与老形状独有列,回装 UNIQUE(space_id)。DDL 的 CREATE TABLE
-- IF NOT EXISTS 在存量库上是 no-op,列删除与约束回装全在迁移里真执行
-- 机器主人:配对人 = 这台 connector 上 agent 的主人。「跳过全部确认」只有主人能进
-- (posture.ts 的 authorize)。老 connector 没有主人,重新配对后才有,不回填。配对人账号删除 → NULL(不挡删号)
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- 机器授权:机器只归接入人(connectors.owner_id)。别人要用,必须有一条这里的授权:
-- scopes ⊆ {agent, machine},confirmed_at 非空(机器本地确认过才生效),revoked_at 为空,expires_at 未到。
-- 判定的唯一实现是 agents/machine-access.ts。授权对象只能是具体用户;granted_by 是审计字段,不挂外键(删号不能改写历史)。
-- 授权仪式(创建 → 机器本地确认 → 收回 / 到期)的写入口在 agents/machine-grants.ts。
-- 待确认授权带一次性确认码(只存哈希,确认后清空,15 分钟有效);first_used_at = 被授权人第一次真正用这台机器的时刻
-- (主人据此得到「有人开始用了」的提醒);ended_at = 收回 / 到期后「当场断开」已经执行的标记(到期清扫据此只做一次)
CREATE TABLE IF NOT EXISTS machine_grants (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL,
  granted_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirm_code_hash TEXT,
  confirm_expires_at TIMESTAMPTZ,
  first_used_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_machine_grants_lookup ON machine_grants(connector_id, user_id);
-- 存量库补列(CREATE TABLE IF NOT EXISTS 对旧形状是 no-op):
ALTER TABLE machine_grants ADD COLUMN IF NOT EXISTS confirm_code_hash TEXT;
ALTER TABLE machine_grants ADD COLUMN IF NOT EXISTS confirm_expires_at TIMESTAMPTZ;
ALTER TABLE machine_grants ADD COLUMN IF NOT EXISTS first_used_at TIMESTAMPTZ;
ALTER TABLE machine_grants ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
-- 使用记录(审计):只记非主人对这台机器的使用,主人自己用不记。user_id 不挂外键:删号不能改写历史。
-- action: run(发起 / 继续 / 重新生成 / @ 链 / run_agent 子运行)| answer(答审批)| config(改会话配置)| files(项目面板：打开 / 读文件 / 看 diff)
--         | terminal(终端：打开 / 关闭；不记每一行输入) | write(项目面板写文件：只记路径不记内容)
CREATE TABLE IF NOT EXISTS machine_usage_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  page_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_machine_usage_connector ON machine_usage_log(connector_id, created_at DESC);
-- 使用申请:成员向机器主人申请授权(申请只进主人的收件箱,批准仍走授权仪式)。同一人对同一台机器至多一条未处理的
CREATE TABLE IF NOT EXISTS machine_access_requests (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_requests_open ON machine_access_requests(connector_id, user_id) WHERE resolved_at IS NULL;
-- 随手 AI：用户自己的模型连接。站点不提供共用 key，key 是用户自己填的，AES-256-GCM 加密后落库
-- （主密钥来自环境变量 RAMET_SECRET_KEY，secret-box.ts；密文绑定 user_id 做 AAD）。key 永不出现在任何响应 / 日志里，只回后四位。
-- protocol: anthropic | openai（OpenAI 兼容）；base_url：anthropic 空 = 官方地址，openai 必填，已规范化且过了 SSRF 校验
-- （endpoint-guard.ts，每次请求时还会再校验）。model：anthropic + 官方地址只允许三个已知模型，其它自由填
CREATE TABLE IF NOT EXISTS user_ai_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('anthropic', 'openai')),
  base_url TEXT,
  model TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_ai_connections_user ON user_ai_connections(user_id, created_at);
-- 通道（site = 本站直连模型；local = 用自己机器上的 agent CLI）与当前选中的连接。删连接 → 选中置空
CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'site' CHECK (channel IN ('site', 'local')),
  active_connection_id TEXT REFERENCES user_ai_connections(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 本地通道用哪台机器上的哪个 agent（目录里的 catalog id：c:<connectorId>:<agentId>）；不设外键：机器被撤销后调用时再校验
ALTER TABLE user_ai_settings ADD COLUMN IF NOT EXISTS local_agent TEXT;
-- 随手 AI 在项目面板的代码查看器里改写并落盘的文件（write 帧成功后记一行）：改动页据此把这个文件标成「你（随手 AI）」而不是「你」。
-- root + path 是执行端的工作区与相对路径；不设 user_id 外键（同 machine_usage_log：删号不改写历史）
CREATE TABLE IF NOT EXISTS quick_writes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quick_writes_page ON quick_writes(page_id, at DESC);
-- 成员接入自己的机器:空间 member 也能配对,但要空间 owner 批准后这台机器才算「在空间里」。
-- pending = 等批准:任何人都用不了(包括接入人自己,判定唯一实现在 agents/machine-access.ts 的 USABLE),只有空间 owner 与接入人看得到;
-- approved = 已批准(空间 owner 自己配对的直接 approved)。存量 connector 全是 owner / admin 配的,所以默认 approved,不影响老数据。
-- 内联 CHECK 随 ADD COLUMN IF NOT EXISTS 一起幂等(列已在则整句跳过)
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved'));
-- 收件箱是视图,条目全部现算(routes/inbox.ts),只有这两张表是它自己的状态。
-- inbox_seen:我上次看这个对话页的时刻——「做完待你看」= 我发起的、之后又有新完成的回合;页面物理删时级联
-- inbox_dismissed:我点过「知道了」的条目(item_key 形如 first_use:<授权 id>,只能写进收件箱本来就给我的那类);删号级联
CREATE TABLE IF NOT EXISTS inbox_seen (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);
CREATE TABLE IF NOT EXISTS inbox_dismissed (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key)
);
-- 空间公共记忆:空间级、这个空间里所有 agent 共享;每轮开跑时全部原样带上(不筛选、不检索)。
-- 写入只有两条路:成员手动(记忆面板 / 输入卡 /记住),或 agent 经 propose_memory 提议、成员点「记住」。删空间级联删除。
-- created_by 不挂外键(同 machine_usage_log:删号不改写历史,显示名现查、查不到显示「有人」);source_page_id 页面物理删后置空
CREATE TABLE IF NOT EXISTS space_memories (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_by TEXT,
  source_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_space_memories_space ON space_memories(space_id, created_at);
-- 带队计划:组长在计划轮里提交的计划,用户确认后才开工。
-- status:draft(等发起人确认,可改)→ running(执行轮在跑)→ done / cancelled / error;进程重启后残留的 running 在启动时清扫成 error。
-- plan = {title, tasks:[{id,title,detail,assignee,label,dependsOn[],cwd?}]};"发起人此刻能不能用某个 agent"(usable)是现算的,不落库。
-- run_id = 提交这份计划的那个计划轮(同一轮重复提交覆盖同一行,只在 draft 时);result = 执行轮收尾时的团队状态(每个任务的状态 / 时段 / 结果摘要,GET 用);页面删除级联删除。
CREATE TABLE IF NOT EXISTS team_plans (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leader_agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'done', 'cancelled', 'error')),
  goal TEXT NOT NULL DEFAULT '',
  plan JSONB NOT NULL,
  run_id TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_plans_run ON team_plans(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_plans_page ON team_plans(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_team_plans_draft ON team_plans(user_id) WHERE status = 'draft';
-- 收藏归属页面所在的空间(侧栏只列当前空间的):收藏时写入,页面不换空间所以之后不用刷新;
-- 原页物理删除后仍靠它归位。空间删除时随之清掉。存量行由 MIGRATIONS 从 pages 回填
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE;
-- 运行中排队发送:agent 在跑时发的消息先排着,这一轮正常结束后由服务端以排队的人的身份写进文档并发起下一轮。
-- kind: message = 派发时写一条用户消息(text + images = 文件地址 /api/files/<id>);continue = 文档模式,消息已在文档里,只继续。
-- jump = 插队(停下当前这一轮后马上发)。随页面 / 用户删除一起清掉
CREATE TABLE IF NOT EXISTS send_queue (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'continue')),
  text TEXT NOT NULL DEFAULT '',
  images JSONB NOT NULL DEFAULT '[]',
  jump BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_send_queue_page ON send_queue(page_id, created_at);
-- 配对确认走浏览器:待确认请求只在内存(agents/pairing.ts),清掉遗留的一次性配对码表
DROP TABLE IF EXISTS connector_pair_codes;
-- 图床镜像(imgbed-sync.ts):每个文件的每个变体(orig 原图 / display / icon)一行。
-- status:ok = 已上传且回读 sha256 与本地一致(读入口只认它,302 到图床);failed = 失败(按 2^attempts 分钟退避重试,上限一天);
-- skip = 本地没有该变体 / 不适合上图床(非位图、SVG)/ 回读不一致,永不再试。file_id 不设外键:文件永不删除
CREATE TABLE IF NOT EXISTS file_mirrors (
  file_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('orig', 'display', 'icon')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skip')),
  path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, variant)
);
-- 上次编辑(edit-marks.ts):整页(block_id = '')与每个可寻址块各一行,只存最后一次,不是历史。
-- 协同钩子按事务 origin 的 context 归属(同快照的 author/actor 规则),存储钩子批量落库。
-- 单独成表而不是 pages 加列:页面树接口 SELECT * 每次 changed 广播都全员重拉,加列即加带宽。
-- 删号置 NULL(同 page_snapshots.author_id);物理删页随 pages 级联
CREATE TABLE IF NOT EXISTS edit_marks (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  actor_agent TEXT,
  edited_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (page_id, block_id)
);
-- 集合(collections/):集合页 = kind='collection' 的页面,名称、图标、位置、权限、回收站全走页面机制;
-- 行 = 父页是集合的 kind='doc' 页面(不另起 kind,属于哪个集合按 parent_id 现查)。
-- 判别值增加 collection:老库的定义里不含就换掉(同上面 skill 那次:DROP + ADD 只发生一次,之后探测到即跳过)。
-- pages_run_never_published 不变:kind <> 'doc' 恒不可公开,集合页天然满足
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_kind_known' AND pg_get_constraintdef(oid) NOT LIKE '%collection%') THEN
    ALTER TABLE pages DROP CONSTRAINT pages_kind_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_kind_known') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_kind_known CHECK (kind IN ('doc', 'run', 'skill', 'collection'));
  END IF;
END $$;
-- 每个集合页一行。inline = 归正文里的「集合」块所有(块删了集合跟着进回收站,只有内联生命周期钩子读它);
-- 属性定义与视图不在这里,在集合页文档的 Y.Map('collection')。集合页物理删除随外键清掉
CREATE TABLE IF NOT EXISTS collections (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  inline BOOLEAN NOT NULL DEFAULT false
);
-- 行属性的可查询副本:派生数据,随时可由行文档的 Y.Map('props') 完全重建,只有投影器写(collections/projector.ts),
-- 读的时候不反写文档。以行页 id 为键、不存集合 id:行属于哪个集合永远按 pages.parent_id 现查。
-- props_updated_at = 属性最后一次变化;「编辑时间」= 它与 pages.content_updated_at 取较晚者。
-- 单独成表而不是 pages 加列:页面列表 SELECT * 原样下发、每次 changed 全员重拉,属性值不能进去
CREATE TABLE IF NOT EXISTS collection_rows (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  props JSONB NOT NULL DEFAULT '{}',
  props_updated_at TIMESTAMPTZ
);
-- 内联集合的生命周期(collections/inline.ts):唯一执行者是宿主正文的存储钩子,只认「块从正文里消失 / 回来」。
-- ref_host = 上一次在哪个宿主的正文里看到过引用它的「集合」块(建内联集合时就是父页);
-- trashed_by_block = 是不是因为块从正文里消失才进的回收站(侧栏 / agent 删的不是,块回来也不替它恢复)
ALTER TABLE collections ADD COLUMN IF NOT EXISTS ref_host TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS trashed_by_block BOOLEAN NOT NULL DEFAULT false;
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
CREATE TABLE IF NOT EXISTS page_changes_floor (
  one BOOLEAN PRIMARY KEY DEFAULT true CHECK (one),
  xid xid8 NOT NULL
);
CREATE OR REPLACE FUNCTION page_changes_log() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO page_changes (page_id, space_id) VALUES (OLD.id, OLD.space_id);
    RETURN NULL;
  END IF;
  INSERT INTO page_changes (page_id, space_id) VALUES (NEW.id, NEW.space_id);
  IF TG_OP = 'UPDATE' AND OLD.space_id IS DISTINCT FROM NEW.space_id THEN
    INSERT INTO page_changes (page_id, space_id) VALUES (OLD.id, OLD.space_id);
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

// 存量数据迁移(幂等,可重复执行):
// 1) 每个没有个人空间的用户建一个(id 直接用 user id,与随机 UUID 的共享空间天然不撞);
// 2) 个人空间 owner 补 owner 成员行;
// 3) 有主但还没归入空间的页面迁入主人的个人空间;
// 4) 每页最旧一条快照标 is_base —— 它必是全量锚点(裁剪从不触及),
//    物化的起点查询依赖"每页至少一个 base",否则会从目标行(增量)起 apply 得错误结果;
// 5) 加 space_id 列之前的收藏从所在页回填空间。
// 孤儿页(owner 与 space 双 NULL)不动(谁都看不到,admin 也不例外)。
const MIGRATIONS = `
INSERT INTO spaces (id, name, owner_id, is_personal)
SELECT u.id, u.username || ' 的空间', u.id, true FROM users u
WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.owner_id = u.id AND s.is_personal)
ON CONFLICT (id) DO NOTHING;

INSERT INTO space_members (space_id, user_id, role)
SELECT s.id, s.owner_id, 'owner' FROM spaces s WHERE s.is_personal
  AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id = s.owner_id);

UPDATE pages SET space_id =
  (SELECT s.id FROM spaces s WHERE s.owner_id = pages.owner_id AND s.is_personal
   ORDER BY s.created_at, s.id LIMIT 1)
WHERE space_id IS NULL AND owner_id IS NOT NULL;

-- 页面恒属一个空间:上面已把有主的无空间行归位到个人空间,它们原本是目录树自建文档
-- (顶层页,home = 目录树挂载),归位后保持顶层即可。owner 也 NULL 的历史孤儿行不动
-- (谁都看不到) —— 那是本不变量的唯一例外。
-- 父子同空间不变量:存量里若出现父页与自身空间不同的行(跨空间父子),
-- 一律顶层化(parent_id := NULL),否则空间可见性边界会被父子链绕开
UPDATE pages SET parent_id = NULL
WHERE parent_id IS NOT NULL AND space_id IS DISTINCT FROM
  (SELECT a.space_id FROM pages a WHERE a.id = pages.parent_id);

-- 目录树自建文档不进页面树:顶层且已被目录树挂载的页记为非页面树成员。有父的挂载不动(那是挂在页面树上的页)。
-- 新的目录树文档创建时就写 false,这条只收编存量;每次启动重跑,已经是 false 的行不再命中
UPDATE pages SET in_page_tree = false
WHERE in_page_tree = true
  AND parent_id IS NULL
  AND id IN (SELECT item_id FROM folder_items WHERE kind = 'page');

UPDATE page_snapshots SET is_base = true WHERE NOT is_base AND id IN (
  SELECT DISTINCT ON (page_id) id FROM page_snapshots ORDER BY page_id, created_at ASC, id ASC
);

-- 收藏补空间:加列之前的收藏从所在页回填;原页已物理删除的回填不了,保持 NULL(哪个空间都不列)
UPDATE favorites f SET space_id = p.space_id FROM pages p
WHERE f.space_id IS NULL AND p.id = f.page_id AND p.space_id IS NOT NULL;
`

let pool: Pool | undefined

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL
    // fail fast:不猜默认连接串,缺配置启动即报错
    if (!url) throw new Error('DATABASE_URL 未设置(如 postgres://postgres:postgres@localhost:5432/ramet)')
    pool = new Pool({ connectionString: url })
  }
  return pool
}

// 幂等建表 + 幂等迁移 + 树注册表 v4 收编,进程启动时调用一次。
// 必须串行:DDL 的 ALTER(ACCESS EXCLUSIVE)与别的进程对 FK 级联表的 TRUNCATE 会跨进程互撞
// 死锁(vitest 多文件并发 initDb 时出现过)。连接级 advisory lock 排队,同一连接内跑完全部三段再释放
// (truncateAll 测试清库用同一把锁);进程崩溃时锁随连接消失,无粘住面
export const INIT_DB_LOCK = '7302849201'
export async function initDb(target: Pool = getPool()): Promise<void> {
  const client = await target.connect()
  let locked = false
  try {
    await client.query('SELECT pg_advisory_lock($1)', [INIT_DB_LOCK])
    locked = true
    await client.query(DDL)
    await client.query(MIGRATIONS)
    await migrateBoardsV4(client)
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [INIT_DB_LOCK]).catch(() => {})
    client.release()
  }
}

// 树模型 v4 数据迁移的 DO 块(幂等可重跑,覆盖 v1/v2/v3/全新库)。boards 从「一空间
// 两类树行」收敛成「一空间至多一行目录树」:页面树改为空间派生,不再有实体行。按
// information_schema 探测存量形状,不依赖具体版本:
//   has_root = v2 的 root_page_id;has_user = v2 的 user_id/name;has_kind = v3 的 kind
// 顺序硬约束:
//   1) 有 root_page_id 的库先收编 v2 包装根页(根页子页提空间顶层、根页入回收站);
//   2) 同库再去重(v2 允许一空间多棵目录树):只留挂载条目最多的一行,其余 DELETE
//      (folders/folder_items 级联,页面/文件本体不动);
//   3) 有 kind 的库删掉全部 page_tree 行(它不再有实体);v2 的 user_id/name NOT NULL 先放开
//      —— 它们只挡后续插入,列随即被删。
// 全新库:三分支全跳过。收尾的 DROP IF EXISTS / 判重 ADD 全幂等。
const MIGRATE_BOARDS_V4_SQL = `
DO $$
DECLARE
  has_root BOOLEAN := EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'boards' AND column_name = 'root_page_id');
  has_user BOOLEAN := EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'boards' AND column_name = 'user_id');
  has_kind BOOLEAN := EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'boards' AND column_name = 'kind');
BEGIN
  IF has_root THEN
    -- 1a) 拆 v2 包装根页的边:根页的直接子页提为空间顶层(parent_id NULL = 合法状态)
    UPDATE pages SET parent_id = NULL
     WHERE deleted_at IS NULL
       AND parent_id IN (SELECT root_page_id FROM boards WHERE root_page_id IS NOT NULL);
    -- 1b) 根页本身移入回收站(可恢复),不再作为用户内容出现
    UPDATE pages SET deleted_at = now()::text
     WHERE id IN (SELECT root_page_id FROM boards WHERE root_page_id IS NOT NULL)
       AND deleted_at IS NULL;
  END IF;

  -- 2) 去重(UNIQUE(space_id) 前置):v2 才允许一空间多棵目录树(v3 的 UNIQUE(space_id,kind)
  --    已把它收敛成至多一行 ⇒ v3 库本步空跑;因此判据绑 v2 的 root_page_id 列,不是 kind 列)。
  --    保留挂载条目最多的一行(最大化保留用户挂上去的内容),其余 DELETE —— folders/folder_items
  --    随行级联删,页面/文件本体不动。
  IF has_root THEN
    DELETE FROM boards b WHERE b.id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (
                 PARTITION BY space_id
                 ORDER BY (SELECT count(*) FROM folder_items fi WHERE fi.board_id = boards.id) DESC,
                          created_at, id
               ) AS rn
        FROM boards WHERE kind = 'folder_tree'
      ) ranked WHERE rn > 1
    );
  END IF;

  -- 3) 页面树不再有实体行(v3 存量每空间一行 page_tree;v1/v2 可能有用户自建的多行)
  IF has_kind THEN
    DELETE FROM boards WHERE kind = 'page_tree';
  END IF;

  -- v2 的 user_id/name 是 NOT NULL,而 v4 不再写这两列 ⇒ 先放开(列在收尾里删除)
  IF has_user THEN
    ALTER TABLE boards ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE boards ALTER COLUMN name DROP NOT NULL;
  END IF;
END $$;`

// 惰性补建该空间目录树行(幂等):UNIQUE(space_id) 命中即 no-op。新空间默认 0 行,行只在该空间
// 第一次拥有目录树内容(建目录/挂条目)或用户显式「新建目录树」时产生。供 clone.ts / spaces.ts /
// routes/boards.ts 复用
export const ENSURE_DIR_TREE = `INSERT INTO boards (id, space_id) VALUES (gen_random_uuid()::text, $1)
  ON CONFLICT (space_id) DO NOTHING`

// 树模型 v4 迁移(幂等可重跑):DO 块收编存量数据(见上),收尾删 v2/v3 独有列与旧约束,
// 回装 UNIQUE(space_id)。先 DROP 再 ADD,PG 无 ADD CONSTRAINT IF NOT EXISTS ⇒ 用 pg_constraint 判重。
// 导出供测试单独驱动。
export async function migrateBoardsV4(target: Pool | PoolClient): Promise<void> {
  await target.query(MIGRATE_BOARDS_V4_SQL)
  // v1/v2 的 space_id NULL 树行(个人数据,user_id 指向创建者)在 v4 无意义(目录树是空间资产):
  // 先回填进创建者的个人空间(与 v2 迁移同语义,保住目录与挂载),回填不上的才删——
  // 直接 DELETE 会因 folders/folder_items 级联静默丢掉整套目录内容。user_id 列此刻仍在(收尾才 DROP)。
  // 幂等:回填后无 NULL 行,再删空跑;SET NOT NULL 重复执行无害
  await target.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'boards' AND column_name = 'user_id') THEN
        UPDATE boards SET space_id = (SELECT s.id FROM spaces s
          WHERE s.owner_id = boards.user_id AND s.is_personal
          ORDER BY s.created_at, s.id LIMIT 1)
         WHERE space_id IS NULL;
      END IF;
    END $$;
    DELETE FROM boards WHERE space_id IS NULL;
    ALTER TABLE boards ALTER COLUMN space_id SET NOT NULL;
  `)
  await target.query(`
    ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_kind_shape;
    ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_space_kind;
    ALTER TABLE boards DROP COLUMN IF EXISTS root_page_id;
    ALTER TABLE boards DROP COLUMN IF EXISTS name;
    ALTER TABLE boards DROP COLUMN IF EXISTS position;
    ALTER TABLE boards DROP COLUMN IF EXISTS user_id;
    ALTER TABLE boards DROP COLUMN IF EXISTS kind;
  `)
  await target.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'boards_space' AND conrelid = 'boards'::regclass
      ) THEN
        ALTER TABLE boards ADD CONSTRAINT boards_space UNIQUE (space_id);
      END IF;
    END $$;
  `)
}

// 跨表多步写(压缩、级联删页)统一走这里:BEGIN → fn(client) → COMMIT,异常 ROLLBACK
export async function withTransaction<T>(target: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await target.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // 连接已坏时 ROLLBACK 本身会抛,不能让它顶掉真正的原始错误
    }
    throw err
  } finally {
    client.release()
  }
}

// 结束并丢弃当前池;之后的 getPool() 会重连同一库(测试的"重启"场景用)
export async function closePool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = undefined
  await p.end()
}
