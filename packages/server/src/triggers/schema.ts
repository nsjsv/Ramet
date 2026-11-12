// 触发器 / 规则的表与列（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。单独成文件是为了 db.ts 不超过行数闸门；
// 这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// users.time_zone：浏览器上报的 IANA 时区；null = 按服务器时区（triggers/schedule.ts 的 serverTimeZone）。
// agent_triggers：一个触发器一行。source 是来源（取值同 payload.ts 的 TRIGGER_SOURCES），spec 是定时器的时间表（Schedule）。
//   按空间建模（space_id = 目标页所在空间），以创建人（owner_id）的身份触发、按他此刻的权限重判。表名不用 triggers：
//   库里已经有 page_changes_* 这类 Postgres 触发器，同名读代码容易混。
//   time_zone = 创建 / 改时间表时记下的时区；next_at 为空 = 不再自动触发（暂停 / 一次性的已经触发过）；
//   paused_reason = 连续失败自动暂停的原因（手动暂停为空）。删定时器 = 物理删，触发记录跟着级联；
//   目标页进了回收站不级联：触发时判活页失败 → 失败计数 → 连续 3 次自动暂停（用户在 AI 页上看得到原因）。
// trigger_events：每次到点（以后每个事件）先落一行再派发。dedup_key 唯一（timer:<id>:<预定时刻>）：同一个预定时刻并发 / 重复扫描只记一次。
//   created_at 由中心的时钟写（不用列默认值）：24 小时次数上限与 30 天清理都按它算，时钟在测试里可以注入。
//   status：pending = 刚记下还没派发；queued = 进了排队发送（目标是任务页）；delivered / skipped / failed 是终态。
// send_queue.trigger_event：这一条排队项是哪条触发记录排进来的（排队发送据此通知触发器结局）。不挂外键：记录 30 天清理，
//   排队项不该活这么久；排队项先没了（页面物理删除）由启动时的恢复把记录收成失败。
//
// 规则（自动化）：一个触发器 = 触发（source + 来源的配置）+ 一串动作（actions，triggers/actions.ts 的 Action[]）。
//   建表语句里的来源 CHECK 是内联的（PG 生成的名字 agent_triggers_source_check），老库上 CREATE TABLE IF NOT EXISTS 是 no-op，
//   所以在串尾摘掉它、换成命名约束 agent_triggers_source_known（DO 块按 pg_constraint 判，重复启动不动）。
//   config = 来源的过滤配置（定时器的时间表仍在 spec）；scope_page = 挂靠页（合集 / 按钮 / AI 块所在页），对那一页的编辑者可见。
//   target_page / agent / instruction 是动作串之前的老列：派发只读 actions；定时器的写入口仍把「第一个 AI 动作」同步写进老列，
//   Genet 的定时器工具按 target_page 限定「目标在这个 Genet 页名下」，回滚代码时老逻辑也还读得到。
//   老列的外键改成 ON DELETE SET NULL：规则有好几个动作、叫 Genet 时找的是主人当前的 Genet 页，
//   老列指着的那一页被物理删掉不该连整条规则一起删（真没了的目标由派发时判失败、连续失败自动暂停，主人看得到）。
//   老定时器迁成一个动作：只改 actions 还是空数组的行（新建的规则至少一个动作），重复启动不改数据。
// trigger_events 新列：payload = 事件载荷（triggers/payload.ts）；actor_id = 触发者（null = 定时 / 外部）；
//   external = 触发者不是规则主人（别人的评论、外部 webhook）：Genet 读到这种事件后动手要先问用户（triggers/taint.ts）；
//   depth = 自动化连锁的深度（动作改了页面又触发规则，+1，到上限跳过）；results = 每个动作的结局 [{ type, status, reason }]，
//   它的长度就是下一个要跑的动作（排进队的 agent 动作开跑后从这里接着跑）；ai = 动作里有没有 AI（叫 Genet / 叫 agent），两种分开算每日上限。
// automation_notices：「发通知」动作写给某人的一条收件箱通知；space_id = 规则所在空间（收件箱只列自己是成员的空间），规则删了通知留着。
// quiet_turns：Genet 在哪一页的哪个时刻标了「不用处理」（routes/mark-handled.ts）。那一轮的过程页不算「做完待你看」（inbox.ts 的 done）：
//   过程页与回复块之间库里没有关联（只在文档里），按时间认 —— 同一页同时只有一轮，落在上一个过程页之后、这个过程页之前的标记就是这一轮的。
// agent_triggers.builtin：每人一条的内置规则（'comment' = 评论找我、'mention' = 正文 @我，triggers/builtin.ts）。新建的关着、只能关不能删；
//   唯一索引挡住并发补建出两条。
// builtin_off_once：内置规则曾经是默认开的（每来一条评论 / 正文 @ 就跑一轮 Genet，花主人的模型额度），改成默认关时把存量的一次性关掉。
//   这张空表只当「已经关过」的记号：DO 块看表在不在，不在就建表并关掉全部内置规则；之后用户自己打开的，重启时不会再被关。
// page_mentions：正文里「哪一块 @了谁」的当前集合（triggers/sources/mention.ts 每次存盘按差集认新增的 @）。
//   actor_id = 插入它的人（那一块最后的编辑者，agent 写的记发起人）；为空 = 认不出是谁加的（导入 / 复制来的、上线前就有的），
//   这种不触发、也不进收件箱。不挂 users 外键：编辑者删号后行留着，收件箱按 users 现查认不出就不给。excerpt = 当时那一块的文字摘录（收件箱用）。
// mention_baseline：上线时已经有的页。它们第一次扫描只记底、不触发（不然存量的 @ 会在第一次存盘时全部当成新的补发）；
//   之后新建的页不在这里，第一次存盘里就有的 @ 照常算新增。只在建表的那一次填（DO 块按表在不在判，重复启动不动）；
//   只填正文里可能有 @ 的（content_text 含 @，或者还没有索引过的）。
// comments.via：'genet' = Genet 以作者的名义代发（作者点了审批卡上的「发送」，routes/comment-reply.ts）。
// page_watch_windows：盯页面的规则正在攒的改动，一条规则 × 一页一行（triggers/sources/page-watch.ts）。opened_at / last_at = 这一阵里
//   第一次 / 最后一次被别人改；base = 第一次被别人改之前的样子（updates.ts 的 SummaryState），汇报时拿它和现在比出摘要；
//   depth = 这阵改动里最深的连锁。规则的 next_at 就是预计汇报的时刻；汇报（认领）时这条规则的行一起删掉。
// agent_triggers.hook_hash：「收到外部请求」规则的地址密钥的 sha256（triggers/sources/webhook.ts）。密钥本身不落库、只在建好 / 换地址时给主人看一次；
//   接收端按哈希找规则（唯一索引）。别的来源为空。
export const TRIGGERS_DDL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT;
CREATE TABLE IF NOT EXISTS agent_triggers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('timer')),
  name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  spec JSONB NOT NULL,
  time_zone TEXT NOT NULL,
  target_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_at TIMESTAMPTZ,
  fail_streak INT NOT NULL DEFAULT 0,
  paused_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_due ON agent_triggers(next_at) WHERE enabled AND next_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_triggers_owner ON agent_triggers(owner_id, created_at);
