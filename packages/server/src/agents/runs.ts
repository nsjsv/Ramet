// ---------- 过程归档:一轮 run → 一个 kind='run' 的子页面 ----------
// 页面是可编辑的协同文档:正文里每个步骤是一个 run_step 块（run-doc.ts），末尾留一个空段落给用户笔记。
// 不可变的详情（工具输入输出 / diff / 子代理正文）只在 runs.record，按步骤的 sid 取。
// pages 行与普通页一样：留在侧栏树里、能拖能删、走回收站和彻底删除，runs 行随物理删级联。

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { appendDocUpdate, insertSnapshot, pageAccess, type DocWriter } from '../collab.js'
import { withTransaction } from '../db.js'
import { textOf } from '../updates.js'
import { materialize } from './markdown.js'
import { buildRunDoc, runSearchText, runTitle, specOfEntry, stepBlock } from './run-doc.js'
import type { RunRecordV1 } from './run-record.js'

const INSERT_RUN_PAGE = `INSERT INTO pages (id, parent_id, owner_id, space_id, title, kind, content_text)
  VALUES ($1, $2, $3, $4, $5, 'run', $6)`
const INSERT_RUN = 'INSERT INTO runs (page_id, record) VALUES ($1, $2)'
const SELECT_PARENT = 'SELECT space_id, title FROM live_pages WHERE id = $1'
const SELECT_ARCHIVE = `SELECT r.record, p.owner_id FROM runs r JOIN live_pages p ON p.id = r.page_id
  WHERE r.page_id = $1 AND p.kind = 'run'`
const UPDATE_RUN = 'UPDATE runs SET record = $2 WHERE page_id = $1'

export type RunArchive = {
  /** 主文档页 id(归档页挂它下面,并继承它的空间归属) */
  parentId: string
  /** 发起这一轮的人 */
  ownerId: string
  record: RunRecordV1
}

/** 把一轮运行归档成一个可编辑子页面。返回新页 id 与刚建好的文档（收尾要用它算过程摘要，见 prompt-env.ts） */
export async function archiveRun(pool: Pool, input: RunArchive): Promise<{ id: string; doc: Y.Doc }> {
  const id = randomUUID()
  // 空间归属跟着主文档走（null = 孤儿页）
  const { rows } = await pool.query<{ space_id: string | null }>(SELECT_PARENT, [input.parentId])
  const doc = buildRunDoc(input.record)
  const update = Buffer.from(Y.encodeStateAsUpdate(doc))
  await withTransaction(pool, async (client) => {
    await client.query(INSERT_RUN_PAGE, [
      id,
      input.parentId,
      input.ownerId,
      rows[0]?.space_id ?? null,
      runTitle(input.record.startedAt),
      runSearchText(textOf(doc.getXmlFragment('prosemirror')), input.record),
    ])
    await client.query(INSERT_RUN, [id, JSON.stringify(input.record)])
    await appendDocUpdate(client, `page:${id}`, update)
  })
  // 过程页一出生就要有历史，这条时间线是 AI 写的。快照失败不能把已经建好的页变成归档失败
  try {
    await insertSnapshot(pool, id, runTitle(input.record.startedAt), 'auto', doc, input.ownerId, 'agent', input.record.agent || null)
  } catch (err) {
    console.error(`[runs] 过程页 ${id} 写入历史失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { id, doc }
}

/** 一个过程页的档案：record + 发起人（过程页的 owner_id，续跑据此判会话是不是自己的） */
export type RunArchiveRow = { id: string; record: RunRecordV1; ownerId: string | null }

/** 按 id 读档案（页面已删 / 在回收站 / 不是过程页 = null）。不判权限：认领回来的回合用，那里已按发起人重新判过机器授权 */
export async function readRunArchive(pool: Pool, runPageId: string): Promise<RunArchiveRow | null> {
  const { rows } = await pool.query<{ record: RunRecordV1; owner_id: string | null }>(SELECT_ARCHIVE, [runPageId])
  const row = rows[0]
  return row ? { id: runPageId, record: row.record, ownerId: row.owner_id } : null
}

/** 以某人的身份读档案：他读不到这个过程页（不是成员 / 已删）就当没有 */
export async function loadRunArchive(pool: Pool, runPageId: string, user: { id: string; role: string }): Promise<RunArchiveRow | null> {
  if (!runPageId || !(await pageAccess(pool, runPageId, user))) return null
  return readRunArchive(pool, runPageId)
}

/** 续跑收尾：同一个过程页接着记。record 换成合并后的整份；from 之后的条目（这一轮新增的，含收成说明的半截正文）
 *  落成步骤块，插在正文最后一个步骤之后（用户笔记留在末尾）。经 DocWriter 写：页面开着的人实时看到 */
export async function extendRun(
  pool: Pool,
  write: DocWriter,
  input: { runPageId: string; user: { id: string; role: string }; record: RunRecordV1; from: number },
): Promise<void> {
  await pool.query(UPDATE_RUN, [input.runPageId, JSON.stringify(input.record)])
  const blocks = input.record.entries.slice(input.from).map((entry, i) => stepBlock(specOfEntry(entry, input.from + i)))
  if (blocks.length === 0) return
  await write(`page:${input.runPageId}`, input.user, (doc, origin) => {
    doc.transact(() => {
      const body = doc.getXmlFragment('prosemirror')
      let at = 0
      body.forEach((c, i) => {
        if (c instanceof Y.XmlElement && c.nodeName === 'run_step') at = i + 1
      })
      materialize(body, blocks, at)
    }, origin)
  })
}
