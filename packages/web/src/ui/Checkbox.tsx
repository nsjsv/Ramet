/* ---------- 复选框 ----------
 * 底层仍是原生 <input type=checkbox>（appearance:none，外观是 base.css 的全站复选框）：读屏、Space 切换、点文字切换、
 * 点击时的 shiftKey（表格 / 列表行的区间勾选）都是原生的，不自己重做。onChange 把原生事件一起交出去。
 * 带 label 时包一层 <label class="ui-check">（className 加在 label 上）；不带 label 时只渲染框本身（className 加在框上），
 * 用于表格行首这类靠 aria-label 命名的框。 */
import { useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'

type Props = {
  checked: boolean
  onChange: (checked: boolean, e: ChangeEvent<HTMLInputElement>) => void
  label?: ReactNode
  disabled?: boolean
  /** 半选（表头全选框：选了一部分）；勾选态照样由 checked 决定 */
  indeterminate?: boolean
  className?: string
  'aria-label'?: string
  tip?: string
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate = false, className, tip, onKeyDown, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  // indeterminate 只有 DOM 属性，没有 HTML 特性：每次渲染后同步（点一下浏览器会自己清掉它，要按 props 补回）
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  })
  const box = (
    <input
      ref={ref}
      type="checkbox"
      className={label === undefined ? className : undefined}
      checked={checked}
      disabled={disabled}
      aria-label={rest['aria-label']}
      data-tip={label === undefined ? tip : undefined}
      onChange={(e) => onChange(e.target.checked, e)}
      onKeyDown={onKeyDown}
    />
  )
  if (label === undefined) return box
  return (
    <label className={'ui-check' + (className ? ` ${className}` : '')} data-tip={tip}>
      {box}
      <span>{label}</span>
    </label>
  )
}
