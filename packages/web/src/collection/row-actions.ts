/* ---------- 行的动作（批量操作栏与行手柄菜单共用）：删除 / 挪到别的集合要先确认，确认文案与动画在这一处 ---------- */
import type { Page } from '../api'
import { COPY } from '../copy'
import type { CollectionHandle } from './collection-store'

const S = COPY.collection.select

/** 布局会变的动作包一层动画（表格的 flip 补位）；缺省直接执行 */
export type Animate = (run: () => void) => void
const now: Animate = (run) => run()

/** 能挪去的集合：本空间里别的集合 */
export function moveTargets(pages: readonly Page[] | null, handle: CollectionHandle, spaceId: string | null): Page[] {
  return (pages ?? []).filter((p) => p.kind === 'collection' && p.id !== handle.id && p.space_id === spaceId)
}

export function trashRowsConfirmed(handle: CollectionHandle, ids: string[], done: () => void, animate: Animate = now): void {
  if (!window.confirm(S.confirmRemove(ids.length))) return
  animate(() => {
    void handle.trashRows(ids)
    done()
  })
}

export function moveRowsConfirmed(handle: CollectionHandle, ids: string[], to: Page, done: () => void, animate: Animate = now): void {
  if (!window.confirm(S.confirmMove(ids.length, to.title || COPY.untitled))) return
  animate(() => {
    void handle.moveRowsTo(ids, to.id)
    done()
  })
}
