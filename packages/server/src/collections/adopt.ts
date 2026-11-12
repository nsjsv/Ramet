// ---------- 页面经「改父页」进了合集：补成一行（PATCH /api/pages/:id 的 parent_id 与 agent 的 move_page 共用） ----------
// 改父页的写路径只改 parent_id；进了合集的页就是一行，行该有的样子在这里补上，与合集视图里「挪到别的合集」
// （routes/collections.ts 的 rows/move）同口径：
//   属性按目标的定义改写（transfer.ts 的 mapProps）：从别的合集来的按同名同类型对应、选项按名字换，对不上的丢；
//   本来不是行的页，只留目标认得的键（挪出去又挪回来的行，值还在）。不改写的话旧合集的属性 id 在这里没有意义，那几列看着就空了。
//   排到末尾、有编号属性就取号，副本由投影器当场落库，再交给「新增了一行」。
// 合集里只放普通页：集合 / 过程页 / skill 页挂进去，侧栏（集合是叶子）和视图（行只认 doc）里都找不到，由 intoCollectionError 先拦。

import type { Pool } from 'pg'
import { loadDocForRead } from '../collab.js'
import { adoptRow, readSchema, selectCollection, spaceMembers } from './store.js'
import { mapProps } from './transfer.js'
import { numbered, writeProps, type RowWriteDeps } from './write-row.js'

/** 能不能把这种页挂到 parentId 下：父页是合集而页不是普通页 = 原因；可以 = null */
export async function intoCollectionError(pool: Pool, pageKind: string, parentId: string | null): Promise<string | null> {
  if (parentId === null || pageKind === 'doc') return null
  return (await selectCollection(pool, parentId)) ? '合集里只能放普通页面（放进去就是一行）' : null
}

export type Adopt = {
  deps: RowWriteDeps
  /** 行进了合集：交给自动化「新增了一行」（不等它） */
  rowsAdded?: (collectionId: string, rowIds: readonly string[], actorId: string) => void
}

/** 页面已经改到 parentId 下之后调：parentId 是合集才补（不是合集 / 父页没变 = 什么都不做）。
 *  as = 属性改写记给谁（界面拖动 = 'user'，agent 挪 = 'agent'）。返回补没补（补了 = 位置已排在末尾，调用方别再按侧栏下标重排） */
export async function adoptIntoCollection(
  adopt: Adopt,
  user: { id: string; role: string },
  pageId: string,
  from: string | null,
  parentId: string | null,
  as: 'user' | 'agent',
): Promise<boolean> {
  if (parentId === null || parentId === from) return false
  const { pool, getLiveDoc } = adopt.deps
  const dest = await selectCollection(pool, parentId)
  if (!dest) return false
  const source = from ? await selectCollection(pool, from) : null
  const [destSchema, srcSchema, people] = await Promise.all([
    readSchema(pool, dest.id, getLiveDoc),
    source ? readSchema(pool, source.id, getLiveDoc) : null,
    spaceMembers(pool, dest.space_id),
  ])
  const doc = await loadDocForRead(pool, `page:${pageId}`, getLiveDoc)
  const values = mapProps(srcSchema ?? destSchema, destSchema, doc.getMap<unknown>('props').toJSON(), new Set(people.keys()))
  // 副本与位置、编号先在一个事务里落好（不等投影器：这一页的文档可能根本没被加载，没有投影器盯着它）
  if (!(await adoptRow(pool, dest.id, pageId, values, numbered(destSchema)))) return false
  await adopt.deps.write(
    `page:${pageId}`,
    user,
    (d, origin) => {
      const props = d.getMap<unknown>('props')
      d.transact(() => {
        for (const key of [...props.keys()]) if (!(key in values)) props.delete(key)
        writeProps(d, Object.entries(values))
      }, origin)
    },
    as,
  )
  await adopt.deps.projector.flushRow(pageId)
  adopt.rowsAdded?.(dest.id, [pageId], user.id)
  return true
}
