// ---------- 单元格编辑器：按属性选编辑器的唯一一处（表格、看板卡片、行页面属性区、批量栏共用） ----------
// 用哪种看 editorKind：inline 渲染输入框（调用方把它放在格子里替换展示）；popover 给了 anchor 就盖在它上面弹出，
// 没给（批量栏，本身已在弹层里）就原地画内容；toggle / none 什么都不画（复选框由调用方直接切换，系统生成的不能改）。
// 提交与结束：onCommit 每次写值；onDone = 编辑结束（输入框是取消、弹层是关闭 / 选完）。输入框提交后由调用方自己收起，
// 弹层要不要接着开由编辑器自己决定（单选、只能关联一行选完即关，多选、人员、文件、关联留着，日期 Enter 才关）。
import type * as Y from 'yjs'
import type { CollectionProp, PropValue } from '@ramet/shared/collection-model'
import { Popover } from '../popover'
import { DateEditor } from './DateEditor'
import { editorKind } from './editor-kind'
import { FilesEditor } from './FilesEditor'
import { InlineInput } from './InlineInput'
import { OptionPicker, PersonPicker } from './Pickers'
import { RelationPicker } from './RelationPicker'

type Props = {
  prop: CollectionProp
  /** 格子现在的值（rowValue；批量栏是草稿） */
  value: PropValue | undefined
  /** 集合文档：给了才能在选项选择器里新建选项 */
  doc: Y.Doc | null
  spaceId: string | null
  onCommit: (value: PropValue | null) => void
  onDone: () => void
  /** 表格里选中格子直接打字进编辑：打的那个字（输入框的起始文字 / 选择器的筛选词 / 日期的初值） */
  seed?: string
  /** 选择器里粘贴（筛选框空着时）：true = 调用方已当作往格子里粘贴处理 */
  onPaste?: (text: string) => boolean
  /** 输入框折行（看板卡片） */
  wrap?: boolean
  /** 弹层盖在哪个元素上；不给 = 原地画（调用方已在弹层里） */
  anchor?: HTMLElement | null
  /** 批量栏：日期每改一下就报草稿，「今天」「清除」也只改草稿（写不写由批量栏的「应用」决定） */
  live?: boolean
}

export function CellEditor(p: Props) {
  const { prop, value } = p
  const kind = editorKind(prop)
  if (kind === 'inline') {
    const initial = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    return <InlineInput prop={prop} initial={initial} seed={p.seed} wrap={p.wrap} onCommit={p.onCommit} onCancel={p.onDone} />
  }
  if (kind !== 'popover') return null
  let body: React.ReactNode
  switch (prop.type) {
    case 'person':
      body = <PersonPicker value={value} spaceId={p.spaceId} onChange={p.onCommit} seed={p.seed} onPaste={p.onPaste} />
      break
    case 'date':
      body = <DateEditor value={value} onCommit={p.onCommit} onDone={p.onDone} seed={p.seed} live={p.live} />
      break
    case 'files':
      body = <FilesEditor value={value} onCommit={p.onCommit} />
      break
    case 'relation':
      body = <RelationPicker prop={prop} value={value} onChange={p.onCommit} onDone={p.onDone} seed={p.seed} />
      break
    default:
      body = <OptionPicker prop={prop} value={value} doc={p.doc} onChange={p.onCommit} onDone={p.onDone} seed={p.seed} onPaste={p.onPaste} />
  }
  if (p.anchor === undefined) return <>{body}</>
  return (
    <Popover anchor={p.anchor} onClose={p.onDone} place="over" className="cl-cell-pop">
      {body}
    </Popover>
  )
}
