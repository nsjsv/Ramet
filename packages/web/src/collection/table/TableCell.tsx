/* ---------- 表格的一格：展示 / 编辑 ----------
 * 编辑的进出由 TableView 管（同 Notion：单击 / Enter / 直接打字进编辑，Esc 退回选中态，Enter / 失焦提交）。
 * 选择器弹着、筛选框还空着时 ⌘V = 往这一格粘贴（onPaste），认不出才照旧贴进筛选框。编辑器由 CellEditor 按类型选：
 * 格内输入框替换展示，弹层盖在格子上，复选框点一下即切换（startEdit 里直接提交），系统生成的格子锁着。 */
import { useRef } from 'react'
import type * as Y from 'yjs'
import { rowValue, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { PageIcon } from '../../PageIcon'
import { CellEditor } from '../cells/CellEditor'
import { CellView } from '../cells/CellView'
import { editorKind } from '../cells/editor-kind'

type Props = {
  row: CollectionRow
  prop: CollectionProp
  doc: Y.Doc
  spaceId: string | null
  selected: boolean
  /** 在多格选区里（光标格之外也画选中底色） */
  inRange?: boolean
  /** 在填充柄正拖过的范围里（画虚线框） */
  inFill?: boolean
  /** 有它 = 这一格是选区右下角，画填充柄；按下开始拖 */
  onFillStart?: (e: React.MouseEvent) => void
  editing: boolean
  /** 打字进编辑时打的那个字（替换原内容 / 作选择器的筛选词） */
  seed?: string
  /** 选择器里粘贴（筛选框空着时）：true = 已当作往格子里粘贴处理 */
  onPaste?: (text: string) => boolean
  readOnly: boolean
  /** shift = 从锚点扩成选区 */
  onSelect: (shift: boolean) => void
  /** 按着鼠标拖进这一格：扩选区 */
  onExtend?: () => void
  onEdit: () => void
  onStop: () => void
  onCommit: (value: PropValue | null) => void
  onOpen: () => void
}

export default function TableCell(p: Props) {
  const { row, prop } = p
  const ref = useRef<HTMLDivElement>(null)
  const isTitle = prop.id === TITLE_PROP_ID
  const kind = editorKind(prop)
  const inline = p.editing && kind === 'inline'
  const locked = p.readOnly || kind === 'none'
  const editor = p.editing && (
    <CellEditor
      prop={prop}
      value={rowValue(row, prop)}
      doc={p.doc}
      spaceId={p.spaceId}
      seed={p.seed}
      onPaste={p.onPaste}
      anchor={ref.current}
      onCommit={p.onCommit}
      onDone={p.onStop}
    />
  )
  return (
    <div
      ref={ref}
      role="gridcell"
      aria-selected={p.selected}
      className={'cl-cell' + (p.selected ? ' is-selected' : '') + (p.inRange ? ' is-in-range' : '') + (p.inFill ? ' is-in-fill' : '') + (isTitle ? ' is-title' : '') + (locked ? ' is-locked' : '')}
      data-type={prop.type}
      data-tip={kind === 'none' ? COPY.collection.cell.readonly : undefined}
      onMouseDown={(e) => {
        // 编辑弹层是 portal，里面的按下也沿 React 树冒泡上来（日历的日格是 div）：当成按在格子上的话会收起选区、把焦点抢回表格
        const target = e.target as HTMLElement
        if (e.button !== 0 || !e.currentTarget.contains(target) || target.closest('a, button, input')) return
        p.onSelect(e.shiftKey)
      }}
      onMouseEnter={(e) => {
        if (e.buttons & 1) p.onExtend?.()
      }}
      onClick={(e) => {
        // 单击即编辑（复选框是直接切换）；按下与松开不在同一格（拖选）时 click 落在公共祖先上，到不了这里。
        // 弹层是 portal，里面的点击也沿 React 树冒泡上来：只认格子 DOM 里的；Shift 是扩选区，不进编辑
        const target = e.target as HTMLElement
        if (locked || p.editing || e.shiftKey || !e.currentTarget.contains(target) || target.closest('a, button, input, .cl-fill')) return
        p.onEdit()
      }}
    >
      {inline ? (
        editor
      ) : isTitle ? (
        <span className="cl-title">
          {/* 没有自定义图标时，正文里有字才画通用文档图标（同 Notion） */}
          <PageIcon icon={row.icon} placeholder={row.has_body} />
          <span className="cl-title-text">{row.title || COPY.untitled}</span>
          <button type="button" className="cl-open" onClick={p.onOpen}>
            {COPY.collection.cell.open}
          </button>
        </span>
      ) : (
        <CellView prop={prop} row={row} spaceId={p.spaceId} />
      )}
      {p.onFillStart && <span className="cl-fill" aria-hidden onMouseDown={p.onFillStart} />}
      {!inline && editor}
    </div>
  )
}
