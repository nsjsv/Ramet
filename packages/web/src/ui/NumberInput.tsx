/* ---------- 数字输入框（取代 <input type=number>）----------
 * 文本框 + 草稿字符串：打字期间不提交，失焦 / Enter 时按 min / max / integer 收进范围再交出去（clamp={false} 时原样交出），
 * 读不出数字就回退原值。
 * ↑↓ 按 step 增减（Shift ×10），当场提交；不画步进按钮。解析与夹取在 number.ts（提问表单的 DOM 版共用）。 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { commitNumber, formatNumber, stepNumber } from './number'

type Props = {
  value: number | null
  onChange: (value: number | null) => void
  min?: number
  max?: number
  /** ↑↓ 的步长（缺省 1） */
  step?: number
  integer?: boolean
  /** false = 失焦 / Enter 时越界、带小数照原样交出，由调用方报错（端口这类夹到边上就成了另一个值的）；↑↓ 仍收进范围 */
  clamp?: boolean
  /** 允许清空（提交 null）；缺省清空 = 回退原值 */
  nullable?: boolean
  placeholder?: string
  className?: string
  id?: string
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
}

export function NumberInput({ value, onChange, min, max, step = 1, integer, clamp = true, nullable, placeholder, className, id, disabled, autoFocus, ...rest }: Props) {
  const [draft, setDraft] = useState(formatNumber(value))
  // 外面的值变了（提交后被夹取、别处改了）：草稿跟上
  useEffect(() => setDraft(formatNumber(value)), [value])
  const rule = { min, max, integer, nullable }

  const commit = (): void => {
    const next = commitNumber(draft, clamp ? rule : { nullable })
    if (next === undefined || next === value) {
      setDraft(formatNumber(value))
      return
    }
    setDraft(formatNumber(next))
    onChange(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      // 不拦默认动作：表单里的 Enter 照样提交表单（提交前这里已经把草稿交出去了）
      commit()
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const next = stepNumber(draft, value, (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1), rule)
      setDraft(formatNumber(next))
      if (next !== value) onChange(next)
    }
  }

  // 负数要能敲出减号：手机的数字键盘没有「-」，允许负数时用普通键盘
  const inputMode = min !== undefined && min >= 0 ? (integer ? 'numeric' : 'decimal') : 'text'
  return (
    <input
      id={id}
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      spellCheck={false}
      className={className}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={rest['aria-label']}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  )
}
