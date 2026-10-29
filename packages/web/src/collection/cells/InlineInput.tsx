// ---------- 单元格的行内输入（名称 / 文本 / 数字 / 链接 / 日期） ----------
// Enter 或失焦提交，Esc 取消；提交只发生一次（Enter 之后的失焦不再提交）。
// wrap（看板卡片）：用随内容长高的 textarea，按展示时的宽度折行；值仍是单行，粘贴进来的换行换成空格。
// 输入框里的按键不冒泡到表格（表格的方向键 / 退格是单元格导航）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rowValue, TEXT_MAX, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { parseNumberInput } from '../prop-meta'

type Props = {
  prop: CollectionProp
  initial: string
  /** null = 清空 */
  onCommit: (value: PropValue | null) => void
  onCancel: () => void
  /** 折行显示（日期除外）：textarea，高度随内容 */
  wrap?: boolean
  /** 起始文字换成它（表格里选中格子直接打字 = 用打的字替换原内容；日期不认）；提交仍和 initial 比 */
  seed?: string
}

/** 进入编辑时输入框里的初始文字 */
export function initialText(row: CollectionRow, prop: CollectionProp): string {
  if (prop.id === TITLE_PROP_ID) return row.title
  const value = rowValue(row, prop)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/** 输入的字 → 要写的值；undefined = 认不出（不写） */
function valueOf(prop: CollectionProp, text: string): PropValue | null | undefined {
  if (prop.type === 'number') return parseNumberInput(text)
  const t = prop.type === 'url' || prop.type === 'date' ? text.trim() : text
  return t === '' ? null : t
}

export function InlineInput({ prop, initial, onCommit, onCancel, wrap = false, seed }: Props) {
  const [text, setText] = useState(seed !== undefined && prop.type !== 'date' ? seed : initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const bad = valueOf(prop, text) === undefined
  const area = wrap && prop.type !== 'date'

  // textarea 跟着内容长高（border-box：scrollHeight 不含边框，补上）
  useLayoutEffect(() => {
    const el = ref.current
    if (!area || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [area, text])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (prop.type !== 'date') el.setSelectionRange(el.value.length, el.value.length)
  }, [prop.type])

  const finish = (commit: boolean): void => {
    if (done.current) return
    const value = valueOf(prop, text)
    if (commit && value === undefined) return // 认不出的数字：留在输入框里（失焦时按取消处理，见 onBlur）
    done.current = true
    if (commit && text !== initial) onCommit(value ?? null)
    else onCancel()
  }

  const common = {
    ref,
    className: 'cl-input' + (bad ? ' is-bad' : ''),
    inputMode: prop.type === 'number' ? ('decimal' as const) : undefined,
    maxLength: TEXT_MAX,
    value: text,
    title: bad ? COPY.collection.cell.badNumber : undefined,
    'aria-invalid': bad,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.nativeEvent.isComposing) return
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    },
    onBlur: () => {
      if (bad) finish(false)
      else finish(true)
    },
  }
  return area ? (
    <textarea {...common} rows={1} onChange={(e) => setText(e.target.value.replace(/\r?\n/g, ' '))} />
  ) : (
    <input {...common} type={prop.type === 'date' ? 'date' : 'text'} onChange={(e) => setText(e.target.value)} />
  )
}
