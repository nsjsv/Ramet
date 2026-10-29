// ---------- 过程归档:一轮 run → 一个 kind='run' 的子页面 ----------
// 页面是可编辑的协同文档:正文里每个步骤是一个 run_step 块（run-doc.ts），末尾留一个空段落给用户笔记。
// 不可变的 ACP 详情（工具输入输出 / diff / 子代理正文）只在 runs.record，按步骤的 sid 取。
// pages 行与普通页一样：留在侧栏树里、能拖能删、走回收站和彻底删除，runs 行随物理删级联。

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { appendDocUpdate, insertSnapshot } from '../collab.js'
import { withTransaction } from '../db.js'
import { textOf } from '../updates.js'
import { buildRunDoc, runSearchText, runTitle } from './run-doc.js'
import type { RunRecordV1 } from './run-record.js'

const INSERT_RUN_PAGE = `INSERT INTO pages (id, parent_id, owner_id, space_id, title, kind, content_text)
  VALUES ($1, $2, $3, $4, $5, 'run', $6)`
const INSERT_RUN = 'INSERT INTO runs (page_id, record) VALUES ($1, $2)'
const SELECT_PARENT = 'SELECT space_id, title FROM live_pages WHERE id = $1'

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
