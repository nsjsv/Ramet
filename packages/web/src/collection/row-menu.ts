/* ---------- 集合表格的行手柄菜单：点行首手柄弹出（拖动手柄仍是排序） ----------
 * 弹层外壳与编辑器块手柄菜单同一份（handle-menu.ts）：同样的卡片、图标格、飞出面板、点外 / Esc 关闭；
 * 共有的动作同名同序：「移到…」在「转换」的位置（飞出面板列出本空间别的集合），然后删除 / 复制 / 复制链接，
 * 行特有的「打开 / 在新标签页打开」在后，分隔线下是这一行的最近修改（edit-info，同块菜单）。
 * 手柄所在的行已勾选时动作作用于全部勾选的行（同块菜单：块选区盖住这一块就作用于整个选区），只剩批量动作。 */
import type { Page } from '../api'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { renderEditInfo } from '../edit-info'
import { editInfoOf, refreshEditMarks } from '../edit-marks-store'
import type { HandleMenu } from '../handle-menu'
import type { CollectionHandle } from './collection-store'
import { moveRowsConfirmed, moveTargets, trashRowsConfirmed, type Animate } from './row-actions'

const S = COPY.collection.select
const H = COPY.collection.handle

export type RowMenuOptions = {
  handle: CollectionHandle
  spaceId: string | null
  pages: readonly Page[] | null
  /** 作用于哪些行（单行或全部已勾选的行） */
  ids: string[]
  onOpenRow: (rowId: string) => void
  /** 删 / 挪 / 复制以后：清掉勾选 */
  onDone: () => void
  animate?: Animate
}

const rowUrl = (rowId: string): string => `${location.origin}/page/${encodeURIComponent(rowId)}`

export function openRowMenu(menu: HandleMenu, anchor: Element, o: RowMenuOptions): void {
  const { handle, ids } = o
  const single = ids.length === 1 ? ids[0]! : null
  menu.open(anchor, (m) => {
    m.el.appendChild(
      m.flyout(S.move, { svg: 'swap' }, () => {
        const targets = moveTargets(o.pages, handle, o.spaceId)
        return targets.map((page) => ({
          label: page.title || COPY.untitled,
          icon: { svg: 'table' },
          run: () => moveRowsConfirmed(handle, ids, page, o.onDone, o.animate),
        }))
      }),
    )
    m.el.appendChild(m.item(S.remove, { svg: 'trash' }, () => trashRowsConfirmed(handle, ids, o.onDone, o.animate)))
    m.el.appendChild(
      m.item(S.duplicate, { svg: 'copy' }, () => {
        void handle.duplicateRows(ids)
        o.onDone()
      }),
    )
    if (!single) return
    m.el.appendChild(m.item(H.copyLink, { svg: 'link' }, () => void copyText(rowUrl(single))))
    m.el.appendChild(m.item(H.open, { svg: 'file' }, () => o.onOpenRow(single)))
    m.el.appendChild(m.item(H.openTab, { svg: 'external' }, () => window.open(rowUrl(single), '_blank', 'noopener')))
    // 分隔线下：这一行（页面）的最近修改；缓存当场画，后台刷一次，变了原地更新
    const info = document.createElement('div')
    const shown = editInfoOf(single)
    renderEditInfo(info, null, shown)
    m.el.appendChild(info)
    void refreshEditMarks(single).then(() => {
      const fresh = editInfoOf(single)
      if (!m.alive() || JSON.stringify(fresh) === JSON.stringify(shown)) return
      renderEditInfo(info, null, fresh)
      m.place()
    })
  })
}
