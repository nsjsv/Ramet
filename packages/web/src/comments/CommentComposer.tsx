/* ---------- 评论输入框 ----------
 * 就是对话输入框（editor/composer-input.tsx：段落 + 提及 chip，对外是记号文字），这里只接两件事：
 *   - `@` 只出「成员」（本空间成员，去掉自己）：查询解析、一次性触发会话、键位、菜单都用对话输入框那一套
 *     （mention-query / trigger-session / mention-nav / mention-menu），候选源只给成员，分类固定在 person；
 *   - Enter 发送、Shift+Enter 换行、Esc 取消。 */

import { useEffect, useRef, useState } from 'react'
import type { Schema } from '@milkdown/kit/prose/model'
import ComposerInput, { type ComposerInputHandle } from '../editor/composer-input'
import MentionMenu from '../editor/mention-menu'
import { candidatesFor, mentionQuery, type Candidate, type MentionQuery, type MentionSources } from '../editor/mention-query'
import { mentionKey, type MentionKeyAction } from '../editor/mention-nav'
import { advance, type Session } from '../editor/trigger-session'
import { COPY } from '../copy'
import { loadSpaceMembers, selfId, spaceMembers } from '../people'
import { COMMENT_MAX } from './comments-api'

const C = COPY.comments

interface Props {
  /** 主编辑器的 schema（chip 的节点 spec 借它的）；编辑器没建好时 undefined，等 tick */
  getSchema: () => Schema | undefined
  tick: number
  spaceId: string | null
  placeholder: string
  initial?: string
  autoFocus?: boolean
  /** 失败时抛错（输入框保留原文、显示错误） */
  onSubmit: (text: string) => Promise<void>
  /** 给了就有「取消」按钮，Esc 也走它 */
  onCancel?: () => void
  submitLabel?: string
}

export default function CommentComposer({ getSchema, tick, spaceId, placeholder, initial = '', autoFocus, onSubmit, onCancel, submitLabel }: Props) {
  const ref = useRef<ComposerInputHandle>(null)
  const [empty, setEmpty] = useState(!initial.trim())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mention, setMention] = useState<(MentionQuery & { base: number }) | null>(null)
  const [active, setActive] = useState(0)
  const [, setMembersTick] = useState(0)
  const session = useRef<Session | null>(null)
  const focused = useRef(false)

  // 框的视图在主编辑器 schema 到位后才建（子组件 effect 先于这里跑）：第一次建好时聚焦
  useEffect(() => {
    if (!autoFocus || focused.current || !ref.current?.dom()) return
    focused.current = true
    ref.current.focus()
  }, [autoFocus, tick])

  const me = selfId()
  const sources: MentionSources = {
    pages: null,
    agents: [],
    skills: [],
    people: spaceId ? (spaceMembers(spaceId) ?? []).filter((p) => p.id !== me) : [],
    recent: [],
  }
  const matches: Candidate[] = mention ? candidatesFor(mention, sources, 'person') : []

  const closeMention = (): void => {
    session.current = null
    setMention(null)
  }

  /** 内容 / 光标变了：按会话推进（只认 `@`，`[[` 在评论里没有意义） */
  const syncMention = (typed: boolean): void => {
    const caret = ref.current?.caret() ?? null
    const q = caret ? mentionQuery(caret.text, caret.cursor) : null
    const parsed = caret && q && q.trigger === '@' ? q : null
    const prev = session.current
    const next = advance(prev, parsed && caret && { ...parsed, at: caret.base + parsed.start }, typed)
    session.current = next
    setMention(next && parsed && caret ? { ...parsed, base: caret.base } : null)
    if (next && next !== prev && spaceId) void loadSpaceMembers(spaceId).then(() => setMembersTick((t) => t + 1))
  }

  function pick(cand: Candidate): void {
    const q = mention
    const composer = ref.current
    closeMention()
    if (!q || !composer || cand.kind !== 'person') return
    composer.replace(q.base + q.start, q.base + q.end, `@[${cand.person.username}](user:${cand.person.id}) `)
    composer.focus()
  }

  function act(action: MentionKeyAction): void {
    if (action.type === 'move') {
      const n = matches.length
      if (n) setActive((i) => (((i + action.delta) % n) + n) % n)
    } else if (action.type === 'pick') pick(action.cand)
    else if (action.type === 'close') closeMention()
  }

  async function submit(): Promise<void> {
    const composer = ref.current
    const text = composer?.text().trim() ?? ''
    if (!composer || !text || busy) return
    if ([...text].length > COMMENT_MAX) return setError(C.tooLong(COMMENT_MAX))
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text)
      composer.setText('')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : C.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cm-composer">
      <div className="cm-composer-box">
        <ComposerInput
          ref={ref}
          getSchema={getSchema}
          tick={tick}
          initial={initial}
          placeholder={placeholder}
          onChange={(text, typed) => {
            setEmpty(!text.trim())
            syncMention(typed)
            setActive(0)
          }}
          onBlur={closeMention}
          onKeyDown={(e) => {
            if (mention && matches.length > 0) {
              const action = mentionKey(e, { category: 'person', query: mention.query, active: matches[active] })
              // 分类固定：「返回 / 进入」在这里没有意义，键照常给输入框
              if (!action || action.type === 'back' || action.type === 'enter') return false
              act(action)
              return true
            }
            if (e.key === 'Escape' && onCancel) {
              onCancel()
              return true
            }
            if (e.key !== 'Enter' || e.shiftKey) return false
            void submit()
            return true
          }}
        />
        {mention && matches.length > 0 && (
          <MentionMenu matches={matches} pages={null} trigger="@" category={null} activeIndex={active} onActive={setActive} onAct={act} />
        )}
      </div>
      {error && <div className="cm-error">{error}</div>}
      <div className="cm-composer-acts">
        {onCancel && (
          <button type="button" className="cm-btn" onClick={onCancel}>
            {C.cancel}
          </button>
        )}
        <button type="button" className="cm-btn is-primary" disabled={busy || empty} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()}>
          {submitLabel ?? C.send}
        </button>
      </div>
    </div>
  )
}
