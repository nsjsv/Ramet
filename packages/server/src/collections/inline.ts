// ---------- 内联集合的生命周期：宿主正文的存储钩子是唯一执行者 ----------
// 内联集合归宿主正文里的「集合」块（collection_inline）所有：块从正文里消失，集合连同行进回收站；块回来，恢复。
// 只认「块从正文里消失 / 回来」这一件事，不碰任何回收 / 移动写路径：
//   · 侧栏 / agent / 目录树删的（trashed_by_block = false）块在也不替它恢复，块那边显示「集合在回收站」+ 恢复按钮
//   · 挪走的（parent_id 不再是这个宿主）不在候选里：原宿主删块不删它；新宿主的 ref_host 不是自己，也不会误删
//   · 引用了还不存在的集合（先插块、后建集合的中间态）不在候选里，忽略
//   · 块带走的回收被别的路径恢复了（回收站手动恢复 / 宿主回收再恢复）：块不在也不再回收，只解除所有权
// 挂在 collab.ts onStoreDocument 的脏文档分支（与 reapUnreferencedRuns 同位）：改动停约 2 秒或断连才跑，
// 这段里撤销把块加回来，不会误删。失败只记日志，不顶给 Hocuspocus。

import type { Pool } from 'pg'
import * as Y from 'yjs'
import { withTransaction } from '../db.js'
import { restorePageSubtree, TRASH_ENTRY_PREDICATE, trashPageSubtree } from '../page-trash.js'

// 候选：以这个宿主为父页的内联集合，活的或是回收站条目根（随宿主一起进回收站的不是条目，不归钩子管）
const SELECT_CANDIDATES = `SELECT p.id, c.ref_host, c.trashed_by_block, (p.deleted_at IS NOT NULL) AS trashed
  FROM collections c JOIN pages p ON p.id = c.page_id
  WHERE c.inline AND p.parent_id = $1 AND p.kind = 'collection'
    AND (p.deleted_at IS NULL OR (${TRASH_ENTRY_PREDICATE}))`
const SET_SEEN = 'UPDATE collections SET ref_host = $2, trashed_by_block = false WHERE page_id = $1'
const MARK_TRASHED_BY_BLOCK = 'UPDATE collections SET trashed_by_block = true WHERE page_id = $1'
// 被别的路径从「块带走的回收」里救回来了：不再算块拥有，成了宿主下的普通子集合
const RELEASE = 'UPDATE collections SET ref_host = NULL, trashed_by_block = false WHERE page_id = $1'

type Candidate = { id: string; ref_host: string | null; trashed_by_block: boolean; trashed: boolean }

/** 正文里所有「集合」块引用的集合 id（任意深度：分栏、折叠块、引用块里的也算）。链接视图块不算，它不拥有数据 */
export function referencedInlineCollections(body: Y.XmlFragment): Set<string> {
  const ids = new Set<string>()
  for (const node of body.createTreeWalker((el) => el instanceof Y.XmlElement && el.nodeName === 'collection_inline')) {
    const id: unknown = (node as Y.XmlElement).getAttribute('collectionId')
    if (typeof id === 'string' && id) ids.add(id)
  }
  return ids
}

/** 宿主 hostId 存储时对齐它名下的内联集合。有集合进出回收站就调 notify（广播 changed） */
export async function syncInlineCollections(pool: Pool, hostId: string, doc: Y.Doc, notify: () => void): Promise<void> {
  try {
    const candidates = (await pool.query<Candidate>(SELECT_CANDIDATES, [hostId])).rows
    if (candidates.length === 0) return
    const referenced = referencedInlineCollections(doc.getXmlFragment('prosemirror'))
    let changed = false
    for (const c of candidates) {
      if (referenced.has(c.id)) {
        // 块在：记下宿主；是块消失才进的回收站就恢复。活着时也顺手清掉旧标记（别的路径恢复过它）
        const restore = c.trashed && c.trashed_by_block
        if (c.ref_host === hostId && !c.trashed_by_block) continue
        await withTransaction(pool, async (client) => {
          await client.query(SET_SEEN, [c.id, hostId])
          if (restore) await restorePageSubtree(client, c.id)
        })
        changed ||= restore
      } else if (!c.trashed && c.trashed_by_block) {
        // 是块带走的、现在却活着而块仍不在：有人从回收站手动恢复了它（或宿主被回收再恢复、把它一起带回来）。
        // 手动恢复就是要留下它：不再回收，只解除块的所有权；之后删它走侧栏，块再插回来会重新登记 ref_host
        await pool.query(RELEASE, [c.id])
      } else if (!c.trashed && c.ref_host === hostId) {
        // 块不在了，而它上一次就是在这个宿主里被看到的：连同行进回收站，记下是块带走的
        await withTransaction(pool, async (client) => {
          await trashPageSubtree(client, [c.id])
          await client.query(MARK_TRASHED_BY_BLOCK, [c.id])
        })
        changed = true
      }
    }
    if (changed) notify()
  } catch (err) {
    console.error(`[collections] 内联集合对齐失败(page:${hostId}):`, err)
  }
}
