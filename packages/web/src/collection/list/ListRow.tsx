// ---------- 列表的一行：[手柄] [勾选框] 图标 标题 …… 视图里显示的属性（空值不画，紧凑排在右侧） ----------
// 可编辑时点标题文字 = 就地改名，点属性 = 就地改值，点别处打开行页面（item-fields.tsx，同看板卡片）；聚焦按 Enter 也打开。只读时点哪都是打开。
// 行首手柄：点开行菜单，无排序时拖动排序（拖放状态由 ListView 管，这里只报起止）；勾选框悬停才出现（已勾的常显），
// ⌘ / Ctrl 点行切换、Shift 点连选，优先于编辑。刚新建的行，标题就地输入。
// 行用 data-row-id（同表格）：整页集合「后退回到原位置」按它锚定，框选也认它。
import type * as Y from 'yjs'
import type { CollectionProp, CollectionRow, PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { PageIcon } from '../../PageIcon'
import { ItemFields, ItemName, useItemEdit } from '../item-fields'
import { ROW_DRAG_TYPE } from '../table/table-model'
import { Checkbox } from '../../ui/Checkbox'

const C = COPY.collection

/** 落点的拖放事件（ListView 按行所在的段判定，挂在整行上） */
export type RowDropHandlers = Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>

type Props = {
  row: CollectionRow
  props: readonly CollectionProp[]
  doc: Y.Doc
  spaceId: string | null
  readOnly: boolean
  canDrag: boolean
  /** 落点提示：插在这一行上 / 下 */
  drop: 'before' | 'after' | null
  dropTarget: RowDropHandlers
  naming: boolean
  picked: boolean
  onPick: (shift: boolean) => void
  onOpen: () => void
  onMenu: (anchor: HTMLElement) => void
  onRename: (title: string) => void
  onNameDone: () => void
  onSet: (propId: string, value: PropValue | null) => void
  onDragStart: () => void
  onDragEnd: () => void
}

export default function ListRow(p: Props) {
  const { row } = p
  const edit = useItemEdit(row, p.props, p.onOpen, p.onSet)
  const busy = p.naming || edit.editing !== null
  return (
    <div
      className={'cl-list-row' + (p.picked ? ' is-picked' : '') + (p.drop ? ` is-drop-${p.drop}` : '') + (p.readOnly ? '' : ' is-editable')}
      data-row-id={row.id}
      {...p.dropTarget}
    >
      <div className="cl-list-gutter">
        {!p.readOnly && (
          <span
            className="cl-handle"
            role="button"
            draggable={p.canDrag}
            data-tip={p.canDrag ? C.handle.tipDrag : C.handle.tip} aria-label={p.canDrag ? C.handle.tipDrag : C.handle.tip}
            aria-haspopup="menu"
            onClick={(e) => p.onMenu(e.currentTarget)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData(ROW_DRAG_TYPE, row.id)
              const el = e.currentTarget.closest('.cl-list-row')
              if (el) e.dataTransfer.setDragImage(el, 20, 16)
              p.onDragStart()
            }}
            onDragEnd={p.onDragEnd}
          >
            <Icon name="handle" size={16} />
          </span>
        )}
        {!p.readOnly && (
          <Checkbox
            className="cl-pick"
            aria-label={C.select.row}
            checked={p.picked}
            onChange={(_, e) => p.onPick((e.nativeEvent as MouseEvent).shiftKey === true)}
          />
        )}
      </div>
      <div
        className="cl-list-main"
        role={p.readOnly ? 'button' : undefined}
        tabIndex={busy ? -1 : 0}
        onClick={(e) => {
          // 弹层是 portal，里面的点击也沿 React 树冒泡上来：只认这一行 DOM 里的
          const target = e.target as HTMLElement
          if (busy || !e.currentTarget.contains(target) || target.closest('a, input, button')) return
          if (!p.readOnly && (e.metaKey || e.ctrlKey || e.shiftKey)) {
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
      >
        <PageIcon icon={row.icon} placeholder={row.has_body} />
        <ItemName
          row={row}
          edit={edit}
          fresh={p.naming}
          doc={p.doc}
          spaceId={p.spaceId}
          className="cl-list-name"
          onRename={p.onRename}
          onNameDone={p.onNameDone}
        />
        {!p.readOnly && !busy && (
          <button type="button" className="cl-open" onClick={p.onOpen}>
            {C.cell.open}
          </button>
        )}
        <div className="cl-list-props">
          <ItemFields row={row} props={p.props} edit={edit} doc={p.doc} spaceId={p.spaceId} className="cl-list-prop" onSet={p.onSet} />
        </div>
      </div>
    </div>
  )
}
