import { Hocuspocus, type Extension, type onConnectPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from './db.js'
import { contentKey, isBlankPage } from './doc-content.js'
import type { AuthUser } from './auth.js'
import { textOf } from './updates.js'
import { runSearchText } from './agents/run-doc.js'
import { reapUnreferencedRuns } from './agents/reap-runs.js'
import { syncInlineCollections } from './collections/inline.js'
import { refreshFavoriteArchives } from './favorites.js'
import { syncPageLinks } from './page-links.js'
import { flushEditMarks, trackEdits } from './edit-marks.js'

// 压缩阈值取 200：每攒 200 条增量才做一次全量快照重写，写放大约为全量方案的 1/200；
// 加载时按 seq 重放 200 条小增量是内存内 applyUpdate，耗时无感。
export const COMPACT_THRESHOLD = 200

// 追加增量的落行闸：页面行必须仍存在（物理删页与在途 append 会竞态）。
// FOR SHARE 把 append 定住等 purge 事务提交（commit 后行已删，EXISTS 重判为假，写被丢弃），
// 单语句自身无死锁面；control:global 等非 page 文档不闸
const APPEND_UPDATE = `INSERT INTO yjs_updates (doc_name, data)
  SELECT $1, $2 WHERE NOT ($1 LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM pages WHERE id = substring($1 from 6) FOR SHARE)`
const GET_SNAPSHOT = 'SELECT state FROM yjs_documents WHERE doc_name = $1'
const REPLAY_UPDATES = 'SELECT data FROM yjs_updates WHERE doc_name = $1 ORDER BY seq'
const COUNT_UPDATES = 'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_name = $1'
const PUT_SNAPSHOT = `INSERT INTO yjs_documents (doc_name, state, updated_at)
  VALUES ($1, $2, now()::text)
  ON CONFLICT (doc_name) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`
const DELETE_UPDATES = 'DELETE FROM yjs_updates WHERE doc_name = $1'
// 活页面视图：已回收页面在这里打不上，与不存在同响应（null），ws 与 REST 共用同一条闸门。
// LEFT JOIN 保住“页面存在”这一行（m.role 为 null 即非成员）；可见性唯一依据是 space_members
// （页面恒属一个空间），admin 不例外
const GET_PAGE_ACCESS = `SELECT m.role AS role
  FROM live_pages p
  LEFT JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $2
  WHERE p.id = $1`
// 标题播种用：Yjs 里还没有标题时，从 DB 把 title 补进文档
const SELECT_PAGE_TITLE = 'SELECT title FROM live_pages WHERE id = $1'

/** 追加一条文档增量。页面行必须仍在(与 onChange 同一条闸,物理删页与在途写入不留孤儿增量) */
export async function appendDocUpdate(client: Pool | PoolClient, docName: string, data: Buffer): Promise<void> {
  await client.query(APPEND_UPDATE, [docName, data])
}

// ---------- 页面快照（增量链存储） ----------

// 自动快照间隔：活跃编辑期间约 5 分钟一个版本；下方 SQL 里写死 interval '5 minutes'
// 与此对应，改要两处同步
export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60_000
// 每 100 条快照插一条全量行（is_base）。物化要从全量行起顺序回放，没有检查点读成本会随历史无限增长；
// 回放 100 条小增量在毫秒级，全量行只占约 1% 存储。版本本身永不删除。
export const CHECKPOINT_EVERY = 100

// 间隔去重只看用户自己的 auto 快照。AI 那条不算：过程页刚归档完，人马上改一行，
// 不该被“5 分钟内已有一条”吞掉。created_at 是 now()::text，比较必须显式 ::timestamptz
const SELECT_RECENT_AUTO_SNAPSHOT = `SELECT 1 FROM page_snapshots
  WHERE page_id = $1 AND origin = 'auto' AND actor = 'user'
    AND created_at::timestamptz >= now() - interval '5 minutes'
  LIMIT 1`
const SELECT_ANY_SNAPSHOT = 'SELECT 1 FROM page_snapshots WHERE page_id = $1 LIMIT 1'
// created_at 单调化：Postgres now() 是事务开始时间，FOR UPDATE 上排队的并发写入，
// 后插者可能先 BEGIN（now() 更早），直接用会让链序（created_at 序 = 物化应用序）倒挂：
// 增量落在其基准之前，缺的 struct 挂 pendingStructs 永远等不到，物化静默丢内容；
// 同微秒的两次事务同理撞成 tie（id 随机，排序不定）。所以与上一条 created_at 比较，
// 不严格大于则取上一条 +1µs，保证链上严格递增
const INSERT_SNAPSHOT = `INSERT INTO page_snapshots
  (id, page_id, title, origin, data, sv, author_id, created_at, is_base, actor, actor_agent)
  VALUES ($1, $2, $3, $4, $5, $6, $7,
    CASE WHEN $8::text IS NULL OR now()::text > $8::text THEN now()::text
         ELSE ($8::timestamptz + interval '1 microsecond')::text END,
    $9, $10, $11)
  RETURNING id, title, origin, created_at`
// 距最近检查点的条数（决定本条是否写成新的 base）：子查询取该页最新 base 的 created_at，
// 外层数其后的行，两段都走 (page_id, created_at) 索引且 ≤CHECKPOINT_EVERY 行，不是全表 count。
// 页内还没有 base（NULL）时外层退化成全行数，但那只可能是首行，调用方直接判 is_base=true
const COUNT_SINCE_BASE = `SELECT count(*)::int AS n FROM page_snapshots
  WHERE page_id = $1
    AND created_at > COALESCE((SELECT max(created_at) FROM page_snapshots WHERE page_id = $1 AND is_base), '')`
// 增量基准：该页最新一条快照。FOR UPDATE 已串行化同页写入，事务内读到的一定是已提交最新；
// sv 为 NULL 表示旧格式全量行，读时用 encodeStateVectorFromUpdate 从其 data 现算（恰好精确）
const SELECT_LATEST_SNAPSHOT = `SELECT id, title, origin, created_at, data, sv FROM page_snapshots
  WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`
// 存在性守卫 + 同页写入串行化：FOR UPDATE 排他锁把 pages 放在 page_snapshots 写锁之前
// （与删页事务的加锁顺序一致），并把同一页的并发插入（auto / 手动、多端同时触发）排队，
// 同时让 created_at 单调化的“读上一条 → 定序插入”成为原子操作。
// 不能用 FOR SHARE：两个事务可同时持有，链序（created_at）会因并发事务的 BEGIN 顺序倒挂。
// 页面被并发删除时返回空，跳过插入。
// 刻意用基表并显式判 deleted_at：要对基表行加锁（与删页事务同锁序），
// 同时让回收站里的页面不再产生新版本（内容冻结，历史不算被删）
const SELECT_PAGE_EXISTS = 'SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE'

// 快照列表项(手动快照 201 响应同形)
export type SnapshotRow = {
  id: string
  title: string
  origin: string
  created_at: string
}
// 链上基准行(该页最新一条):sv 为 NULL 即旧格式全量行
type ChainBaseRow = SnapshotRow & { data: Buffer; sv: Buffer | null }

// 这一批增量最后是谁写的。user = 登录用户；agent = 机器人客户端（context.actor，
// 密钥在升级时核过，见 index.ts）。onChange 每次覆盖；文档卸载后随实例回收。
export type EditorMark = { userId: string | null; kind: 'user' | 'agent'; agent: string | null }
const lastEditor = new WeakMap<Y.Doc, EditorMark>()

export function noteEditor(doc: Y.Doc, mark: EditorMark): void {
  lastEditor.set(doc, mark)
}

// 快照标题:与 Editor.tsx 的标题展示同语义 —— 每段取文本,多段以空格连接
export function extractTitle(doc: Y.Doc): string {
  const paragraphs: string[] = []
  doc.getXmlFragment('title').forEach((child) => {
    if (child instanceof Y.XmlElement) {
      const parts: string[] = []
      child.forEach((inner) => {
        if (inner instanceof Y.XmlText) parts.push(inner.toString())
      })
      paragraphs.push(parts.join(''))
    } else {
      paragraphs.push(child.toString())
    }
  })
  return paragraphs.join(' ')
}

/** extractTitle 的逆操作：服务端改标题片段（结构同 newPageDoc：title > paragraph > XmlText）。
 *  已有段落就改它的文字，多余的段落删掉；文字没变不写（不产生空增量）。
 *  要记到谁名下由调用方决定：放在 doc.transact(…, origin) 里调用，嵌套的 transact 并进外层事务 */
export function setDocTitle(doc: Y.Doc, title: string): void {
  const fragment = doc.getXmlFragment('title')
  doc.transact(() => {
    let paragraph = fragment.get(0)
    if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== 'paragraph') {
      paragraph = new Y.XmlElement('paragraph')
      fragment.insert(0, [paragraph])
    }
    if (fragment.length > 1) fragment.delete(1, fragment.length - 1)
    const only = paragraph.length === 1 ? paragraph.get(0) : undefined
    if (only instanceof Y.XmlText) {
      // 只有一段无格式的文字且就是它：不动
      const delta = only.toDelta() as { insert?: unknown; attributes?: unknown }[]
      const same = title === '' ? delta.length === 0 : delta.length === 1 && delta[0]!.insert === title && !delta[0]!.attributes
      if (same) return
      only.delete(0, only.length)
      if (title) only.insert(0, title)
      return
    }
    if (paragraph.length > 0) paragraph.delete(0, paragraph.length)
    const text = new Y.XmlText()
    paragraph.insert(0, [text])
    if (title) text.insert(0, title)
  })
}

