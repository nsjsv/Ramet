// ---------- 看板的一张卡片：标题 + 视图里显示的属性（空值不画） ----------
// 可编辑时点标题文字 = 就地改名，点属性 = 就地改值（名称 / 文本 / 数字 / 链接 / 日期是输入框，单选 / 多选 / 状态 / 人员是贴着属性的选择器弹层，
// 复选框点一下即切换）；点条目以外的地方（空白、计算列）打开行页面，右上角另有「打开」按钮，卡片聚焦按 Enter 也打开。只读时点哪都是打开。
// 能拖时整张卡片可拖（拖放状态由 BoardView 管，这里只报起止），编辑中不拖。
// 刚在这一列新建的卡片，标题就地输入（Enter / 失焦改名，Esc 或留空不改）。
// 多选：⌘ / Ctrl 点切换、Shift 点连选（卡片上不放勾选框），优先于编辑。
// 卡片用 data-card 而不是表格的 data-row-id：整页集合「后退回到原位置」按表格行锚定，看板的列各自滚动，不参与。
import { useState } from 'react'
import type * as Y from 'yjs'
import { rowValue, TITLE_PROP, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { PageIcon } from '../../PageIcon'
import { CellView } from '../cells/CellView'
import { initialText, InlineInput } from '../cells/InlineInput'
import { OptionPicker, PersonPicker } from '../cells/Pickers'
import { Popover } from '../popover'
import { isComputed } from '../prop-meta'
import { hasValue } from './board-model'
import { ROW_DRAG_TYPE } from '../table/table-model'

const PICKER_TYPES = new Set(['select', 'multi_select', 'status', 'person'])

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
  onPick: (shift: boolean) => void
  onOpen: () => void
  onRename: (title: string) => void
  onNameDone: () => void
  /** 改一个属性的值（null = 清空） */
  onSet: (propId: string, value: PropValue | null) => void
  onDragStart: () => void
  onDragEnd: () => void
}

/** 正在编辑的项：属性 id（名称 = TITLE_PROP_ID）+ 选择器弹层贴着的元素 */
type Editing = { propId: string; el: HTMLElement }

export default function BoardCard(p: Props) {
  const { row } = p
  const [editing, setEditing] = useState<Editing | null>(null)
  const naming = p.naming || editing?.propId === TITLE_PROP_ID
  const busy = p.naming || editing !== null
  const stop = (): void => setEditing(null)

  /** 点在卡片上：标题文字 = 改名，可改的属性 = 改值，别处 = 打开 */
  const clickAt = (target: HTMLElement): void => {
    const name = target.closest<HTMLElement>('.cl-card-name')
    if (name) {
      setEditing({ propId: TITLE_PROP_ID, el: name })
      return
    }
    const field = target.closest<HTMLElement>('[data-prop]')
    const prop = field ? p.props.find((x) => x.id === field.dataset.prop) : undefined
    if (!field || !prop || isComputed(prop.type)) {
      p.onOpen()
      return
    }
    if (prop.type === 'checkbox') {
      p.onSet(prop.id, rowValue(row, prop) === true ? null : true)
      return
    }
    setEditing({ propId: prop.id, el: field })
  }

  const editProp = editing && editing.propId !== TITLE_PROP_ID ? p.props.find((x) => x.id === editing.propId) : undefined
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
        else clickAt(target)
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
      <div className="cl-card-title">
        <PageIcon icon={row.icon} />
        {naming ? (
          <InlineInput
            prop={TITLE_PROP}
            initial={p.naming ? '' : row.title}
            wrap
            onCommit={(value) => {
              stop()
              p.onRename(typeof value === 'string' ? value : '')
            }}
            onCancel={() => {
              stop()
              if (p.naming) p.onNameDone()
            }}
          />
        ) : (
          <span className={'cl-card-name' + (row.title ? '' : ' is-empty')}>{row.title || COPY.untitled}</span>
        )}
      </div>
      {!p.readOnly && !busy && (
        <button type="button" className="cl-open cl-card-open" onClick={p.onOpen}>
          {COPY.collection.cell.open}
        </button>
      )}
      {p.props
        .filter((prop) => hasValue(row, prop) || prop.id === editProp?.id)
        .map((prop) => (
          <div key={prop.id} className={'cl-card-prop' + (isComputed(prop.type) ? ' is-locked' : '') + (prop.id === editProp?.id ? ' is-editing' : '')} data-type={prop.type} data-prop={prop.id}>
            {prop.id === editProp?.id && !PICKER_TYPES.has(prop.type) ? (
              <InlineInput
                prop={prop}
                initial={initialText(row, prop)}
                wrap
                onCommit={(value) => {
                  stop()
                  p.onSet(prop.id, value)
                }}
                onCancel={stop}
              />
            ) : (
              <CellView prop={prop} row={row} spaceId={p.spaceId} />
            )}
            {/* 复选框只有一个勾：带上属性名才看得懂勾的是什么 */}
            {prop.type === 'checkbox' && <span className="cl-card-label">{prop.name}</span>}
          </div>
        ))}
      {editing && editProp && PICKER_TYPES.has(editProp.type) && (
        <Popover anchor={editing.el} onClose={stop} place="over" className="cl-cell-pop">
          {editProp.type === 'person' ? (
            <PersonPicker value={rowValue(row, editProp)} spaceId={p.spaceId} onChange={(value) => p.onSet(editProp.id, value)} />
          ) : (
            <OptionPicker prop={editProp} value={rowValue(row, editProp)} doc={p.doc} onChange={(value) => p.onSet(editProp.id, value)} onDone={stop} />
          )}
        </Popover>
      )}
    </div>
  )
}
