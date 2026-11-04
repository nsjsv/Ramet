// ---------- 日期编辑弹层：开始 / 结束两个文本框 +「结束日期」开关 + 常驻日历 +「今天」「清除」 ----------
// 改的是草稿：Enter /「今天」/「清除」提交并关闭；点弹层外面关闭时草稿和原值不同也提交（同输入框失焦提交）；
// Esc 放弃草稿。
// 日历不套弹层（弹层里再开弹层，外点、Esc 都要分辨是哪一层的），常驻在文本框下面：点日子写进正在改的那一端，
// 开了结束日期时选完开始自动轮到结束；格子上按 Enter = 选这一天并提交（同文本框里的 Enter），点选 / Space 只改草稿。
// 结束早于开始照样记在草稿里，写出去时由 joinDate 排成先后顺序。
// 文本框可以直接敲（认法同表格里粘贴：2026/1/2、2026年1月2日…），敲出一个完整日期就进草稿；认不出的字失焦时回退，Enter 时标红不关。
// 表格里直接打字进编辑：打的字本身是一个完整日期（区间）时才作初值；不是的话初值不变，打的字留在开始框里接着敲。
// live（批量栏）：每次草稿变了就报给调用方（那边只记草稿，「应用」才写），「今天」「清除」也只改草稿，关闭时不再补交 ——
// 批量改值一次动很多行，不能让一个顺手的按钮直接写下去。
import { useEffect, useRef, useState } from 'react'
import { dateSpan, isCalendarDate, joinDate, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { isTouchEditor } from '../../editor/block-touch'
import { Checkbox } from '../../ui/Checkbox'
import { DatePanel } from '../../ui/DatePanel'
import { localDay, parseDateInput, parseDay } from '../../ui/date-model'
import { DATE_COPY } from '../../ui/ui-copy'

const C = COPY.collection.cell

type Props = {
  value: PropValue | undefined
  onCommit: (value: PropValue | null) => void
  onDone: () => void
  seed?: string
  live?: boolean
}

type Draft = { start: string; end: string; ranged: boolean }
type Side = 'start' | 'end'

const at = (side: Side, day: string): Partial<Draft> => (side === 'start' ? { start: day } : { end: day })

/** 草稿 → 日期值：没有开始日 = 清空；开了结束日期但还没填结束日 = 单日；有一端不是日历日 = undefined（不写） */
function resultOf(d: Draft): string | null | undefined {
  if (d.start === '') return null
  if (!isCalendarDate(d.start)) return undefined
  if (!d.ranged || d.end === '') return d.start
  return isCalendarDate(d.end) ? joinDate(d.start, d.end) : undefined
}

/** 打的字是不是一个完整的日期（开始框里也认整段区间） */
const spanOf = (text: string) => dateSpan(parseDateInput(text))

function draftOf(value: PropValue | undefined, seed: string | undefined): Draft {
  const seeded = seed === undefined ? undefined : spanOf(seed)
  const span = seeded ?? dateSpan(value)
  return span ? { start: span.start, end: span.end, ranged: span.start !== span.end } : { start: '', end: '', ranged: false }
}

/** 这一格的字读得出来（空也算：空 = 清掉这一端） */
function readable(side: Side, text: string): boolean {
  const t = text.trim()
  return t === '' || parseDay(t) !== undefined || (side === 'start' && spanOf(t) !== undefined)
}

export function DateEditor({ value, onCommit, onDone, seed, live = false }: Props) {
  const [draft, setDraft] = useState(() => draftOf(value, seed))
  /** 两个文本框里的字：敲到一半的「2026-1」只在这里，读得出完整日期才进草稿 */
  const [texts, setTexts] = useState(() => {
    const d = draftOf(value, seed)
    return { start: seed !== undefined && !spanOf(seed) ? seed : d.start, end: d.end }
  })
  /** 点日历写进哪一端 */
  const [side, setSide] = useState<Side>('start')
  const [bad, setBad] = useState<Side | null>(null)
  const initial = typeof value === 'string' ? value : null
  const startRef = useRef<HTMLInputElement>(null)
  /** 已提交或已放弃：关闭时不再补交 */
  const settled = useRef(false)
  const latest = useRef({ draft, initial, onCommit, live })
  latest.current = { draft, initial, onCommit, live }

  // 弹层首帧还没定位（visibility:hidden，聚焦不了）：等一帧。
  // 触屏上不自动聚焦：一聚焦文本框软键盘就弹出来，盖住下面的日历（点日子才是触屏上的主路径）
  useEffect(() => {
    if (seed === undefined && isTouchEditor()) return
    const raf = requestAnimationFrame(() => {
      const input = startRef.current
      if (!input) return
      input.focus()
      // 打字进来的：光标放在打的字后面接着敲；点开的：全选，直接敲就是换掉
      if (seed === undefined) input.select()
      else input.setSelectionRange(input.value.length, input.value.length)
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时聚焦一次
  }, [])

  // Esc 由弹层（document 捕获阶段）关掉，这里在 window 捕获阶段先记下「放弃」。
  // 开着时这个弹层就是最上面那层（日历常驻在里面，没有再套弹层），任何 Esc 关的都是它
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settled.current = true
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 关闭（点外面 / 换格子）时草稿没交：补交一次
  useEffect(
    () => () => {
      const now = latest.current
      if (settled.current || now.live) return
      const next = resultOf(now.draft)
      if (next !== undefined && next !== now.initial) now.onCommit(next)
    },
    [],
  )

  /** typed = 这一端的字是用户正在敲的，不拿草稿改写（「2026/1/2」敲完之前不该被换成「2026-01-02」） */
  const update = (patch: Partial<Draft>, typed?: Side): Draft => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setTexts((t) => ({ start: typed === 'start' ? t.start : next.start, end: typed === 'end' ? t.end : next.end }))
    const result = resultOf(next)
    if (live && result !== undefined) onCommit(result)
    return next
  }

  const finish = (next: string | null | undefined): void => {
    if (next === undefined) return
    settled.current = true
    if (next !== initial) onCommit(next)
    onDone()
  }

  const type = (s: Side, text: string): void => {
    setTexts((t) => ({ ...t, [s]: text }))
    setBad(null)
    const t = text.trim()
    if (t === '') return void update(at(s, ''), s)
    const span = s === 'start' ? spanOf(t) : undefined
    // 开始框里敲 / 粘了一整段区间：两端一起填上（「2026-01-02 ~ 2026-01-02」这种两端同一天的就是单日）
    if (span) return void update(span.start !== span.end ? { start: span.start, end: span.end, ranged: true } : { start: span.start }, s)
    const day = parseDay(t)
    if (day) update(at(s, day), s)
  }

  /** 失焦：字换成草稿里的规范写法（认不出的回退） */
  const settle = (s: Side): void => {
    setBad(null)
    setTexts((t) => ({ ...t, [s]: latest.current.draft[s] }))
  }

  const keys = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    // 框里的字认不出：标红不关（静默回退的话，用户以为交上去的是自己敲的那个）
    const wrong = (['start', 'end'] as const).find((s) => (s === 'start' || draft.ranged) && !readable(s, texts[s]))
    if (wrong) return setBad(wrong)
    finish(resultOf(draft))
  }

  const pick = (day: string, viaEnter: boolean): void => {
    const next = update(at(side, day))
    // 开了结束日期、刚选完开始：轮到结束（Enter 也不提交，区间还没选完）
    if (draft.ranged && side === 'start') return setSide('end')
    if (viaEnter) finish(resultOf(next))
  }

  const box = (s: Side): string => 'cl-input' + (draft.ranged && side === s ? ' is-active' : '') + (bad === s ? ' is-bad' : '')
  const field = (s: Side) => (
    <input
      ref={s === 'start' ? startRef : undefined}
      type="text"
      className={box(s)}
      value={texts[s]}
      placeholder={DATE_COPY.placeholder}
      autoComplete="off"
      spellCheck={false}
      onFocus={() => setSide(s)}
      onChange={(e) => type(s, e.target.value)}
      onBlur={() => settle(s)}
      onKeyDown={keys}
    />
  )

  return (
    <div className="cl-date-editor">
      <label className="cl-date-row">
        <span>{C.date.start}</span>
        {field('start')}
      </label>
      <Checkbox
        className="cl-date-toggle"
        label={C.date.range}
        checked={draft.ranged}
        onChange={(ranged) => {
          update({ ranged, end: draft.end || draft.start })
          setSide(ranged ? 'end' : 'start')
        }}
        onKeyDown={keys}
      />
      {draft.ranged && (
        <label className="cl-date-row">
          <span>{C.date.end}</span>
          {field('end')}
        </label>
      )}
      <DatePanel
        className="cl-date-panel"
        value={draft[side] || draft.start || null}
        range={draft.ranged && draft.start && draft.end ? { start: draft.start, end: draft.end } : null}
        todayButton={false}
        onPick={pick}
      />
      <div className="cl-date-foot">
        <button type="button" className="cl-bar-btn" onClick={() => (live ? update({ start: localDay() }) : finish(resultOf({ ...draft, start: localDay() })))}>
          {C.date.today}
        </button>
        <button type="button" className="cl-bar-btn" onClick={() => (live ? update({ start: '', end: '', ranged: false }) : finish(null))}>
          {C.clear}
        </button>
      </div>
    </div>
  )
}