// 空增量判定：encodeStateAsUpdate 的“零差异”结果不是 0 字节，而是只剩两个头字节
// （[clients=0][deletes=0]，yjs 13.6 下如此），解出来无 structs 且无 deletes。纯删除等真变更
// 会带 structs 或 delete ranges，不会误判。byteLength === 0 仅防御性短路
function isEmptyUpdate(update: Uint8Array): boolean {
  if (update.byteLength === 0) return true
  const { structs, ds } = Y.decodeUpdate(update)
  return structs.length === 0 && ds.clients.size === 0
}

// 插入快照（auto 与手动共用）。版本只增不删；有界读靠周期性全量检查点：
// 该页首条存全量（锚点），此后每 CHECKPOINT_EVERY 条再存一条全量（is_base），其余存相对
// 上一条状态向量的增量。读路径（物化 / 更新流水）从“≤ 目标行的最近 base”起回放，行数 ≤ 检查点间隔。
// 与最新快照零差异（空增量，如手抖连点保存）不插行，返回现有最新行；增量非空但标题与读得见的内容
// 都与最新快照相同（改了又撤销）同样不算一个版本，否则历史与更新流水里会多出一条什么都没改的“编辑了”。
// authorId：登录用户（auto 是最后编辑者的会话，manual 是触发用户），老行 / 未知为 NULL。
// actor：这批字是用户打的还是 AI 写的。actorAgent 是 catalog id，仅 actor=agent 时有意义。
// 页面已不存在（删页竞态）返回 null
export async function insertSnapshot(
  pool: Pool,
  pageId: string,
  title: string,
  origin: 'auto' | 'manual',
  doc: Y.Doc,
  authorId: string | null = null,
  actor: 'user' | 'agent' = 'user',
  actorAgent: string | null = null,
): Promise<SnapshotRow | null> {
  return withTransaction(pool, async (client) => {
    const exists = await client.query(SELECT_PAGE_EXISTS, [pageId])
    if (exists.rows.length === 0) return null
    const prev = (await client.query<ChainBaseRow>(SELECT_LATEST_SNAPSHOT, [pageId])).rows[0]
    // 增量基准：上一条快照的状态向量。旧格式全量行没有 sv，从其 update 现算，
    // 结果等价于存快照那刻的 Y.encodeStateVector；新行必有 sv，直接用
    const svPrev = prev ? (prev.sv ?? Y.encodeStateVectorFromUpdate(prev.data)) : null
    // 相对上一条的增量，首行没有基准（走全量）
    const delta = svPrev ? Buffer.from(Y.encodeStateAsUpdate(doc, svPrev)) : null
    // 无实际变更：跳过插入，返回现有最新行（不能把带 data / sv 的整行透传给调用方，
    // 201 响应契约只有列表项四字段）。不插行时链不受影响：下一条的增量仍相对这条最新快照算
    const unchanged = prev ? { id: prev.id, title: prev.title, origin: prev.origin, created_at: prev.created_at } : null
    if (delta && isEmptyUpdate(delta)) return unchanged
    // 增量非空不等于改了内容：改了又撤销会留下新插入 + 删除的 struct。还原上一版（≤ 检查点间隔条回放，
    // 毫秒级）比读得见的内容；标题不同就是真改了，不必回放
    if (prev && prev.title === title) {
      const before = await materializeSnapshot(client, pageId, prev.id)
      if (before && contentKey(before) === contentKey(doc)) return unchanged
    }
    const sv = Buffer.from(Y.encodeStateVector(doc))
    // 检查点判定：首行必为 base；此后每 CHECKPOINT_EVERY 行再写一条全量。计数只扫最近一个
    // 检查点之后的行（≤ 间隔），常数级；prev 为 null 即本页首行。base 的下标恒为间隔的整数倍，
    // 所以判据是 base 之后已有 CHECKPOINT_EVERY-1 行，即本条落在下一个整数倍上
    let isBase = true
    if (prev) {
      const since = await client.query<{ n: number }>(COUNT_SINCE_BASE, [pageId])
      isBase = (since.rows[0]?.n ?? 0) >= CHECKPOINT_EVERY - 1
    }
    // 检查点行必须是全量：读路径把它当链条的新根（从它起 apply），写增量就等于链条断了
    const data = isBase ? Buffer.from(Y.encodeStateAsUpdate(doc)) : delta!
    const kind = actor === 'agent' ? 'agent' : 'user'
    const { rows } = await client.query<SnapshotRow>(INSERT_SNAPSHOT, [
      crypto.randomUUID(),
      pageId,
      title,
      origin,
      data,
      sv,
      authorId,
      // 链序保证：新行的 created_at 不早于上一条（见 INSERT_SNAPSHOT 的注释）
      prev?.created_at ?? null,
      isBase,
      kind,
      kind === 'agent' ? actorAgent : null,
    ])
    return rows[0]!
  })
}

