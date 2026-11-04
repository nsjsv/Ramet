/* ---------- 日期框（取代 <input type=date> / datetime-local）----------
 * 文本框（可以直接敲：2026-11-03、2026/11/3、2026年11月3日…，失焦 / Enter 解析提交，认不出回退原值）+ 右侧日历按钮，
 * 点按钮或在框里按 ↓（Alt+↓）打开日历弹层。不带时间：选中即关，焦点回到文本框；带时间（值是 'YYYY-MM-DDTHH:MM'）：
 * 选日子、改时间都当场交出去，时间框里 Enter / 外点 / Esc 才关。
 * 弹层是 Popover（类 ui-datepop）：开在集合弹层（筛选菜单）里也归弹层栈管，点日历不算外层的外点，Esc 只关日历。
 * openDatePicker 是同一个弹层给纯 DOM 调用方（提问表单）用的命令式入口，经 layer-host 托管：DOM 代码没有卸载钩子，
 * 不能给每个字段建一个 React 根。 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../icons'
import { DatePanel } from './DatePanel'
import { DEFAULT_TIME, formatDateTime, joinDateTime, parseDateTime, parseDay, splitDateTime } from './date-model'
import { mountLayer } from './layer-host'
import { Popover } from './popover'
import { DATE_COPY as C } from './ui-copy'

type FieldProps = {
  /** 'YYYY-MM-DD'（withTime：'YYYY-MM-DDTHH:MM'）；null / '' = 空 */
  value: string | null
  /** 清空了 = null */
  onChange: (value: string | null) => void
  withTime?: boolean
  /** 有值时显示清除按钮（清空照样可以删掉文字再失焦） */
  clearable?: boolean
  placeholder?: string
  /** 加在外框上（外框画边框，像一个输入框） */
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

const shownOf = (value: string | null, withTime: boolean): string => (value ? (withTime ? formatDateTime(value) : value) : '')

