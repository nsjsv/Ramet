// ---------- 单元格的行内输入（名称 / 文本 / 数字 / 链接 / 邮箱 / 电话） ----------
// Enter 或失焦提交，Esc 取消；提交只发生一次（Enter 之后的失焦不再提交）。
// 认不出的输入（数字、格式不对的邮箱 / 电话）标红并在悬停里说原因：Enter 留在输入框里改，失焦按取消处理。
// wrap（看板卡片）：用随内容长高的 textarea，按展示时的宽度折行；值仍是单行，粘贴进来的换行换成空格。
// 输入框里的按键不冒泡到表格（表格的方向键 / 退格是单元格导航）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TEXT_MAX, validateValue, type CollectionProp, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { parseNumberInput } from '../prop-meta'

type Props = {
  prop: CollectionProp
  initial: string
  /** null = 清空 */
  onCommit: (value: PropValue | null) => void
  onCancel: () => void
  /** 折行显示：textarea，高度随内容 */
  wrap?: boolean
  /** 起始文字换成它（表格里选中格子直接打字 = 用打的字替换原内容）；提交仍和 initial 比 */
  seed?: string
}

/** 输入的字 → 要写的值（null = 清空）或认不出的原因 */
function parse(prop: CollectionProp, text: string): { value: PropValue | null } | { error: string } {
  if (prop.type === 'number') {
    const n = parseNumberInput(text)
    return n === undefined ? { error: COPY.collection.cell.badNumber } : { value: n }
  }
  if (prop.type === 'email' || prop.type === 'phone') {
    const checked = validateValue(prop, text)
    return checked.ok ? { value: checked.value } : { error: checked.error }
  }
  const t = prop.type === 'url' ? text.trim() : text
  return { value: t === '' ? null : t }
}

const INPUT_MODE: Partial<Record<CollectionProp['type'], 'decimal' | 'email' | 'tel'>> = { number: 'decimal', email: 'email', phone: 'tel' }

export function InlineInput({ prop, initial, onCommit, onCancel, wrap = false, seed }: Props) {
  const [text, setText] = useState(seed ?? initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const parsed = parse(prop, text)
  const error = 'error' in parsed ? parsed.error : undefined

  // textarea 跟着内容长高（border-box：scrollHeight 不含边框，补上）
  useLayoutEffect(() => {
    const el = ref.current
    if (!wrap || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [wrap, text])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    if (commit && 'error' in parsed) return // 认不出：留在输入框里（失焦时按取消处理，见 onBlur）
    done.current = true
    if (commit && text !== initial && 'value' in parsed) onCommit(parsed.value)
    else onCancel()
  }

  const common = {
    ref,
    className: 'cl-input' + (error ? ' is-bad' : ''),
    inputMode: INPUT_MODE[prop.type],
    maxLength: TEXT_MAX,
    value: text,
    title: error,
    'aria-invalid': error !== undefined,
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
    onBlur: () => finish(error === undefined),
  }
  return wrap ? (
    <textarea {...common} rows={1} onChange={(e) => setText(e.target.value.replace(/\r?\n/g, ' '))} />
  ) : (
    <input {...common} type="text" onChange={(e) => setText(e.target.value)} />
  )
}