// 自动存版：用户连着改，5 分钟内只留一条。AI 写入不并进这一条，
// 否则回复落在用户刚存的版本后面，这一轮在历史和编辑记录里就消失了。
// 是否“真有变更”由 onStoreDocument 调用方把关；空增量 / 内容没变仍由 insertSnapshot 丢掉。
// 刚建的页面（还没有任何版本、正文空着）不记：一打开客户端就会写空段落 / 块 id，记下来是一条空版本，
// 还会占掉 5 分钟去重窗口，让随后真正写的内容晚 5 分钟才进历史。首个版本从第一次写出内容起算。
// control:global 等解析不出 page id 的文档名直接 no-op。
// 快照是尽力而为的后台任务：页面被并发删除、连接池已关闭等竞态下失败只记日志，
// 不能把异常顶给 Hocuspocus 的钩子（会变成 unhandled rejection 拖崩进程）
export async function maybeAutoSnapshot(pool: Pool, docName: string, doc: Y.Doc): Promise<void> {
  const pageId = PAGE_DOC_NAME.exec(docName)?.[1]
  if (!pageId) return
  try {
    const mark = lastEditor.get(doc) ?? null
    if (mark?.kind !== 'agent') {
      const recent = await pool.query(SELECT_RECENT_AUTO_SNAPSHOT, [pageId])
      if (recent.rows.length > 0) return
    }
    if (isBlankPage(doc) && (await pool.query(SELECT_ANY_SNAPSHOT, [pageId])).rows.length === 0) return
    await insertSnapshot(
      pool,
      pageId,
      extractTitle(doc),
      'auto',
      doc,
      mark?.userId ?? null,
      mark?.kind ?? 'user',
      mark?.agent ?? null,
    )
  } catch (err) {
    console.error(`自动快照失败(${docName}):`, err)
  }
}

