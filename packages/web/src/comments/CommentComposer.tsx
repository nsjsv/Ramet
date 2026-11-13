/* ---------- 评论输入框 ----------
 * 就是对话输入框（editor/composer-input.tsx：段落 + 提及 chip，对外是记号文字），这里只接两件事：
 *   - `@` 只出「成员」（本空间成员，去掉自己）与一个 AI（固定在最前，查询词对得上才出）：查询解析、一次性触发会话、键位、菜单都用
 *     对话输入框那一套（mention-query / trigger-session / mention-nav / mention-menu），候选源只给成员，分类固定在 person；
 *     AI 是哪一个看空间（comment-ai.ts）：个人空间是 Genet，选中落成 GENET_MARK，发出去叫自己的 Genet 处理这个串（服务端 comments/genet-call.ts）；
 *     团队空间是空间 AI（开着时），落成它的记号，发出去叫空间 AI 回这个串（服务端 comments/space-ai-call.ts）；框里都是 agent chip；
 *   - Enter 发送、Shift+Enter 换行、Esc 取消；
 *   - 代回复（draftFor）：收件箱点「代回复」生成的草稿（reply-draft.ts）流式写进框里，下面一行显示进度 / 失败原因；
 *     框里原来有字、或用户在生成过程中动了框，就不再往里写（停掉生成），不跟用户抢。 */

import { useEffect, useRef, useState } from 'react'
import type { Schema } from '@milkdown/kit/prose/model'
import ComposerInput, { type ComposerInputHandle } from '../editor/composer-input'
import MentionMenu from '../editor/mention-menu'
import { candidatesFor, mentionQuery, type Candidate, type MentionQuery, type MentionSources } from '../editor/mention-query'
import { mentionKey, type MentionKeyAction } from '../editor/mention-nav'
import { advance, type Session } from '../editor/trigger-session'
import { COPY } from '../copy'
import { loadSpaceMembers, selfId, spaceMembers } from '../people'
import { openSettings } from '../settings-bus'
import { useSpaceAiOfSpace } from '../assistant/space-ai'
import { commentAi } from './comment-ai'
import { COMMENT_MAX } from './comments-api'
import { stopReplyDraft, useReplyDraft, type DraftKey, type ReplyDraft } from './reply-draft'

const C = COPY.comments

interface Props {
  /** 主编辑器的 schema（chip 的节点 spec 借它的）；编辑器没建好时 undefined，等 tick */
  getSchema: () => Schema | undefined
  tick: number
  spaceId: string | null
  /** 这页在私人区：@ 的 AI 是自己的 Genet，不是空间 AI */
  privatePage: boolean
  /** 函数 = 按这个空间能 @ 的 AI 的名字拼（没有 = null） */
  placeholder: string | ((ai: string | null) => string)
  initial?: string
  autoFocus?: boolean
  /** 失败时抛错（输入框保留原文、显示错误） */
  onSubmit: (text: string) => Promise<void>
  /** 给了就有「取消」按钮，Esc 也走它 */
  onCancel?: () => void
  /** 没有取消按钮时 Esc 走它（回复框：收起浮层 / 卡片）。PM 自己会把 Esc 标成已处理，外层的 Esc 监听收不到，只能从这里接 */
  onEscape?: () => void
  submitLabel?: string
  /** 代回复：接哪份草稿（串 id，或新评论框的锚点） */
  draftFor?: DraftKey
}

/** 草稿的进度 / 失败原因（失败能去设置里解决的给「去设置」，同 ⌘J） */
function DraftLine({ draft }: { draft: ReplyDraft }) {
  if (draft.phase === 'done') return null
  if (draft.phase === 'running') {
    return (
      <div className="cm-draft-line" role="status">
        <span className="cm-draft-busy">{C.drafting}</span>
        <button type="button" className="cm-link" onMouseDown={(e) => e.preventDefault()} onClick={() => stopReplyDraft(draft.target)}>
          {C.draftStop}
        </button>
      </div>
    )
  }
  return (
    <div className="cm-draft-line is-error" role="alert">
      <span>{draft.message}</span>
      {draft.settings && (
        <button
          type="button"
          className="cm-link"
          onClick={() => {
            stopReplyDraft(draft.target)
            openSettings('quick')
          }}
        >
          {COPY.quick.openSettings}
        </button>
      )}
    </div>
  )
}

export default function CommentComposer({ getSchema, tick, spaceId, privatePage, placeholder, initial = '', autoFocus, onSubmit, onCancel, onEscape, submitLabel, draftFor }: Props) {
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

  // 代回复：草稿每长一截就整框换成它。written = 上次写进去之后框里的字（null = 没在接）；框里的字和它对不上 = 用户动过
  const draft = useReplyDraft(draftFor)
  const written = useRef<string | null>(null)
  const writing = useRef(false)
  useEffect(() => {
    const composer = ref.current
    if (!draft || !composer) return
    const now = composer.text()
    if (now !== (written.current ?? '')) {
      written.current = null
      stopReplyDraft(draft.target)
      return
    }
    if (!draft.text || draft.text === now) return
    writing.current = true
    composer.setText(draft.text)
    writing.current = false
    written.current = composer.text()
  }, [draft])
  /** 框里的字变了：不是草稿写的、又和草稿写进去的不一样 = 用户接手了，停掉生成（草稿已经交给别的框了就不管它） */
  const onDraftEdit = (text: string): void => {
    if (writing.current || written.current === null || text === written.current) return
    written.current = null
    if (draft) stopReplyDraft(draft.target)
  }

  const ai = commentAi(useSpaceAiOfSpace(spaceId), privatePage)
  const me = selfId()
  const sources: MentionSources = {
    pages: null,
    agents: [],
    skills: [],
    people: spaceId ? (spaceMembers(spaceId) ?? []).filter((p) => p.id !== me) : [],
    recent: [],
  }
  const aiCand: Candidate[] =
    mention && ai && ai.label.toLowerCase().includes(mention.query.trim().toLowerCase()) ? [{ kind: 'agent', id: ai.id, label: ai.label }] : []
  const matches: Candidate[] = mention ? [...aiCand, ...candidatesFor(mention, sources, 'person')] : []

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
    const text = cand.kind === 'agent' ? (ai ? `${ai.mark} ` : null) : cand.kind === 'person' ? `@[${cand.person.username}](user:${cand.person.id}) ` : null
    if (!q || !composer || !text) return
    composer.replace(q.base + q.start, q.base + q.end, text)
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
          placeholder={typeof placeholder === 'string' ? placeholder : placeholder(ai?.label ?? null)}
          onChange={(text, typed) => {
            onDraftEdit(text)
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
            const escape = onCancel ?? onEscape
            if (e.key === 'Escape' && escape) {
              escape()
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
      {draft && <DraftLine draft={draft} />}
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