CREATE TABLE IF NOT EXISTS trigger_events (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL UNIQUE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'delivered', 'skipped', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trigger_events_trigger ON trigger_events(trigger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_events_owner ON trigger_events(owner_id, created_at DESC);
ALTER TABLE send_queue ADD COLUMN IF NOT EXISTS trigger_event TEXT;
CREATE INDEX IF NOT EXISTS idx_send_queue_trigger ON send_queue(trigger_event) WHERE trigger_event IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_triggers_source_check') THEN
    ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_source_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_triggers_source_known') THEN
    ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_source_known
      CHECK (source IN ('timer', 'comment', 'mention', 'page_watch', 'webhook', 'collection', 'button', 'ai_block', 'ai_prop'));
  END IF;
END $$;
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS scope_page TEXT REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE agent_triggers ALTER COLUMN target_page DROP NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_triggers_target_page_fkey' AND confdeltype = 'c') THEN
    ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_target_page_fkey;
    ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_target_page_fkey FOREIGN KEY (target_page) REFERENCES pages(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_agent_triggers_source ON agent_triggers(source) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_agent_triggers_scope ON agent_triggers(scope_page) WHERE scope_page IS NOT NULL;
UPDATE agent_triggers SET actions = jsonb_build_array(CASE WHEN agent = 'ramet:assistant'
    THEN jsonb_build_object('type', 'genet', 'instruction', instruction)
    ELSE jsonb_build_object('type', 'agent', 'page', target_page, 'agent', agent, 'instruction', instruction) END)
  WHERE source = 'timer' AND actions = '[]'::jsonb AND target_page IS NOT NULL;
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0;
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]';
ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS ai BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS automation_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES agent_triggers(id) ON DELETE SET NULL,
  event_id TEXT,
  rule_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_notices_user ON automation_notices(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS quiet_turns (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quiet_turns_page ON quiet_turns(page_id, at);
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS builtin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_triggers_builtin ON agent_triggers(owner_id, builtin) WHERE builtin IS NOT NULL;
CREATE TABLE IF NOT EXISTS page_mentions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, block_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_page_mentions_user ON page_mentions(user_id, created_at DESC);
DO $$ BEGIN
  IF to_regclass('mention_baseline') IS NULL THEN
    CREATE TABLE mention_baseline (page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE);
    INSERT INTO mention_baseline (page_id) SELECT id FROM pages WHERE kind = 'doc' AND (content_text IS NULL OR content_text LIKE '%@%');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS page_watch_windows (
  trigger_id TEXT NOT NULL REFERENCES agent_triggers(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  last_editor TEXT,
  editors TEXT[] NOT NULL DEFAULT '{}',
  base JSONB NOT NULL,
  depth INT NOT NULL DEFAULT 0,
  PRIMARY KEY (trigger_id, page_id)
);
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS hook_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_triggers_hook ON agent_triggers(hook_hash) WHERE hook_hash IS NOT NULL;
DO $$ BEGIN
  IF to_regclass('builtin_off_once') IS NULL THEN
    CREATE TABLE builtin_off_once ();
    UPDATE agent_triggers SET enabled = false, updated_at = now() WHERE builtin IS NOT NULL AND enabled;
  END IF;
END $$;
`
