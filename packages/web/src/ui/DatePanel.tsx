/* ---------- 日历面板（取代原生日期框弹出的日历）----------
 * 头部「‹ 2026 年 11 月 ›」+「今天」，星期行一…日（周一开头），6 × 7 格：今天描边、选中实底、非本月淡化，区间两端实底、中间浅底。
 * 系统日历由浏览器画，深色主题、字号、周几开头都管不到，各浏览器还长得不一样。
 * 键盘：格子是 roving tabindex（Tab 只停在当前格）；←→ 一天、↑↓ 一周、PageUp / PageDown 一个月（Shift 一年）、
 * Home / End 本周一 / 周日，Enter / Space 选中。按键在这里就地处理并 stopPropagation：面板常挂在 portal 弹层里，
 * React 事件沿组件树冒泡，外面的表格方向键 / 菜单键位会把同一个键再处理一遍。纯逻辑在 date-model.ts。
 * 带时间（time）时底部加 HH:MM 文本框：失焦 / Enter 校验，认不出回退原值；选了日子焦点移到时间框（接着敲时间）。 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Icon } from '../icons'
import { addMonths, dayParts, localDay, monthGrid, monthOf, moveDay, parseTime, shiftMonth } from './date-model'
import { DATE_COPY as C } from './ui-copy'

export type DatePanelTime = {
  value: string
  onChange: (time: string) => void
  /** 在时间框里按了 Enter（已先提交时间） */
  onEnter?: () => void
}

type Props = {
  /** 选中的日子（'YYYY-MM-DD'）；变了面板就翻到它所在的月 */
  value: string | null
  /** viaEnter：在格子上按 Enter 选的（集合日期格据此直接提交，点选 / Space 只改草稿） */
  onPick: (day: string, viaEnter: boolean) => void
  /** 区间：两端实底、中间浅底（先后不限） */
  range?: { start: string; end: string } | null
  /** 头部「今天」= 选今天。集合日期格底部自己有「今天」「清除」，不要这个 */
  todayButton?: boolean
  time?: DatePanelTime
  /** 挂上就把焦点放进当前格（弹层里打开时） */
  autoFocus?: boolean
  className?: string
}

export function DatePanel({ value, onPick, range, todayButton = true, time, autoFocus, className }: Props) {
  const today = localDay()
  const [month, setMonth] = useState(() => monthOf(value ?? today))
  /** 键盘焦点所在的那一天（roving tabindex） */
  const [active, setActive] = useState(() => value ?? today)
  const grid = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLInputElement>(null)
  /** 刚用键盘挪了当前格：渲染后把 DOM 焦点跟过去 */
  const follow = useRef(false)
  const titleId = useId()

  // 外面改了值（集合日期格里敲了日期、换了正在改的那一端）：翻到它
  useEffect(() => {
    if (!value) return
    setActive(value)
    setMonth(monthOf(value))
  }, [value])

  const days = monthGrid(month).days
  const tabDay = days.includes(active) && monthOf(active) === month ? active : `${month}-01`
  const cellOf = (day: string): HTMLElement | null => grid.current?.querySelector<HTMLElement>(`[data-day="${day}"]`) ?? null

  useLayoutEffect(() => {
    if (!follow.current) return
    follow.current = false
    cellOf(tabDay)?.focus({ preventScroll: true })
  })

  // 弹层首帧还没定位（visibility:hidden，聚焦不了）：等一帧
  useEffect(() => {
    if (!autoFocus) return
    const raf = requestAnimationFrame(() => cellOf(tabDay)?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂上时聚焦一次
  }, [])

  const show = (day: string): void => {
    setActive(day)
    if (monthOf(day) !== month) setMonth(monthOf(day))
  }
  const pick = (day: string, viaEnter: boolean): void => {
    show(day)
    onPick(day, viaEnter)
    if (time) {
      timeRef.current?.focus()
      timeRef.current?.select()
    }
  }
  const go = (n: number): void => {
    setMonth(shiftMonth(month, n))
    setActive(addMonths(tabDay, n))
  }

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      pick(tabDay, e.key === 'Enter')
      return
    }
    const next = moveDay(tabDay, e.key, e.shiftKey)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    follow.current = true
    show(next)
  }

  const lo = range ? (range.start <= range.end ? range.start : range.end) : null
  const hi = range ? (range.start <= range.end ? range.end : range.start) : null
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))

  return (
    <div className={'ui-date' + (className ? ` ${className}` : '')}>
      <div className="ui-date-head">
        <span id={titleId} className="ui-date-title" aria-live="polite">
          {C.monthTitle(Number(month.slice(0, 4)), Number(month.slice(5, 7)))}
        </span>
        <button type="button" className="ui-date-nav is-prev" aria-label={C.prevMonth} data-tip={C.prevMonth} onClick={() => go(-1)}>
          <Icon name="chevron" size={14} />
        </button>
        {todayButton && (
          <button type="button" className="ui-date-today" onClick={() => pick(today, false)}>
            {C.today}
          </button>
        )}
        <button type="button" className="ui-date-nav" aria-label={C.nextMonth} data-tip={C.nextMonth} onClick={() => go(1)}>
          <Icon name="chevron" size={14} />
        </button>
      </div>
      <div ref={grid} role="grid" aria-labelledby={titleId} className="ui-date-grid" onKeyDown={onGridKey}>
        <div role="row" className="ui-date-row">
          {C.weekdays.map((w) => (
            <div key={w} role="columnheader" aria-label={C.weekday(w)} className="ui-date-wd">
              {w}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="ui-date-row">
            {week.map((day) => {
              const p = dayParts(day)
              const selected = day === value || day === lo || day === hi
              const between = lo !== null && hi !== null && lo < day && day < hi
              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  tabIndex={day === tabDay ? 0 : -1}
                  aria-selected={selected}
                  aria-current={day === today ? 'date' : undefined}
                  aria-label={C.dayLabel(p.year, p.month, p.date, C.weekdays[p.weekday] ?? '')}
                  className={
                    'ui-day' +
                    (monthOf(day) === month ? '' : ' is-out') +
                    (day === today ? ' is-today' : '') +
                    (selected ? ' is-selected' : '') +
                    (between ? ' is-between' : '')
                  }
                  onClick={() => pick(day, false)}
                >
                  {p.date}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {time && <TimeBox {...time} inputRef={timeRef} />}
    </div>
  )
}

function TimeBox({ value, onChange, onEnter, inputRef }: DatePanelTime & { inputRef: RefObject<HTMLInputElement> }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const t = parseTime(draft)
    if (t === undefined) return setDraft(value)
    setDraft(t)
    if (t !== value) onChange(t)
  }
  return (
    <label className="ui-date-time">
      <span>{C.time}</span>
      <input
        ref={inputRef}
        type="text"
        className="ui-date-time-input"
        value={draft}
        placeholder="HH:MM"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Tab 留给外层（日历弹层把焦点圈在里面），Esc 留给弹层的关闭监听；其余是在框里打字
          if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation()
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          commit()
          onEnter?.()
        }}
      />
    </label>
  )
}
