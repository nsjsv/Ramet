/* ---------- 空间 AI 在前端的数据：这一页在哪个团队空间、那个空间的 AI 开没开、叫什么 ----------
 * 空间 AI 只有一个 id，按页面所在空间解析（服务端 agents/space-ai.ts），所以前端认它也得先知道「这一页在哪个空间」。
 * 数据就是 App 已有的两份列表：空间列表（GET /api/spaces 每项带 ai）与页面列表（space_id），App 经 syncSpaceAi 喂进来，不另发请求；
 * 空间 owner 改配置 / 删连接时服务端广播 control 的 changed，App 重拉空间列表，这里跟着变。
 * 订阅方（回复抬头的装饰、@ 候选、来源目录）只在「哪一页属于哪个空间」或「各空间的 AI」真变了时才被叫：
 * 改标题每敲一个字都会换一份页面列表，不能每次都让编辑器重算装饰。 */

import { useCallback, useSyncExternalStore } from 'react'
import type { Page, Space } from '../api'

/** 团队空间里的空间 AI；个人空间没有（null） */
export interface SpaceAiInfo {
  spaceId: string
  enabled: boolean
  name: string
}

/** 服务端没配过名字时的叫法，与服务端 SPACE_AI_DEFAULT_NAME 一致 */
export const SPACE_AI_DEFAULT_NAME = 'AI'
/** 名字上限，与服务端 SPACE_AI_NAME_MAX 一致（码点） */
export const SPACE_AI_NAME_MAX = 20

/** 一个空间的空间 AI：个人空间、还不知道是哪个空间 = null。列表接口之外来的空间对象（老缓存）没有 ai，按没启用算 */
export function spaceAiOfSpace(space: Space | undefined): SpaceAiInfo | null {
  if (!space || space.is_personal) return null
  return { spaceId: space.id, enabled: space.ai?.enabled === true, name: space.ai?.name.trim() || SPACE_AI_DEFAULT_NAME }
}

/** 名字是否合法：trim、压空白后 1–20 个码点（同服务端 normalizeSpaceAiName） */
export function normalizeSpaceAiName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ')
  const n = [...name].length
  return n >= 1 && n <= SPACE_AI_NAME_MAX ? name : null
}

let spacesNow: readonly Space[] | null = null
let pagesNow: readonly Page[] | null = null
/** 页面 → 空间；页面列表换了才重建 */
let pageSpace = new Map<string, string>()
/** 空间 → 空间 AI；内容没变就沿用旧对象（useSyncExternalStore 靠引用判断要不要重画） */
let bySpace = new Map<string, SpaceAiInfo>()
const listeners = new Set<() => void>()

function sameInfo(a: SpaceAiInfo | undefined, b: SpaceAiInfo): boolean {
  return a !== undefined && a.enabled === b.enabled && a.name === b.name
}

/** App 喂进来的最新列表。只在页面归属或空间 AI 真变了时通知 */
export function syncSpaceAi(spaces: readonly Space[] | null, pages: readonly Page[] | null): void {
  let changed = false
  if (pages !== pagesNow) {
    pagesNow = pages
    const next = new Map<string, string>()
    for (const p of pages ?? []) if (p.space_id) next.set(p.id, p.space_id)
    if (next.size !== pageSpace.size || [...next].some(([id, space]) => pageSpace.get(id) !== space)) changed = true
    pageSpace = next
  }
  if (spaces !== spacesNow) {
    spacesNow = spaces
    const next = new Map<string, SpaceAiInfo>()
    for (const s of spaces ?? []) {
      const info = spaceAiOfSpace(s)
      if (!info) continue
      const prev = bySpace.get(s.id)
      next.set(s.id, sameInfo(prev, info) ? prev! : info)
    }
    if (next.size !== bySpace.size || [...next].some(([id, info]) => bySpace.get(id) !== info)) changed = true
    bySpace = next
  }
  if (changed) listeners.forEach((l) => l())
}

export function subscribeSpaceAi(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 这一页所在团队空间的空间 AI；个人空间 / 不知道这一页在哪（公开页、列表还没到）= null */
export function spaceAiOfPage(pageId: string | undefined): SpaceAiInfo | null {
  if (!pageId) return null
  const space = pageSpace.get(pageId)
  return space ? (bySpace.get(space) ?? null) : null
}

/** 按空间 id 取：团队空间（不管开没开）有，个人空间 / 还不知道这个空间 = null。评论框只知道空间，不知道页面 */
export function spaceAiOfSpaceId(spaceId: string | null | undefined): SpaceAiInfo | null {
  return spaceId ? (bySpace.get(spaceId) ?? null) : null
}

export function useSpaceAiOfSpace(spaceId: string | null | undefined): SpaceAiInfo | null {
  const get = useCallback(() => spaceAiOfSpaceId(spaceId), [spaceId])
  return useSyncExternalStore(subscribeSpaceAi, get)
}

/** React 侧的 spaceAiOfPage：开关、改名、页面搬到别的空间都会重画 */
export function useSpaceAi(pageId: string | undefined): SpaceAiInfo | null {
  const get = useCallback(() => spaceAiOfPage(pageId), [pageId])
  return useSyncExternalStore(subscribeSpaceAi, get)
}
