// ---------- 上次编辑的缓存（菜单打开即画，不等请求） ----------
// 两层合起来看：
//   - 服务端：GET /api/pages/:id/edit-marks，整页 + 全部块一次给齐。进页面预取（Editor.tsx），菜单打开时后台再刷，
//     别人编辑停下后也刷一次（editor/edit-marks-local.ts），到了通知订阅方原地更新。
//   - 本地：自己刚打的字（edit-marks-local.ts 当场记）。服务端要等改动停 ~2s 才落库，只看服务端会先显示上一个人。
//     本地标记在场就以它为准，等到一次开始于它之后 FLUSHED_MS 的拉取回来才让位给服务端。
//     两边时刻都取本机时钟，不拿本机时间和服务端时间比（两台机器的钟不一定对得上）。
// 每页一份，不过期。

import { api, type EditMark, type EditMarks } from './api'
import { selfPerson } from './people'

/** 菜单里画的一条：人名 / 头像已解析好 */
export interface EditInfo {
  edited_at: string
  user_id: string | null
  username: string | null
  avatar: string | null
  actor: 'user' | 'agent'
  actor_agent: string | null
}

interface PageMarks {
  server: EditMarks | null
  /** 本地记的自己的编辑时刻（ms）：整页 / 块 id → 时刻 */
  localPage: number | null
  localBlocks: Map<string, number>
  inflight: Promise<void> | null
}

/** 改动停下到服务端落库的上限（Hocuspocus 防抖 ~2s）留足余量 */
const FLUSHED_MS = 5000

const pages = new Map<string, PageMarks>()
const listeners = new Set<() => void>()

function entry(pageId: string): PageMarks {
  let e = pages.get(pageId)
  if (!e) pages.set(pageId, (e = { server: null, localPage: null, localBlocks: new Map(), inflight: null }))
  return e
}

function notify(): void {
  listeners.forEach((l) => l())
}

export function subscribeEditMarks(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 向服务端取一次（同页在途的请求复用）；失败只记日志，缓存保持原样 */
export function refreshEditMarks(pageId: string): Promise<void> {
  const e = entry(pageId)
  if (e.inflight) return e.inflight
  const started = Date.now()
  e.inflight = api
    .editMarks(pageId)
    .then((marks) => {
      e.server = marks
      // 这次拉取开始前 FLUSHED_MS 以上的本地标记，服务端已经落库、拉回来的就是它：让位
      const flushed = started - FLUSHED_MS
      if (e.localPage !== null && e.localPage < flushed) e.localPage = null
      for (const [id, at] of e.localBlocks) if (at < flushed) e.localBlocks.delete(id)
      notify()
    })
    .catch((err: unknown) => console.error(err))
    .finally(() => {
      e.inflight = null
    })
  return e.inflight
}

/** 自己刚改了这些块（及整页）：当场记下，菜单立刻显示自己 */
export function noteLocalEdits(pageId: string, blockIds: Iterable<string>): void {
  const e = entry(pageId)
  const now = Date.now()
  e.localPage = now
  for (const id of blockIds) e.localBlocks.set(id, now)
  notify()
}

function fromServer(marks: EditMarks, mark: EditMark): EditInfo {
  const user = mark.user_id ? marks.users[mark.user_id] : undefined
  return {
    edited_at: mark.at,
    user_id: mark.user_id,
    username: user?.username ?? null,
    avatar: user?.avatar ?? null,
    actor: mark.actor,
    actor_agent: mark.actor_agent,
  }
}

/** 整页（blockId 缺省）或某块的上次编辑；有本地标记就是自己，否则服务端的；都没有 → null */
export function editInfoOf(pageId: string, blockId?: string): EditInfo | null {
  const e = pages.get(pageId)
  if (!e) return null
  const mark = e.server ? (blockId === undefined ? e.server.page : e.server.blocks[blockId]) : null
  const server = mark && e.server ? fromServer(e.server, mark) : null
  const local = blockId === undefined ? e.localPage : e.localBlocks.get(blockId)
  const self = selfPerson()
  if (local === undefined || local === null || !self) return server
  return { edited_at: new Date(local).toISOString(), user_id: self.id, username: self.username, avatar: self.avatar, actor: 'user', actor_agent: null }
}