// 正文纯文本索引：onStoreDocument 时把正文 fragment 的文字抽取出来写入 content_text。
// 走 updates.textOf（XmlText 文字，忽略节点属性）而不是 fragment.toString()：
// 后者会把节点序列化成 markup（id / pageId / title / icon 等属性全进索引），搜索结果与 AI 上下文
// 里就会冒出 <page_ref icon=...> 这类标签噪声。老数据无回填，该页首次存储即覆盖。
// 删除 / 回收页不主动清：回收页从 live_pages 消失，搜索天然打不中。
// content_updated_at 只在文字真变了时前移（每次存储都会跑到这里，光改属性 / 光标同步不算编辑）
const UPDATE_CONTENT_TEXT = `UPDATE pages SET content_text = $2,
  content_updated_at = CASE WHEN content_text IS DISTINCT FROM $2 THEN now()::text ELSE content_updated_at END
  WHERE id = $1`
const SELECT_RUN_RECORD = `SELECT p.kind, r.record FROM pages p
  LEFT JOIN runs r ON r.page_id = p.id WHERE p.id = $1`
// 同快照，尽力而为的后台任务：页面被并发删除等竞态下失败只记日志
export async function syncContentText(pool: Pool, docName: string, doc: Y.Doc): Promise<void> {
  const pageId = PAGE_DOC_NAME.exec(docName)?.[1]
  if (!pageId) return
  try {
    let text = textOf(doc.getXmlFragment('prosemirror'))
    // 过程页：步骤是正文里的块（文字已在 text 里），最终输出在 record 里，与归档时同一个口径（run-doc.ts 的 runSearchText）
    const row = (await pool.query<{ kind: string; record: unknown }>(SELECT_RUN_RECORD, [pageId])).rows[0]
    if (row?.kind === 'run') text = runSearchText(text, row.record)
    await pool.query(UPDATE_CONTENT_TEXT, [pageId, text])
  } catch (err) {
    console.error(`正文索引失败(${docName}):`, err)
  }
}

/** 存页面时顺带刷新两份从正文派生的东西：反向链接索引与收藏存档。同样尽力而为（失败只记日志）；
 *  两个模块都不依赖本文件（避免循环引用），文档与标题由这里给 */
async function syncDerivedFromBody(pool: Pool, docName: string, doc: Y.Doc): Promise<void> {
  const pageId = PAGE_DOC_NAME.exec(docName)?.[1]
  if (!pageId) return
  const body = doc.getXmlFragment('prosemirror')
  try {
    await syncPageLinks(pool, pageId, body)
    await refreshFavoriteArchives(pool, pageId, body, extractTitle(doc))
  } catch (err) {
    console.error(`派生索引失败(${docName}):`, err)
  }
}

