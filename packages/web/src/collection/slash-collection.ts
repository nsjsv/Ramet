/* ---------- 斜杠菜单的「集合」与「链接视图」（editor/slash.ts 调） ----------
 * 「集合」（内联集合，块拥有数据）：客户端生成集合 id → 先插 collection_inline 块 → 再建集合
 * （POST /api/collections { id, inline: true, parent_id: 本页 }）。顺序不能反：服务端存储钩子只回收
 * 「建好之后、块从正文里消失」的集合，先插块不会被误删。建失败块画「新建集合失败」+ 删除此块。
 * 「链接视图」：从页面列表里挑本空间的集合（列举类，只看成员空间：页面列表本来就只有成员空间的页），插 collection_link；
 * viewId 留空，由块的 nodeView 补成第一个视图。 */
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Page } from '../api'
import { insertBlockAtCursor } from '../editor/block-insert'
import { COLLECTION_INLINE, COLLECTION_LINK } from '../editor/collection-block'
import { collectionApi } from './collection-api'
import { markCreated, markCreating } from './block-view'
import { openCollectionPicker } from './CollectionPicker'

type Actions = {
  pageId: string
  onChanged: () => void
  getSpaceId: () => string | undefined
  getPages?: () => readonly Page[] | null
}

export async function insertCollectionBlock(view: EditorView, actions: Actions): Promise<void> {
  const type = view.state.schema.nodes[COLLECTION_INLINE]
  const spaceId = actions.getSpaceId()
  if (!type || !spaceId) return
  const id = crypto.randomUUID()
  markCreating(id)
  insertBlockAtCursor(view, type.create({ collectionId: id, viewId: '', title: '' }))
  try {
    await collectionApi.create({ id, space_id: spaceId, parent_id: actions.pageId, inline: true, title: '' })
    actions.onChanged()
    markCreated(id, true)
  } catch (err) {
    console.error(err)
    markCreated(id, false)
  }
}

export function insertLinkView(view: EditorView, actions: Actions): void {
  const type = view.state.schema.nodes[COLLECTION_LINK]
  const spaceId = actions.getSpaceId()
  if (!type || !spaceId) return
  const collections = (actions.getPages?.() ?? []).filter((p) => p.kind === 'collection' && p.space_id === spaceId)
  const caret = view.coordsAtPos(view.state.selection.from)
  openCollectionPicker({
    at: { left: caret.left, top: caret.top, bottom: caret.bottom },
    collections,
    onPick: (page) => {
      if (view.isDestroyed) return
      insertBlockAtCursor(view, type.create({ collectionId: page.id, viewId: '', title: page.title }))
    },
    onCancel: () => {
      if (!view.isDestroyed) view.focus()
    },
  })
}
