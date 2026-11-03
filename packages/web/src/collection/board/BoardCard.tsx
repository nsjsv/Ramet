// ---------- 看板 / 画廊的一张卡片：（画廊的预览图）+ 标题 + 视图里显示的属性（空值不画） ----------
// 可编辑时点标题文字 = 就地改名，点属性 = 就地改值，点条目以外的地方（空白、系统生成的属性、预览图）打开行页面
// （item-fields.tsx，与列表行同一套）；右上角另有「打开」按钮，卡片聚焦按 Enter 也打开。只读时点哪都是打开。
// 能拖时整张卡片可拖（拖放状态由所在视图管，这里只报起止），编辑中不拖。
// 刚新建的卡片，标题就地输入（Enter / 失焦改名，Esc 或留空不改）。
// 多选：⌘ / Ctrl 点切换、Shift 点连选（卡片上不放勾选框），优先于编辑。
// 卡片用 data-card 而不是表格的 data-row-id：整页集合「后退回到原位置」按表格 / 列表的行锚定，看板的列各自滚动、画廊不要求，都不参与。
import type { ReactNode } from 'react'
import type * as Y from 'yjs'
import type { CollectionProp, CollectionRow, PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { PageIcon } from '../../PageIcon'
import { ItemFields, ItemName, useItemEdit } from '../item-fields'
import { ROW_DRAG_TYPE } from '../table/table-model'

type Props = {
  row: CollectionRow
  props: readonly CollectionProp[]
  doc: Y.Doc
  spaceId: string | null
  readOnly: boolean
  canDrag: boolean
  dragging: boolean
  /** 落点提示：插在这张卡片前 / 后 */
  drop: 'before' | 'after' | null
  naming: boolean
  picked: boolean
  pickable: boolean
  /** 画廊：标题上方的预览区 */
  preview?: ReactNode
  onPick: (shift: boolean) => void
  onOpen: () => void
  onRename: (title: string) => void
  onNameDone: () => void
  /** 改一个属性的值（null = 清空） */
  onSet: (propId: string, value: PropValue | null) => void
  onDragStart: () => void
  onDragEnd: () => void
}

export default function BoardCard(p: Props) {
  const { row } = p
  const edit = useItemEdit(row, p.props, p.onOpen, p.onSet)
  const busy = p.naming || edit.editing !== null
  return (
    <div
      className={'cl-card' + (p.dragging ? ' is-dragging' : '') + (p.drop ? ` is-drop-${p.drop}` : '') + (p.picked ? ' is-picked' : '') + (p.readOnly ? '' : ' is-editable')}
      data-card={row.id}
      role={p.readOnly ? 'button' : undefined}
      tabIndex={busy ? -1 : 0}
      draggable={p.canDrag && !busy}
      onClick={(e) => {
        // 弹层是 portal，里面的点击也沿 React 树冒泡上来：只认卡片 DOM 里的
        const target = e.target as HTMLElement
        if (busy || !e.currentTarget.contains(target) || target.closest('a, input, button')) return
        if (p.pickable && (e.metaKey || e.ctrlKey || e.shiftKey)) {
          e.preventDefault()
          p.onPick(e.shiftKey)
          return
        }
        if (p.readOnly) p.onOpen()
        else edit.clickAt(target)
      }}
      onKeyDown={(e) => {
        if (busy || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        p.onOpen()
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(ROW_DRAG_TYPE, row.id)
        p.onDragStart()
      }}
      onDragEnd={p.onDragEnd}
    >
      {p.preview}
      <div className="cl-card-title">
        <PageIcon icon={row.icon} />
        <ItemName
          row={row}
          edit={edit}
          fresh={p.naming}
          doc={p.doc}
          spaceId={p.spaceId}
          className="cl-card-name"
          wrap
          onRename={p.onRename}
          onNameDone={p.onNameDone}
        />
      </div>
      {!p.readOnly && !busy && (
        <button type="button" className="cl-open cl-card-open" onClick={p.onOpen}>
          {COPY.collection.cell.open}
        </button>
      )}
      <ItemFields row={row} props={p.props} edit={edit} doc={p.doc} spaceId={p.spaceId} className="cl-card-prop" wrap onSet={p.onSet} />
    </div>
  )
}
