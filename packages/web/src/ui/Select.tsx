/* ---------- 下拉选择（取代原生 <select>）----------
 * 系统下拉的弹出列表由浏览器 / 操作系统画，深色主题、字号、圆角都管不到，触屏上还是另一套界面。
 * 触发器是 role=combobox 的按钮，列表是 Popover（贴在触发器下面、至少同宽）：在 Modal、集合弹层里打开都归弹层栈管，
 * 点列表不算外层弹层的外点，Esc 只关列表（Popover 在 document 捕获阶段吃掉 Esc，外层 Modal / 弹层收不到）。
 * 焦点：打开时移进列表（aria-activedescendant 指当前项），关闭时回到触发器 —— 列表摘掉时焦点要有去处，否则掉到 body 上，
 * 键盘用户得从页面开头重新 Tab。
 * 键盘：触发器上 Enter / Space（按钮自己的 click）/ ↑↓ 打开；列表里 ↑↓ Home End 移动（跳过禁用项）、Enter / Space 选中、
 * Esc 关闭、Tab 关闭并照常移到下一个控件、连打字母按前缀跳转。纯逻辑在 select-nav.ts。 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../icons'
import { Popover } from './popover'
import { edgeIndex, initialIndex, matchIndex, stepIndex } from './select-nav'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  /** 悬停提示（禁用项说明为什么选不了） */
  tip?: string
}

type Props<T extends string> = {
  /** null / 不在选项里 = 显示 placeholder */
  value: T | null
  options: ReadonlyArray<SelectOption<T>>
  /** 第二个参数是触发器（要以它为锚点再开弹层的调用方用，如改属性类型时选关联的目标集合） */
  onChange: (value: T, trigger: HTMLButtonElement) => void
  /** 读屏名称 */
  label: string
  placeholder?: string
  disabled?: boolean
  tip?: string
  /** 加在触发器上：宽度 / 布局沿用调用处原有的类 */
  className?: string
  /** sm = 紧凑（行内、弹层里的条件行） */
  size?: 'md' | 'sm'
  id?: string
}

/** 连打字母的累加窗口 */
const TYPE_MS = 500

export function Select<T extends string>({ value, options, onChange, label, placeholder, disabled, tip, className, size = 'md', id }: Props<T>) {
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const rows = useRef<Array<HTMLDivElement | null>>([])
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [active, setActive] = useState(-1)
  const typed = useRef({ text: '', at: 0 })
  const listId = useId()
  const current = options.findIndex((o) => o.value === value)
  const shown = options[current]

  const open = (at?: 'first' | 'last'): void => {
    if (disabled || !trigger.current) return
    setActive(at ? edgeIndex(options, at) : initialIndex(options, current))
    typed.current = { text: '', at: 0 }
    setAnchor(trigger.current)
  }
  /** 关列表；焦点在列表里（键盘选中、Esc、Tab、点了外面 / 滚动了）就交回触发器 */
  const close = (): void => {
    setAnchor(null)
    if (list.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
  }
  const pick = (i: number): void => {
    const o = options[i]
    if (!o || o.disabled) return
    close()
    if (o.value !== value && trigger.current) onChange(o.value, trigger.current)
  }

  // 列表刚挂上时 Popover 还没定位（visibility:hidden，聚焦不了）：等一帧再聚焦
  useEffect(() => {
    if (!anchor) return
    const raf = requestAnimationFrame(() => list.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [anchor])
  useEffect(() => {
    if (anchor && active >= 0) rows.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [anchor, active])
  // 选项变了（协同改名、删了一项）：当前项越界就收回
  useEffect(() => {
    if (active >= options.length) setActive(initialIndex(options, current))
  }, [options, active, current])

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (anchor || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      open()
    }
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // 列表是 portal：React 事件仍沿组件树冒泡，别让外面的快捷键（表格方向键、菜单键位）把这些键再处理一遍
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    const move = (i: number): void => {
      e.preventDefault()
      if (i >= 0) setActive(i)
    }
    if (e.key === 'ArrowDown') return move(stepIndex(options, active, 1))
    if (e.key === 'ArrowUp') return move(stepIndex(options, active, -1))
    if (e.key === 'Home' || e.key === 'PageUp') return move(edgeIndex(options, 'first'))
    if (e.key === 'End' || e.key === 'PageDown') return move(edgeIndex(options, 'last'))
    if (e.key === 'Tab') return close()
    const now = Date.now()
    const typing = now - typed.current.at < TYPE_MS && typed.current.text !== ''
    // 连打字母中途的空格算查询的一部分（「成员 可编辑」），否则是选中
    if (e.key === 'Enter' || (e.key === ' ' && !typing)) {
      // 必须拦默认动作：焦点此刻交回了触发器，不拦的话这次 Enter 的 keypress 落到按钮上又把列表点开
      e.preventDefault()
      if (active >= 0) pick(active)
      else close()
      return
    }
    if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const text = (typing ? typed.current.text : '') + e.key
      typed.current = { text, at: now }
      const i = matchIndex(options, active, text)
      if (i >= 0) setActive(i)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? listId : undefined}
        aria-label={label}
        data-tip={tip}
        disabled={disabled}
        className={'ui-select' + (size === 'sm' ? ' is-sm' : '') + (shown ? '' : ' is-empty') + (className ? ` ${className}` : '')}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={onTriggerKey}
      >
        {/* 宽度按最长的选项撑（同系统下拉）：换个选项触发器不变宽窄，旁边的控件不跟着挪 */}
        <span className="ui-select-text">
          <span>{shown ? shown.label : (placeholder ?? '')}</span>
          {placeholder && shown && <span className="ui-select-sizer" aria-hidden="true">{placeholder}</span>}
          {options.map((o) => (
            <span key={o.value} className="ui-select-sizer" aria-hidden="true">
              {o.label}
            </span>
          ))}
        </span>
        <Icon name="caret" size={14} className="ui-select-caret" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} className="ui-listbox" matchWidth>
          <div
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="ui-listbox-list"
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                ref={(el) => {
                  rows.current[i] = el
                }}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                aria-disabled={o.disabled || undefined}
                data-tip={o.tip}
                className={'ui-option' + (i === active ? ' is-active' : '') + (i === current ? ' is-selected' : '')}
                // 按下不抢焦点：焦点留在列表上，键盘接着能用
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !o.disabled && i !== active && setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="ui-option-text">{o.label}</span>
                {i === current && <Icon name="check" size={14} className="ui-option-check" />}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}
