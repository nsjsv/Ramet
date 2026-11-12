/* ---------- 当前页的评论（module store + useSyncExternalStore）----------
 * 一次只服务一个页面（编辑页或公开页）：bindCommentsPage 换页即换，拆除时清空。
 * 服务端状态就是 GET /api/pages/:id/comments 的整份结果（量级小，不做增量）：写完先按响应改本地，
 * 别人的写入靠 page:<id> 文档上的 stateless `{"t":"comments"}`（editor-session.ts 转到 commentsChanged）重拉。
 * 激活的串 / 抽屉开着哪个串也放这里：划词菜单（非 React）、顶栏按钮、高亮点击、收件箱深链都要能打开它。
 * 激活的串怎么呈现看 wide（CommentMargin 量出来的）：放得下右侧评论栏是栏里展开的卡片，放不下是浮层。 */

import { useSyncExternalStore } from 'react'
import { listenControl } from '../control'
import { dropInboxItem } from '../inbox/inbox-store'
import { selfId } from '../people'
import { commentsApi, type Anchor, type Comment, type Thread } from './comments-api'

/** 激活的串：看一个已有的串，或给刚选中的字写第一条评论（还没有串）。宽屏是右侧展开的卡片，窄屏是浮层。
 *  initial = 新评论框里预先写好的字（正文里 @空间 AI 开的框预填它的记号） */
export type Popover = { kind: 'thread'; threadId: string } | { kind: 'draft'; anchor: Anchor; initial?: string }

/** 草稿（还没有串）在高亮与右侧卡片里用的 id */
export const DRAFT_ID = '__draft'

type State = {
  pageId: string | null
  /** public = 公开页：只读，只有未解决的串，没有实时信号 */
  mode: 'auth' | 'public'
  threads: Thread[]
  loaded: boolean
  failed: boolean
  popover: Popover | null
  /** 正文右侧放得下评论栏（CommentMargin 量）：true 时激活的串画成卡片，不弹浮层 */
  wide: boolean
  /** 指针停在哪张卡片上：它在正文里的高亮跟着加深 */
  hover: string | null
  drawer: boolean
  /** 抽屉里展开的串 */
  expanded: string | null
}

const EMPTY: State = { pageId: null, mode: 'auth', threads: [], loaded: false, failed: false, popover: null, wide: false, hover: null, drawer: false, expanded: null }
let state: State = EMPTY
const listeners = new Set<() => void>()

function set(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

/** 换页计数：在飞的拉取回来时页面已经换了，结果丢掉 */
let generation = 0
let inflight = false
let again = false
let timer: number | undefined

export async function refreshComments(): Promise<void> {
  const { pageId, mode } = state
  if (!pageId) return
  if (inflight) {
    again = true
    return
  }
  inflight = true
  const gen = generation
  try {
    const threads = mode === 'public' ? await commentsApi.listPublic(pageId) : await commentsApi.list(pageId)
    if (gen === generation) set({ threads, loaded: true, failed: false })
  } catch (err) {
    console.error(err)
    if (gen === generation) set({ loaded: true, failed: true })
  } finally {
    inflight = false
    if (again) {
      again = false
      void refreshComments()
    }
  }
}

function scheduleRefresh(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void refreshComments(), 150)
}

/** 页面挂上评论：先拉一次；登录态再跟着控制通道的重连补拉（断线期间漏掉的 stateless 收不到）。返回拆除函数 */
export function bindCommentsPage(pageId: string, mode: 'auth' | 'public'): () => void {
  generation++
  const gen = generation
  inflight = false
  again = false
  set({ ...EMPTY, pageId, mode, wide: state.wide }) // wide 是版面的事，不随换页清
  void refreshComments()
  const off = mode === 'auth' ? listenControl((ev) => ev === 'sync' && scheduleRefresh()) : () => undefined
  return () => {
    off()
    if (gen !== generation) return
    generation++
    window.clearTimeout(timer)
    set(EMPTY)
  }
}

/** 收到 page:<id> 的评论信号（别人写了评论） */
export function commentsChanged(pageId: string): void {
  if (state.pageId === pageId && state.mode === 'auth') scheduleRefresh()
}

function replaceThread(id: string, fn: (t: Thread) => Thread | null): void {
  const threads: Thread[] = []
  for (const t of state.threads) {
    if (t.id !== id) threads.push(t)
    else {
      const next = fn(t)
      if (next) threads.push(next)
    }
  }
  set({ threads })
}

const nowIso = (): string => new Date().toISOString()

