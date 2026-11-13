// ---------- 来源：正文 @我（source = 'mention'） ----------
// 正文里 @成员是 user_mention 节点（attrs.userId），节点自己没有 id，所以按「块 + 被 @ 的人」记当前集合（page_mentions），
// 每次存盘（Hocuspocus 的 afterStoreDocument：这时这一批的「上次编辑」已经落库）拿文档里的集合与库里的做差：
//   新出现的一对 = 有人新 @ 了他 → 记一行（收件箱「正文里 @了你」）、按被 @ 的人的规则发一次事件；不见了的删掉（以后再加回来算新的）。
//   同一块里已有的 @ 再编辑不重复触发；同一块里 @ 同一个人几次只算一个。块 = 最深的可寻址块（shared/block-address），与块链接、上次编辑同一个口径。
// 谁 @ 的：那一块最后的编辑者（agent 写的记发起人）——还没落库的编辑先看内存里的（edit-marks.ts 的 pendingEditor），再看库里的。
//   一次存盘里同一块有几个人改过时归给最后那个人；被 @ 的人自己就是最后编辑者时不触发（宁可漏掉，也不替自己 @ 自己发通知）。
//   认不出编辑者的（导入、复制、模板建出来的页里本来就有的 @）记下但不触发。
// 不触发：自己 @ 自己（含自己的 agent 写的）、被 @ 的人看不到这一页、页面不是 doc。
// 上线时已经有的页（mention_baseline）第一次扫描只记底，不把存量的 @ 当新的补发。
// 存盘是热路径：文档里的集合在钩子里同步读出（之后文档可能卸载），落库与派发交给 hub.background，不挡存盘；
// 同一页的扫描排成一条链，前后两次存盘的差集不会交错写乱。尽力而为：失败只记日志，下一次存盘按文档重新对齐。

import type { Extension } from '@hocuspocus/server'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { isAddressable } from '@ramet/shared/block-address'
import { PAGE_DOC_NAME } from '../../collab.js'
import { withTransaction } from '../../db.js'
import { pendingEditor } from '../../edit-marks.js'
import { viewersAmong } from '../../page-visibility.js'
import { textOf } from '../../updates.js'
import { aiState, dormantReason, ensureBuiltin, mentionMatches } from '../builtin.js'
import type { TriggerHub } from '../hub.js'

/** 文档里的一对「块 + 被 @ 的人」；editor = 内存里还没落库的那一块的编辑者 */
export type MentionPair = { block: string; user: string; excerpt: string; editor: string | null }

export type MentionDeps = {
  pool: Pool
  hub: Pick<TriggerHub, 'emit' | 'causedBy' | 'background'>
  /** 收件箱刷新（多了「正文里 @了你」） */
  poke(): void
}

const EXCERPT_MAX = 300

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

function excerptOf(block: Y.XmlElement): string {
  const flat = textOf(block).replace(/\s+/g, ' ').trim()
  return [...flat].length > EXCERPT_MAX ? `${[...flat].slice(0, EXCERPT_MAX).join('')}…` : flat
}

/** 文档正文里的全部「块 + 被 @ 的人」（同步读，存盘钩子里调）。还没有 id 的块先不算：补上 id 之后的下一次存盘再认 */
export function collectMentions(doc: Y.Doc): MentionPair[] {
  const found = new Map<string, MentionPair>()
  const visit = (node: Y.XmlFragment | Y.XmlElement, name: string | null, block: Y.XmlElement | null): void => {
    node.forEach((child) => {
      if (!(child instanceof Y.XmlElement)) return
      const owner = isAddressable(child.nodeName, name) ? child : block
      if (child.nodeName !== 'user_mention') return visit(child, child.nodeName, owner)
      const user = attr(child, 'userId')
      const id = owner ? attr(owner, 'id') : ''
      if (!owner || !user || !id || found.has(`${id}\n${user}`)) return
      found.set(`${id}\n${user}`, { block: id, user, excerpt: excerptOf(owner), editor: pendingEditor(doc, owner)?.userId ?? null })
    })
  }
  visit(doc.getXmlFragment('prosemirror'), null, null)
  return [...found.values()]
}

type Added = { id: string; block_id: string; user_id: string; actor_id: string | null; excerpt: string }

// 正文里一个 @ 都没有：库里这一页的全删掉，底也记过了（以后加的都算新的）
const CLEAR = `WITH b AS (DELETE FROM mention_baseline WHERE page_id = $1) DELETE FROM page_mentions WHERE page_id = $1`
const DELETE_GONE = `DELETE FROM page_mentions WHERE page_id = $1
  AND (block_id, user_id) NOT IN (SELECT b, u FROM unnest($2::text[], $3::text[]) AS x(b, u))`
