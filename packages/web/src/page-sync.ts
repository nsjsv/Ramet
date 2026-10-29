/* 页面列表的增量同步：收到 changed 不整表重拉，带上次的游标与成员指纹取 GET /api/pages/sync，
 * 服务端只回变过的页（up = 现状，rm = 已看不见的 id）；游标过旧 / 成员关系变了 / 首次则回整表（full）。
 * 本文件只放纯逻辑：合并、缓存读写、单飞调度。React 侧在 App.tsx 的 refresh()。 */

import { comparePages } from '@ramet/shared/page-tree'
import type { Page, PageSync } from './api'

/** 上一次同步的位置：两者都来自同一次响应 */
export interface SyncMark {
  cursor: string
  members: string
}

/** 本地缓存（localStorage 同一个 key）：游标与它对应的页面列表一起存，刷新网页后带着游标增量同步 */
export interface PagesCache {
  mark: SyncMark | null
  pages: Page[]
}

/** 同步结果并进当前列表：full 直接替换；增量先摘 rm、再以服务端现状覆盖 / 补上 up，最后按服务端口径重排。
 *  当前列表里的本地乐观改动（改名 / 新建 / 摘除）只要没被这次增量碰到就原样保留 */
export function applyPageSync(cur: readonly Page[] | null, res: PageSync): Page[] {
  if ('full' in res) return res.full
  const byId = new Map((cur ?? []).map((p) => [p.id, p]))
  for (const id of res.rm) byId.delete(id)
  for (const page of res.up) byId.set(page.id, page)
  return [...byId.values()].sort(comparePages)
}

/** 读缓存：格式 {cursor, members, pages}；整表数组的旧格式照样播种列表但没有游标，下次整表拉一次即自愈。
 *  解析失败 / 结构不对按无缓存（null），不抛错（脏数据不能白屏） */
export function readPagesCache(raw: string | null): PagesCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return { mark: null, pages: parsed as Page[] }
  if (!parsed || typeof parsed !== 'object') return null
  const { cursor, members, pages } = parsed as { cursor?: unknown; members?: unknown; pages?: unknown }
  if (!Array.isArray(pages)) return null
  const mark = typeof cursor === 'string' && typeof members === 'string' ? { cursor, members } : null
  return { mark, pages: pages as Page[] }
}

/** 从 localStorage 读（隐私模式下 getItem 也可能抛：按无缓存） */
export function loadPagesCache(key: string): PagesCache | null {
  try {
    return readPagesCache(localStorage.getItem(key))
  } catch {
    return null
  }
}

export function writePagesCache(mark: SyncMark, pages: readonly Page[]): string {
  return JSON.stringify({ cursor: mark.cursor, members: mark.members, pages })
}

/** 单飞调度：同一时刻只有一个同步请求在途；在途期间又被要求同步就记一笔，完成后再来一次
 *  （在途请求的快照可能早于这次变更）。run() 的 Promise 在「调用之后才发出」的那次同步完成时兑现，
 *  给出服务端确认过的列表（失败 = null）。
 *  另记一份「服务端确认过的列表」（只并服务端的响应，不含本地乐观改动），缓存只存它：
 *  乐观改名若没写进库就关了网页，缓存里不能留下服务端没有的标题（增量不会再纠正一个没变过的页）。
 *  没有这份底时不带游标（增量没有可以并进去的底） */
export function createPageSyncer(deps: {
  cache: PagesCache | null
  fetch: (since: SyncMark | null) => Promise<PageSync>
  onResult: (res: PageSync, mark: SyncMark, confirmed: Page[]) => void
  onError: (err: unknown) => void
}): { run: () => Promise<readonly Page[] | null> } {
  let mark = deps.cache?.mark ?? null
  let confirmed: Page[] | null = deps.cache?.pages ?? null
  let inflight = false
  // 等下一次发出的同步的调用方（在途期间调 run 的都排在这里）
  let waiting: ((pages: readonly Page[] | null) => void)[] = []
  const start = (): void => {
    inflight = true
    const mine = waiting
    waiting = []
    deps
      .fetch(mark && confirmed ? mark : null)
      .then(
        (res) => {
          confirmed = applyPageSync(confirmed, res)
          mark = { cursor: res.cursor, members: res.members }
          deps.onResult(res, mark, confirmed)
          for (const done of mine) done(confirmed)
        },
        (err: unknown) => {
          deps.onError(err)
          for (const done of mine) done(null)
        },
      )
      .finally(() => {
        inflight = false
        if (waiting.length) start()
      })
  }
  const run = (): Promise<readonly Page[] | null> => {
    // executor 形式：web tsconfig 的 lib 还没到 ES2024（没有 Promise.withResolvers）
    const promise = new Promise<readonly Page[] | null>((resolve) => waiting.push(resolve))
    if (!inflight) start()
    return promise
  }
  return { run }
}

/* 当前外壳的同步入口（App 挂载时登记）：编辑器里的 link-watcher 删子页前要拿服务端现状确认结构，
 * 借它发一次增量同步，不另取整表 */
let current: (() => Promise<readonly Page[] | null>) | null = null
export function bindPageSync(run: () => Promise<readonly Page[] | null>): () => void {
  current = run
  return () => {
    if (current === run) current = null
  }
}
/** 立刻同步一次，给出服务端确认过的页面列表；没有外壳 / 失败 = null */
export function syncPagesNow(): Promise<readonly Page[] | null> {
  return current ? current() : Promise.resolve(null)
}