export async function createThread(kind: 'inline' | 'page', body: string, anchor?: Anchor): Promise<Thread> {
  const pageId = state.pageId
  if (!pageId) throw new Error('no page')
  const thread = await commentsApi.create(pageId, { kind, body, ...(anchor ? { anchor } : {}) })
  if (state.pageId === pageId && !state.threads.some((t) => t.id === thread.id)) set({ threads: [...state.threads, thread] })
  return thread
}

export async function replyTo(threadId: string, body: string): Promise<void> {
  const comment = await commentsApi.reply(threadId, body)
  replaceThread(threadId, (t) =>
    t.comments.some((c) => c.id === comment.id) ? t : { ...t, readAt: nowIso(), comments: [...t.comments, comment] },
  )
}

export async function setResolved(threadId: string, resolved: boolean): Promise<void> {
  const thread = await commentsApi.resolve(threadId, resolved)
  replaceThread(threadId, () => thread)
}

export async function editComment(commentId: string, body: string): Promise<void> {
  const comment = await commentsApi.edit(commentId, body)
  for (const t of state.threads) {
    if (t.comments.some((c) => c.id === commentId)) {
      replaceThread(t.id, (x) => ({ ...x, comments: x.comments.map((c) => (c.id === commentId ? comment : c)) }))
    }
  }
}

/** 删除规则同服务端：回复整条消失；首条还有回复时留「已删除」占位；串里没有活评论了整串消失 */
export async function removeComment(commentId: string): Promise<void> {
  const { threadDeleted } = await commentsApi.remove(commentId)
  const owner = state.threads.find((t) => t.comments.some((c) => c.id === commentId))
  if (!owner) return
  if (threadDeleted) {
    replaceThread(owner.id, () => null)
    if (state.popover?.kind === 'thread' && state.popover.threadId === owner.id) set({ popover: null })
    return
  }
  const first = owner.comments[0]?.id === commentId
  replaceThread(owner.id, (t) => ({
    ...t,
    comments: first
      ? t.comments.map((c): Comment => (c.id === commentId ? { ...c, deleted: true, body: '' } : c))
      : t.comments.filter((c) => c.id !== commentId),
  }))
}

/** 这个串里有我还没读到的别人的发言 */
function unread(t: Thread): boolean {
  const me = selfId()
  const since = t.readAt ? Date.parse(t.readAt) : -Infinity
  return t.comments.some((c) => !c.deleted && c.author?.id !== me && Date.parse(c.createdAt) > since)
}

/** 打开了这个串（浮层 / 抽屉里展开）：记为已读，收件箱里的那条先摘掉。公开页不记 */
export function markThreadRead(threadId: string): void {
  if (state.mode !== 'auth') return
  const t = state.threads.find((x) => x.id === threadId)
  if (!t || !unread(t)) return
  replaceThread(threadId, (x) => ({ ...x, readAt: nowIso() }))
  dropInboxItem(`comment:${threadId}`)
  void commentsApi.read(threadId).catch((err: unknown) => console.error(err))
}

// 激活串 / 写草稿顺手关抽屉：抽屉盖在右侧，会挡住评论栏；窄屏上它占满全宽，浮层也只能叠在它上面
export function openThread(threadId: string): void {
  set({ popover: { kind: 'thread', threadId }, drawer: false, expanded: null })
  markThreadRead(threadId)
}

export function openDraft(anchor: Anchor, initial?: string): void {
  set({ popover: { kind: 'draft', anchor, ...(initial ? { initial } : {}) }, drawer: false, expanded: null })
}

export function closePopover(): void {
  if (state.popover) set({ popover: null })
}

export function setWide(wide: boolean): void {
  if (state.wide !== wide) set({ wide })
}

export function hoverThread(threadId: string | null): void {
  if (state.hover !== threadId) set({ hover: threadId })
}

export function openDrawer(expanded: string | null = null): void {
  set({ drawer: true, expanded, popover: null })
  if (expanded) markThreadRead(expanded)
}

export function closeDrawer(): void {
  if (state.drawer) set({ drawer: false, expanded: null })
}

export function toggleDrawer(): void {
  if (state.drawer) closeDrawer()
  else openDrawer()
}

export function expandThread(threadId: string | null): void {
  set({ expanded: threadId })
  if (threadId) markThreadRead(threadId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useComments(): State {
  return useSyncExternalStore(subscribe, () => state)
}

/** 未解决的串数（顶栏按钮）；store 不是这一页的时候是 0 */
export function unresolvedCount(s: State, pageId: string | undefined): number {
  return s.pageId === pageId ? s.threads.filter((t) => !t.resolvedAt).length : 0
}