// 链式物化：增量只含相对上一条新建的 struct，必须从某个全量行（is_base）起顺序 apply，
// 缺基准的 update 会挂 pendingStructs 且不会凭空补齐，起点选错就静默丢内容。
// 起点是 created_at ≤ 目标行的最近 base：读行数 ≤ CHECKPOINT_EVERY + 1，与历史长度无关
// （版本永不删除，读成本不能随历史线性涨）。首行必为 base，存量库由迁移回填，
// 所以正常页必有 base；万一没有（极端脏数据）退化成从链首开始，结果仍正确。
// 旧格式全量行夹在链中当增量 apply 幂等无害。目标不在链上（不存在 / 他页快照）返回 null（路由 404）
export async function materializeSnapshot(
  pool: Pool | PoolClient,
  pageId: string,
  snapshotId: string,
): Promise<Y.Doc | null> {
  const { rows } = await pool.query<{ id: string; data: Buffer }>(
    `WITH t AS (SELECT created_at AS at FROM page_snapshots WHERE id = $2 AND page_id = $1),
          b AS (SELECT max(p.created_at) AS at FROM page_snapshots p, t
                WHERE p.page_id = $1 AND p.is_base AND p.created_at <= t.at)
     SELECT s.id, s.data FROM page_snapshots s, t, b
     WHERE s.page_id = $1 AND s.created_at <= t.at AND s.created_at >= COALESCE(b.at, '')
     ORDER BY s.created_at ASC, s.id ASC`,
    [pageId, snapshotId],
  )
  const doc = new Y.Doc()
  for (const row of rows) {
    Y.applyUpdate(doc, row.data)
    if (row.id === snapshotId) return doc
  }
  return null
}

// 从 DB 重建文档当前全量状态（快照 + 按 seq 重放增量，与 onLoadDocument 同构）。
// 内存无活文档时（服务器重启后 REST 取内容）用；标题播种同 onLoadDocument：
// fragment 为空时从 pages.title 补，保证旧页快照标题不丢
export async function loadDocFromDb(pool: Pool, docName: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const snap = await pool.query<{ state: Buffer }>(GET_SNAPSHOT, [docName])
  if (snap.rows[0]) Y.applyUpdate(doc, snap.rows[0].state)
  const replay = await pool.query<{ data: Buffer }>(REPLAY_UPDATES, [docName])
  for (const row of replay.rows) Y.applyUpdate(doc, row.data)
  const title = doc.getXmlFragment('title')
  const pageId = PAGE_DOC_NAME.exec(docName)?.[1]
  if (title.length === 0 && pageId) {
    const row = await pool.query<{ title: string }>(SELECT_PAGE_TITLE, [pageId])
    const seed = row.rows[0]?.title ?? ''
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    if (seed) text.insert(0, seed)
    paragraph.insert(0, [text])
    title.insert(0, [paragraph])
  }
  return doc
}

/** 读页面内容的口径：内存有活文档就用那份（协同中的最新状态），否则从 DB 重建。
 *  AI 的 read_page 与 edit_page 必须看到同一份文档，否则读到一段原文、拿它做 old，
 *  会在还没落盘的活文档上对不上。测试可不传 getLiveDoc，走 DB 重建分支。 */
export async function loadDocForRead(
  pool: Pool,
  docName: string,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
): Promise<Y.Doc> {
  return getLiveDoc?.(docName) ?? (await loadDocFromDb(pool, docName))
}

/** 把一个内存 Y.Doc 的全量状态写成该文档的唯一事实（快照行 + 清空增量表）。
 * 用于服务端凭空建一份文档（agent 过程归档，见 agents/runs.ts）：那时文档不可能有活连接，
 * 所以先写内容、再让页面可被发现是唯一没有竞态的顺序。 */
export async function writeDocState(pool: Pool, docName: string, doc: Y.Doc): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(PUT_SNAPSHOT, [docName, Buffer.from(Y.encodeStateAsUpdate(doc))])
    await client.query(DELETE_UPDATES, [docName])
  })
}

/** 在一个可落盘的文档会话里应用一次写入，唯一实现是下面的 createDocWriter。
 *  `user` 是发起者（过可见性闸门、快照归属）；`apply` 收到 doc 与 Yjs 事务 origin，
 *  origin 必须原样交给 doc.transact，collab 的 onChange 才认得出这次写入是谁写的
 *  （AI 写入要记成 agent，不进用户 5 分钟快照去重）。 */