// 已有的不动（ON CONFLICT），只返回新出现的。被 @ 的人已经不在了（删号）不记。记底时不认编辑者
const INSERT_NEW = `INSERT INTO page_mentions (id, page_id, block_id, user_id, actor_id, excerpt)
  SELECT gen_random_uuid()::text, $1, x.b, x.u,
    CASE WHEN $6::boolean THEN NULL ELSE COALESCE(x.e, (SELECT em.user_id FROM edit_marks em WHERE em.page_id = $1 AND em.block_id = x.b)) END, x.t
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS x(b, u, e, t)
  WHERE EXISTS (SELECT 1 FROM users WHERE id = x.u)
  ON CONFLICT (page_id, block_id, user_id) DO NOTHING
  RETURNING id, block_id, user_id, actor_id, excerpt`

/** 库里的集合对齐到文档：返回这一页（活的 doc 页）与新出现的几对；不是活的 doc 页 = null */
async function record(pool: Pool, pageId: string, pairs: MentionPair[]): Promise<{ spaceId: string; title: string; added: Added[] } | null> {
  if (pairs.length === 0) {
    await pool.query(CLEAR, [pageId])
    return null
  }
  return withTransaction(pool, async (db) => {
    const page = (await db.query<{ kind: string; space_id: string | null; title: string }>('SELECT kind, space_id, title FROM live_pages WHERE id = $1', [pageId])).rows[0]
    if (!page?.space_id || page.kind !== 'doc') return null
    const baseline = ((await db.query('DELETE FROM mention_baseline WHERE page_id = $1', [pageId])).rowCount ?? 0) > 0
    const blocks = pairs.map((p) => p.block)
    const users = pairs.map((p) => p.user)
    await db.query(DELETE_GONE, [pageId, blocks, users])
    const { rows } = await db.query<Added>(INSERT_NEW, [pageId, blocks, users, pairs.map((p) => p.editor), pairs.map((p) => p.excerpt), baseline])
    return { spaceId: page.space_id, title: page.title, added: rows }
  })
}

/** 一次存盘之后：对齐集合，新 @ 到的人（不是自己 @ 自己、看得到这一页）各发一次事件 */
export async function mentionsChanged(deps: MentionDeps, pageId: string, pairs: MentionPair[]): Promise<void> {
  const { pool, hub } = deps
  const rec = await record(pool, pageId, pairs)
  const fresh = rec?.added.filter((r): r is Added & { actor_id: string } => !!r.actor_id && r.actor_id !== r.user_id) ?? []
  if (!rec || fresh.length === 0) return
  const viewers = new Set(await viewersAmong(pool, pageId, fresh.map((r) => r.user_id)))
  const found = fresh.filter((r) => viewers.has(r.user_id))
  if (found.length === 0) return
  deps.poke()
  const names = new Map(
    (await pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...new Set(found.map((r) => r.actor_id))]])).rows.map((r) => [
      r.id,
      r.username,
    ]),
  )
  const depth = hub.causedBy(pageId)
  for (const r of found) {
    const state = await aiState(pool, r.user_id)
    // 没配模型连接的人不必替他补内置规则（默认的叫 Genet 也用不了）；他以前就有的规则照常找出来
    if (state.connection) await ensureBuiltin(pool, r.user_id)
    await hub.emit({
      source: 'mention',
      key: `mention:${r.id}`,
      ownerId: r.user_id,
      actorId: r.actor_id,
      depth,
      payload: {
        actor: { id: r.actor_id, name: names.get(r.actor_id) ?? '已注销用户' },
        page: { id: pageId, title: rec.title },
        text: r.excerpt,
        extra: [
          ['所在块', r.block_id],
          ['链接', `/page/${pageId}?block=${r.block_id}`],
        ],
      },
      match: (rule) => !dormantReason(rule.actions, state) && mentionMatches(rule.config, rec.spaceId),
    })
  }
}

/** 挂在协同实例上的扩展（index.ts）。deps 惰性取：触发器在协同实例之后才建好 */
export function mentionWatch(deps: () => MentionDeps): Extension {
  const chains = new Map<string, Promise<void>>()
  return {
    async afterStoreDocument({ documentName, document }) {
      const pageId = PAGE_DOC_NAME.exec(documentName)?.[1]
      if (!pageId) return
      let pairs: MentionPair[]
      let d: MentionDeps
      try {
        pairs = collectMentions(document)
        d = deps()
      } catch (err) {
        console.error(`[mentions] 读正文提及失败(${documentName}):`, err)
        return
      }
      d.hub.background(() => {
        const next = (chains.get(pageId) ?? Promise.resolve())
          .then(() => mentionsChanged(d, pageId, pairs))
          .catch((err: unknown) => console.error(`[mentions] 正文提及落库 / 触发失败(${documentName}):`, err))
        chains.set(pageId, next)
        void next.finally(() => {
          if (chains.get(pageId) === next) chains.delete(pageId)
        })
        return next
      })
    },
  }
}
