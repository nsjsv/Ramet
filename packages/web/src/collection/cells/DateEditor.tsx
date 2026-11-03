// ---------- 日期编辑弹层：开始日 +「结束日期」开关 + 结束日 +「今天」「清除」 ----------
// 改的是草稿：Enter /「今天」/「清除」提交并关闭；点弹层外面关闭时草稿和原值不同也提交（同输入框失焦提交）；
// Esc 放弃草稿。用原生 <input type="date">（键盘逐段输入与日历都由浏览器给）。
// 表格里直接打字进编辑：原生日期框收不了半截文字，打的字只有本身是一个完整日期（区间）时才作初值。
// live（批量栏）：每次草稿变了就报给调用方（那边只记草稿，「应用」才写），「今天」「清除」也只改草稿，关闭时不再补交 ——
// 批量改值一次动很多行，不能让一个顺手的按钮直接写下去。
import { useEffect, useRef, useState } from 'react'
import { dateSpan, isCalendarDate, joinDate, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { localDay, parseDateInput } from '../prop-meta'

const C = COPY.collection.cell

type Props = {
  value: PropValue | undefined
  onCommit: (value: PropValue | null) => void
  onDone: () => void
  seed?: string
  live?: boolean
}

type Draft = { start: string; end: string; ranged: boolean }

/** 草稿 → 日期值：没有开始日 = 清空；开了结束日期但还没填结束日 = 单日；有一端不是日历日 = undefined（不写） */
function resultOf(d: Draft): string | null | undefined {
  if (d.start === '') return null
  if (!isCalendarDate(d.start)) return undefined
  if (!d.ranged || d.end === '') return d.start
  return isCalendarDate(d.end) ? joinDate(d.start, d.end) : undefined
}

function draftOf(value: PropValue | undefined, seed: string | undefined): Draft {
  const seeded = seed === undefined ? undefined : dateSpan(parseDateInput(seed))
  const span = seeded ?? dateSpan(value)
  return span ? { start: span.start, end: span.end, ranged: span.start !== span.end } : { start: '', end: '', ranged: false }
}

export function DateEditor({ value, onCommit, onDone, seed, live = false }: Props) {
  const [draft, setDraft] = useState(() => draftOf(value, seed))
  const initial = typeof value === 'string' ? value : null
  const startRef = useRef<HTMLInputElement>(null)
  /** 已提交或已放弃：关闭时不再补交 */
  const settled = useRef(false)
  const latest = useRef({ draft, initial, onCommit, live })
  latest.current = { draft, initial, onCommit, live }

  useEffect(() => startRef.current?.focus(), [])

  // Esc 由弹层（document 捕获阶段）关掉，这里在 window 捕获阶段先记下「放弃」。
  // 开着时这个弹层就是最上面那层（里面没有再套弹层），任何 Esc 关的都是它
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

  const update = (patch: Partial<Draft>): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    const result = resultOf(next)
    if (live && result !== undefined) onCommit(result)
  }

  const finish = (next: string | null | undefined): void => {
    if (next === undefined) return
    settled.current = true
    if (next !== initial) onCommit(next)
    onDone()
  }

  const keys = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(resultOf(draft))
    }
  }

  return (
    <div className="cl-date-editor">
      <label className="cl-date-row">
        <span>{C.date.start}</span>
        <input ref={startRef} type="date" className="cl-input" value={draft.start} onChange={(e) => update({ start: e.target.value })} onKeyDown={keys} />
      </label>
      <label className="cl-date-toggle">
        <input
          type="checkbox"
          checked={draft.ranged}
          onChange={(e) => update({ ranged: e.target.checked, end: draft.end || draft.start })}
          onKeyDown={keys}
        />
        <span>{C.date.range}</span>
      </label>
      {draft.ranged && (
        <label className="cl-date-row">
          <span>{C.date.end}</span>
          <input type="date" className="cl-input" value={draft.end} onChange={(e) => update({ end: e.target.value })} onKeyDown={keys} />
        </label>
      )}
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