export type DocWriter = (
  docName: string,
  user: { id: string; role: string },
  apply: (doc: Y.Doc, origin: unknown) => void,
  /** 这次写入记给谁：缺省 agent（AI 工具写文档）；用户自己的操作（导入 skill）传 'user' */
  as?: 'user' | 'agent',
) => Promise<void>

/** DocWriter 的唯一实现：hocuspocus 的直连会话，即协同编辑那条钩子链的入口。
 *  openDirectConnection 会触发 onLoadDocument（内存有活文档直接用，没有就加载），
 *  transact 里的写入触发 onChange（增量落 yjs_updates）与 onStoreDocument（压缩 / 快照 / 正文索引），
 *  并把增量广播给在线的协同者；写完必须 disconnect() 释放直连计数，否则文档不 unload。
 *  origin 与浏览器连接同形（含 context.user / actor），collab 的 onChange 从 context 取归属，
 *  所以这次写入记成 agent 而不是用户手改，与浏览器编辑走同一条归属规则。 */
export function createDocWriter(instance: () => Hocuspocus): DocWriter {
  return async (docName, user, apply, as = 'agent') => {
    const origin = { context: { user, actor: as === 'agent' ? { kind: 'agent', agent: null } : undefined } }
    const connection = await instance().openDirectConnection(docName, origin.context)
    try {
      await connection.transact((doc) => apply(doc, origin))
    } finally {
      await connection.disconnect()
    }
  }
}

// 纯信令文档：挂在 Hocuspocus 实例上做全局广播，无任何内容，已认证即放行
const CONTROL_DOC_NAME = 'control:global'

// 树 / 空间变更通知：向 control:global 的所有连接广播 'changed'（客户端以此触发刷新）。
// 没人连 control:global 时 documents 里没有该文档，静默跳过；fire and forget，
// broadcastStateless 是同步 void，广播失败不阻断路由主流程
export function notifyPagesChanged(hocuspocus: Hocuspocus): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless('changed')
}

// agent 目录变更通知（'agents'）：catalog 是本机 agents 配置加在线 connector 上报的 agents，
// 所以 connector 上线 / 下线都会改它（本机配置要改得重启进程，不在广播范围）。客户端据此丢掉
// 目录缓存重拉，否则连上 connector 却看不到 agent，刷新网页才出现
export function notifyAgentsChanged(hocuspocus: Hocuspocus): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless('agents')
}

// 收件箱里有东西可能变了（审批出现 / 结束、回合开始 / 结束、使用申请、授权首次使用、机器接入 / 批准 / 拒绝 / 撤销）：
// 客户端据此去重拉 GET /api/inbox。广播是全员的，所以消息不带任何内容（没有 pageId / userId），拉到什么由服务端按各人的权限算
export function notifyInboxChanged(hocuspocus: Hocuspocus): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless('inbox')
}

// 空间公共记忆变了（添加 / 删除）：客户端据此重拉记忆面板。广播是全员的，所以不带任何内容（没有 spaceId / 记忆文字），
// 拉到什么由 GET /api/spaces/:id/memories 按各人的权限算
export function notifyMemoriesChanged(hocuspocus: Hocuspocus): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless('memories')
}

// 目录树结构变了（目录 / 挂载增删改、挂着的页面被恢复）：客户端据此只重拉目录树列表。
// 单独一个事件，页面写（'changed'）不连带重拉目录树，同样不带内容
export function notifyBoardsChanged(hocuspocus: Hocuspocus): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless('boards')
}

// 端口预览的共享列表变了（共享 / 停止 / 授权收回）：客户端据此重拉这一页的预览列表。
// payload 形如 `previews:<pageId>`，控制信道上所有在线客户端都会收到，只带页面 id，不带任何内容
export function notifyPreviewsChanged(hocuspocus: Hocuspocus, pageId: string): void {
  hocuspocus.documents.get(CONTROL_DOC_NAME)?.broadcastStateless(`previews:${pageId}`)
}

// doc 名只认 page:<uuid>；crypto.randomUUID 产出即全小写，不用大小写兼容（集合的投影器同用这一条）
export const PAGE_DOC_NAME = /^page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

// 页面访问角色，REST 与 ws 共用这一处判定。不存在和非成员都返回 null（不泄露存在性），
// 成员给实际角色 owner | member | viewer，全局 admin 也不例外。
// 入参只要 id + role：AI 凭证（page-read.ts）解出的用户没有 username 那一套，却要走同一条闸
export async function pageAccess(
  pool: Pool,
  pageId: string,
  user: { id: string; role: string },
): Promise<'owner' | 'member' | 'viewer' | null> {
  const { rows } = await pool.query<{ role: 'owner' | 'member' | 'viewer' | null }>(GET_PAGE_ACCESS, [
    pageId,
    user.id,
  ])
  const row = rows[0]
  if (!row) return null // 页面不存在（JOIN 打不上）
  return row.role
}

