/* ---------- 代回复：把草稿流式写进评论框（module store）----------
 * 收件箱「代回复」跳到 `?comment=<串>&draft=1` / `?block=<块>&draft=1`，评论宿主（CommentsHost）打开那个串 / 在那一块开新评论框，
 * 再调 startReplyDraft：用 ⌘J 同一套（POST /api/quick，kind 'reply'；用户自己的当前连接或本地通道）生成，增量进这里，
 * 评论框（CommentComposer 的 draftFor）把它写进框里。只进框、不发：本人改完点发送，作者就是本人。
 * 一次只起草一份：target = 串 id（回复）或 DRAFT_ID（新评论框，另按锚点对象认，免得写进后来另选的那段字的框）。
 * 同一份草稿可能有几个框都能接（整页讨论区和抽屉里同一个串、窄屏浮层换成右侧卡片）：只给最后挂上的那个，它卸了再交回前一个。
 * 框里的字被用户动过就停（stopReplyDraft），不跟用户抢；换页、宿主卸载也停。
 * 能不能用、失败文案、要不要给「去设置」都和 ⌘J 同一套（quickReadiness / streamQuick / needsSettings）。 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { needsSettings, quickReadiness, streamQuick, type QuickBody } from '../quick-api'
import type { Anchor } from './comments-api'

/** 哪一份草稿：串 id（回复），或 DRAFT_ID + 新评论框的锚点 */
export type DraftKey = { target: string; anchor?: Anchor }

export type ReplyDraft = {
  target: string
  anchor?: Anchor
  /** 到目前为止生成的字（去掉了开头的空白） */
  text: string
  phase: 'running' | 'done' | 'error'
  message: string
  /** 失败原因去设置里能解决（没配连接、本地通道没选 agent…）：给「去设置」 */
  settings: boolean
}

type Snap = { draft: ReplyDraft | null; holders: ReadonlyMap<number, string> }

let snap: Snap = { draft: null, holders: new Map() }
let ctrl: AbortController | null = null
let seq = 0
const listeners = new Set<() => void>()

function set(patch: Partial<Snap>): void {
  snap = { ...snap, ...patch }
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function update(c: AbortController, patch: Partial<ReplyDraft>): void {
  if (ctrl !== c || !snap.draft) return
  set({ draft: { ...snap.draft, ...patch } })
}

/** 开始起草（已有的一份先停掉） */
export function startReplyDraft(key: DraftKey, body: QuickBody): void {
  ctrl?.abort()
  const c = new AbortController()
  ctrl = c
  set({ draft: { target: key.target, ...(key.anchor ? { anchor: key.anchor } : {}), text: '', phase: 'running', message: '', settings: false } })
  void (async () => {
    const ready = await quickReadiness()
    if (c.signal.aborted) return
    if (!ready.ok) return update(c, { phase: 'error', message: ready.message, settings: true })
    let text = ''
    const out = await streamQuick(body, (d) => {
      text += d
      update(c, { text: text.trimStart() })
    }, c.signal)
    if (c.signal.aborted) return
    if (!out.ok) return update(c, { phase: 'error', message: out.message, settings: needsSettings(out.code) })
    update(c, { text: text.trim(), phase: 'done' })
  })()
}

/** 停掉并丢掉这份草稿（框里已经写进去的字留着）。给了 target 就只停这一份 */
export function stopReplyDraft(target?: string): void {
  if (target !== undefined && snap.draft?.target !== target) return
  ctrl?.abort()
  ctrl = null
  if (snap.draft) set({ draft: null })
}

/** 评论框接哪份草稿：这个框挂着就登记，是最后挂上的那个才拿得到 */
export function useReplyDraft(key: DraftKey | undefined): ReplyDraft | null {
  const [id] = useState(() => ++seq)
  const target = key?.target
  useEffect(() => {
    if (!target) return
    set({ holders: new Map(snap.holders).set(id, target) })
    return () => {
      const holders = new Map(snap.holders)
      holders.delete(id)
      set({ holders })
    }
  }, [id, target])
  const { draft, holders } = useSyncExternalStore(subscribe, () => snap)
  if (!key || !draft || draft.target !== key.target || draft.anchor !== key.anchor) return null
  let last = 0
  for (const [h, t] of holders) if (t === key.target && h > last) last = h
  return last === id ? draft : null
}