export function DateField({ value, onChange, withTime = false, clearable = false, placeholder, className, disabled, id, ...rest }: FieldProps) {
  const wrap = useRef<HTMLSpanElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const shown = shownOf(value, withTime)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])

  const commit = (): void => {
    const t = draft.trim()
    const next = t === '' ? null : withTime ? parseDateTime(t) : parseDay(t)
    if (next === undefined) return setDraft(shown)
    setDraft(shownOf(next, withTime))
    if (next !== (value || null)) onChange(next)
  }
  const open = (): void => {
    if (!disabled && wrap.current) setAnchor(wrap.current)
  }
  const close = (refocus: boolean): void => {
    setAnchor(null)
    if (refocus) input.current?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    // Esc 交给外层（弹层 / 弹窗的关闭监听），Tab 照常移焦点；其余键是在框里打字，别让外面的快捷键（表格方向键、菜单键位）再处理一遍
    if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation()
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      commit()
      open()
    } else if (e.key === 'Enter') {
      // 不拦默认动作：表单里的 Enter 照样提交表单（提交前这里已经把草稿交出去了）
      commit()
      if (anchor) close(false)
    }
  }

  return (
    <span ref={wrap} className={'ui-datefield' + (disabled ? ' is-disabled' : '') + (className ? ` ${className}` : '')}>
      <input
        ref={input}
        id={id}
        type="text"
        className="ui-datefield-input"
        value={draft}
        placeholder={placeholder ?? (withTime ? C.placeholderTime : C.placeholder)}
        disabled={disabled}
        aria-label={rest['aria-label']}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {clearable && value && !disabled && (
        <button
          type="button"
          className="ui-datefield-btn"
          aria-label={C.clear}
          data-tip={C.clear}
          onClick={() => {
            setDraft('')
            onChange(null)
            input.current?.focus({ preventScroll: true })
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
      <button
        type="button"
        className="ui-datefield-btn"
        aria-label={C.pick}
        data-tip={C.pick}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={() => (anchor ? close(false) : open())}
      >
        <Icon name="calendar" size={14} />
      </button>
      {anchor && (
        <DatePop
          anchor={anchor}
          value={value}
          withTime={withTime}
          onPick={(v) => {
            setDraft(shownOf(v, withTime))
            if (v !== value) onChange(v)
            if (!withTime) close(true)
          }}
          onClose={close}
        />
      )}
    </span>
  )
}

type PopProps = {
  anchor: HTMLElement
  value: string | null
  withTime?: boolean
  onPick: (value: string) => void
  /** inside = 关闭时焦点在弹层里（Esc、时间框 Enter）：调用方把焦点还回去，否则掉到 body 上，键盘用户得从页面开头重新 Tab */
  onClose: (inside: boolean) => void
}

/** 日历弹层：DateField 与 openDatePicker 共用 */
function DatePop({ anchor, value, withTime = false, onPick, onClose }: PopProps) {
  const root = useRef<HTMLDivElement>(null)
  const split = (v: string | null): { day: string | null; time: string } => {
    if (!withTime) return { day: v || null, time: DEFAULT_TIME }
    const parts = v ? splitDateTime(v) : undefined
    return parts ?? { day: null, time: DEFAULT_TIME }
  }
  // 草稿留在这里：命令式入口的 value 是打开时的快照，之后不会变
  const [draft, setDraft] = useState(() => split(value))
  useEffect(() => setDraft(split(value)), [value]) // eslint-disable-line react-hooks/exhaustive-deps -- split 只依赖 withTime

  const close = (): void => onClose(root.current?.contains(document.activeElement) ?? false)
  const pickDay = (day: string): void => {
    setDraft((d) => ({ ...d, day }))
    onPick(withTime ? joinDateTime(day, draft.time) : day)
  }
  const pickTime = (time: string): void => {
    setDraft((d) => ({ ...d, time }))
    if (draft.day) onPick(joinDateTime(draft.day, time))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // 弹层是 portal：React 事件仍沿组件树冒泡到调用处
    e.stopPropagation()
    if (e.key === 'Tab' && root.current) trapTab(e, root.current)
  }

  return (
    <Popover anchor={anchor} onClose={close} className="ui-datepop">
      <div ref={root} role="dialog" aria-label={C.calendar} onKeyDown={onKeyDown}>
        <DatePanel
          value={draft.day}
          onPick={pickDay}
          autoFocus
          time={withTime ? { value: draft.time, onChange: pickTime, onEnter: close } : undefined}
        />
      </div>
    </Popover>
  )
}

/** 焦点不出弹层：同日期选择器对话框的约定，离开用 Esc（弹层是 portal，Tab 出去会落到页面末尾） */
function trapTab(e: KeyboardEvent, box: HTMLElement): void {
  const items = [...box.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

export type DatePickerOptions = {
  /** 'YYYY-MM-DD'（withTime：'YYYY-MM-DDTHH:MM'）；null = 没选 */
  value: string | null
  withTime?: boolean
  /** 不带时间：选中后弹层自己关；带时间：日子 / 时间每改一下都报，时间框 Enter / 外点 / Esc 才关 */
  onPick: (value: string) => void
  /** 弹层关了（任何原因；调用方用它复位自己记着的关闭函数） */
  onClose?: () => void
  /** 关闭时焦点在弹层里就还给它；缺省还给 anchor */
  focus?: HTMLElement
}

/** 纯 DOM 调用方的日历弹层：贴在 anchor 下面，外点 / Esc / 选中即关；返回关闭函数（重复调用无害）。
 *  anchor 被摘出文档（提问在别处答掉了，卡片整张拿走）时一起关，不留一个没有依附的弹层 */
export function openDatePicker(anchor: HTMLElement, o: DatePickerOptions): () => void {
  let closed = false
  let unmount = (): void => {}
  const watch = new MutationObserver(() => {
    if (!anchor.isConnected) close(false)
  })
  const close = (refocus: boolean): void => {
    if (closed) return
    closed = true
    watch.disconnect()
    unmount()
    const target = o.focus ?? anchor
    if (refocus && target.isConnected) target.focus({ preventScroll: true })
    o.onClose?.()
  }
  watch.observe(document.body, { childList: true, subtree: true })
  unmount = mountLayer(
    <DatePop
      anchor={anchor}
      value={o.value}
      withTime={o.withTime}
      onPick={(v) => {
        o.onPick(v)
        if (!o.withTime) close(true)
      }}
      onClose={close}
    />,
  )
  return () => close(false)
}