// 每个 Hocuspocus 实例在途的增量落库。客户端（含机器人客户端）收到同步确认时，onChange 里的写库可能还没完成：
// 关停必须等它们落完再返回（drainDocWrites），否则「回复刚写进文档就关停」时最后一笔增量可能没进库
const docWrites = new WeakMap<Hocuspocus, Set<Promise<unknown>>>()

/** 等这个实例当前在途的增量写库全部结束（成功或失败都算结束）。关停时在 hocuspocus.destroy 之后调 */
export async function drainDocWrites(hocuspocus: Hocuspocus): Promise<void> {
  const pending = docWrites.get(hocuspocus)
  while (pending && pending.size > 0) await Promise.allSettled([...pending])
}

/** extensions：额外的 Hocuspocus 扩展（集合的属性投影器，见 collections/projector.ts）。扩展的钩子排在下面这些
 *  配置钩子之前跑，所以要「文档已加载完」的扩展用 afterLoadDocument，不用 onLoadDocument */
export function createHocuspocus(pool: Pool, extensions: Extension[] = []): Hocuspocus {
  let hub: Hocuspocus | undefined
  const pending = new Set<Promise<unknown>>()
  /** 追加增量并登记为在途（drainDocWrites 等的就是这些） */
  const append = (documentName: string, update: Uint8Array): Promise<unknown> => {
    const write = pool.query(APPEND_UPDATE, [documentName, Buffer.from(update)])
    pending.add(write)
    const done = (): void => {
      pending.delete(write)
    }
    write.then(done, done)
    return write
  }
  // 只对真有变更的文档做自动快照：onChange 才置脏，纯打开 / 关闭不产生版本。
  // WeakSet 按 Y.Doc 实例跟踪，文档 unload 后实例被回收，无需清理
  const dirtyDocs = new WeakSet<Y.Doc>()
  hub = new Hocuspocus({
    // 传副本：Hocuspocus 会就地排序并把下面的配置钩子 push 进这个数组
    extensions: [...extensions],
    // v2.15 里每条文档增量的钩子是 onChange（payload.update 即原始增量），
    // awareness 走 onAwarenessUpdate，不会混进这张表。
    // payload.context 是触发增量那条连接的 context。
    // user 是编辑者会话；actor 只有机器人客户端会带（升级时核过密钥）。记下来供快照归属。
    async onChange({ document, documentName, update, context }) {
      dirtyDocs.add(document)
      const ctx = context as { user?: AuthUser; actor?: { kind?: string; agent?: string | null } }
      if (ctx.user) {
        const kind = ctx.actor?.kind === 'agent' ? 'agent' : 'user'
        noteEditor(document, {
          userId: ctx.user.id,
          kind,
          agent: kind === 'agent' ? (ctx.actor?.agent ?? null) : null,
        })
      }
      await append(documentName, update)
    },
    async onConnect(payload: onConnectPayload) {
      // 连接闸：首条消息触发（此时才带 doc 名），非成员 / 页面不存在一律拒连（4403）；
      // viewer 把 connection.readOnly 置真，Hocuspocus 在只读连接上直接丢弃客户端
      // 的 SyncStep2 / Update，无需自己拦 onChange。payload 是浅拷贝，
      // 但 connection 对象是共享引用，改它才传得到后续 createConnection。
      // control:global 无内容、无归属概念，已认证即放行
      const user = (payload.context as { user?: AuthUser }).user
      if (!user) throw new Error('unauthorized')
      if (payload.documentName === CONTROL_DOC_NAME) return
      const pageId = PAGE_DOC_NAME.exec(payload.documentName)?.[1]
      if (!pageId) throw new Error('unauthorized')
      const role = await pageAccess(pool, pageId, user)
      if (!role) throw new Error('forbidden')
      // 过程页也是协同文档（正文在归档时落好）：成员可改，viewer 只读，与普通页面同一条闸
      if (role === 'viewer') payload.connection.readOnly = true
    },
    async onLoadDocument({ context, document, documentName }) {
      // 归属校验是内容下发的总闸：未认证 context、doc 名不合规、页面不存在、
      // 非成员（任意角色皆放行，viewer 降级到 onConnect 里做只读），
      // 一律抛错，Hocuspocus 会随之断开该连接（4403）。
      // control:global 没有可加载的内容，已认证即放行
      const user = (context as { user?: AuthUser }).user
      if (!user) throw new Error('unauthorized')
      if (documentName === CONTROL_DOC_NAME) return
      const pageId = PAGE_DOC_NAME.exec(documentName)?.[1]
      if (!pageId) throw new Error('unauthorized')
      const role = await pageAccess(pool, pageId, user)
      if (!role) throw new Error('forbidden')
      // 加载 = 快照 + 按 seq 重放增量；旧库只有快照行时增量表为空，天然兼容
      const snap = await pool.query<{ state: Buffer }>(GET_SNAPSHOT, [documentName])
      if (snap.rows[0]) Y.applyUpdate(document, snap.rows[0].state)
      const replay = await pool.query<{ data: Buffer }>(REPLAY_UPDATES, [documentName])
      for (const row of replay.rows) Y.applyUpdate(document, row.data)
      // 标题播种：旧页面（增量里只有正文）首次打开时把 DB title 补进 'title' fragment，
      // 只在 fragment 为空时播（幂等，后续加载不再重复）；新建页 title 为空，播一个
      // 空段落，保证 PM doc 合法。结构 paragraph > text，与 milkdown 标题绑定同构。
      // 播种必须落进 yjs_updates：只播在内存的话，文档一 unload 种子就丢，下次加载会
      // 用新 clientID 再长出一颗同文本段落，而客户端 IDB 缓存还留着上一颗，CRDT 合并
      // 即成双排标题。落链后重放是同一颗 struct，天然幂等；一旦有人编辑标题，
      // 走正常增量持久化
      const title = document.getXmlFragment('title')
      if (title.length === 0) {
        const row = await pool.query<{ title: string }>(SELECT_PAGE_TITLE, [pageId])
        const seed = row.rows[0]?.title ?? ''
        const seedDoc = new Y.Doc()
        const paragraph = new Y.XmlElement('paragraph')
        const text = new Y.XmlText()
        if (seed) text.insert(0, seed)
        paragraph.insert(0, [text])
        seedDoc.getXmlFragment('title').insert(0, [paragraph])
        const update = Y.encodeStateAsUpdate(seedDoc)
        Y.applyUpdate(document, update)
        await append(documentName, update)
      }
      // 上次编辑采集挂在加载完之后：上面的加载 / 播种都没有 context，本就不算编辑
      trackEdits(document)
    },
    async onStoreDocument({ document, documentName }) {
      // 压缩时机：复用 Hocuspocus 自带 debounce，增量攒够阈值才合并快照并清增量，否则 no-op。
      // 页面行已物理删除则直接跳过：PUT_SNAPSHOT 无外键，压缩会把 purge 清掉的 yjs 两表复活
      if (documentName.startsWith('page:') && !(await pool.query('SELECT 1 FROM pages WHERE id = $1', [documentName.slice(5)])).rows[0]) {
        return
      }
      const count = await pool.query<{ n: number }>(COUNT_UPDATES, [documentName])
      if ((count.rows[0]?.n ?? 0) >= COMPACT_THRESHOLD) {
        // 写快照与删已合并增量是两步写，必须同一事务
        await withTransaction(pool, async (client) => {
          await client.query(PUT_SNAPSHOT, [documentName, Buffer.from(Y.encodeStateAsUpdate(document))])
          await client.query(DELETE_UPDATES, [documentName])
        })
      }
      // 自动快照：与压缩同挂本钩子的 debounce（改动停止约 2s 或断连才触发），天然满足有变更才存；
      // 用户编辑 5 分钟去重，AI 写入另存一条。control:global 等 no-op（见 maybeAutoSnapshot）
      if (dirtyDocs.has(document)) {
        await maybeAutoSnapshot(pool, documentName, document)
        // AI 回复块没了 → 它的过程页一起删。挂在存储钩子上：改动停约 2s 或断连才跑，
        // 这段里撤销会把块加回来，不会误删
        const pageId = PAGE_DOC_NAME.exec(documentName)?.[1]
        if (pageId && hub) {
          try {
            const removed = await reapUnreferencedRuns(pool, pageId, document)
            if (removed.length > 0) notifyPagesChanged(hub)
          } catch (err) {
            console.error(`清理过程页失败(${documentName}):`, err)
          }
          // “集合”块没了，它拥有的内联集合进回收站；块回来则恢复（同一个时机，理由同上；自己接住错误）
          const h = hub
          await syncInlineCollections(pool, pageId, document, () => notifyPagesChanged(h))
        }
      }
      // 上次编辑（整页 + 每块）落库，同样挂本钩子；control:global 等非页面文档没有采集，天然跳过
      const editedPage = PAGE_DOC_NAME.exec(documentName)?.[1]
      if (editedPage) await flushEditMarks(pool, editedPage, document)
      // 正文纯文本入 content_text（搜索用），同样挂本钩子；失败只记日志，不顶给 Hocuspocus
      await syncContentText(pool, documentName, document)
      await syncDerivedFromBody(pool, documentName, document)
    },
  })
  if (!hub) throw new Error('hocuspocus 未建好')
  docWrites.set(hub, pending)
  return hub
}
