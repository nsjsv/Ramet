/* ---------- 集合 store：一个集合在一页上只开一条协同连接，属性定义 / 视图 / 行窗口都从这里取 ----------
 * · 连接按集合 id 引用计数（整页、嵌入块、行页面属性区共用一条 page:<cid>）；最后一个使用者走了先保活一阵，
 *   拆掉后文档与窗口进冷缓存（collection-cache.ts）。窗口没人看了也留着（增量照常套；日期范围窗口只留最近的几个），
 *   要重取时只记 stale、再看时才取。
 * · schema：观察 Y.Map('collection') → toJSON → parseCollection（服务端确认同步过才给，之前是 null）。
 * · 窗口按范围区分（不限 / 按组 / 按日期范围，键与判定在 collection-windows.ts）：GET rows 取首屏 / 续取；
 *   收到集合文档的 stateless 增量（t = 'collection.rows'）用 applyRowsDelta 套上，
 *   reset 表示顺序基准变了，全部窗口重取。视图的筛选 / 排序 / 分组（及它们引用的属性定义）一变就重取。
 * · 行的进出与改名服务端不推：App 每次拿到新页面列表就 syncPages，这里比较集合的子页集合，
 *   有进出就重取，只改了标题就本地改窗口里那一行。
 * · 写全走 REST，乐观更新合成一条增量经 applyRowsDelta 套上（计数按旧行 / 新行精确增减）；失败重取并给提示。
 *   新建也是乐观的：客户端定 id、先插行，确认之前对这一行的写排在确认之后发（pending）。
 *   服务端随后发来的同一改动（投影器的增量）里，prev 对已乐观套过的键改写成现值（回声，collection-echoes.ts），计数才不会重复增减。
 * · 关联 / 汇总的值只由服务端算（row.computed）：窗口响应的 refs 记在 handle 上；写关联的换算与乐观行在 relation-write.ts，
 *   关联到的集合有变要重取的判定在 collection-deps.ts，行页面属性区单独取的那一行在 row-watch.ts，这里只接线。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import {
  parseCollection,
  pickView,
  TITLE_PROP_ID,
  validateValue,
  type CollectionRefs,
  type CollectionRow,
  type CollectionSchema,
  type RowsDelta,
  type RowUpdate,
} from '@ramet/shared/collection-model'
import { applyRowsDelta, between, clampLimit, fillFormulas, type QueryCtx, type RowsWindow } from '@ramet/shared/collection-query'
import type { Page, Space } from '../api'
import { COPY } from '../copy'
import { selfId } from '../people'
import { randomUuid } from '../uuid'
import { collectionTransport, type NewRowInput, type RowPatch, type RowSet, type RowWithRefs } from './collection-api'
import { createCorePool, type CacheOptions, type ColdCollection } from './collection-cache'
import { createEchoes, ECHO_TTL } from './collection-echoes'
import { depsChanged, depsSnapshot } from './collection-deps'
import { hasReverse, normalizeRelation, splitWrite, withValues, type SplitWrite } from './relation-write'
import { createRowWatch, type RowState } from './row-watch'
import {
  coldWins,
  computedSig,
  EMPTY_WINDOW,
  fitsScope,
  idleRangeOverflow,
  newWin,
  pageLimit,
  querySig,
  scopeKey,
  viewUsesTitle,
  warmWin,
  type Win,
  type WindowScope,
} from './collection-windows'

export type RowsQuery = { view: string; group?: string; range?: string; cursor?: string | null; limit: number; tz: number }

/** 集合文档的协同连接（真实实现在 collection-api.ts；测试换成内存里的 Y.Doc） */
export type CollectionLink = {
  doc: Y.Doc
  /** 标题编辑器要用（awareness 光标）；测试里为 null */
  provider: HocuspocusProvider | null
  onSynced: (cb: () => void) => void
  onStateless: (cb: (payload: string) => void) => void
  /** 服务端拒绝（非成员 / 不存在） */
  onDenied: (cb: () => void) => void
  destroy: () => void
}

export type CollectionTransport = {
  /** doc = 冷缓存里留下的文档（同步过），交给新连接打底 */
  connect: (cid: string, doc?: Y.Doc) => CollectionLink
  rows: (cid: string, q: RowsQuery) => Promise<RowsWindow>
  createRow: (cid: string, input: NewRowInput) => Promise<CollectionRow>
  patchRow: (cid: string, rowId: string, patch: RowPatch) => Promise<CollectionRow>
  trashRows: (cid: string, ids: string[]) => Promise<{ trashed: string[] }>
  setRows: (cid: string, ids: string[], set: RowSet) => Promise<unknown>
  duplicateRows: (cid: string, ids: string[]) => Promise<unknown>
  moveRows: (cid: string, ids: string[], to: string) => Promise<unknown>
  /** 单行 + refs（行页面属性区）；不给 = 不取（测试） */
  row?: (cid: string, rowId: string) => Promise<RowWithRefs>
  /** 人员排序用的显示名（与服务端按用户名排同一口径） */
  nameOf?: (spaceId: string | null, userId: string) => string | undefined
  /** 比 UTC 快多少分钟；缺省取本机时区 */
  tzOffset?: () => number
}

export type WindowState = {
  window: RowsWindow | null
  /** 首屏 / 重取在途 */
  loading: boolean
  loadingMore: boolean
  /** 取数失败的原因（404 = 集合不存在或没权限） */
  error: string | null
}

export type CollectionStatus = 'connecting' | 'ready' | 'denied'

export type CollectionHandle = {
  readonly id: string
  readonly doc: Y.Doc
  readonly provider: HocuspocusProvider | null
  schema: () => CollectionSchema | null
  status: () => CollectionStatus
  /** 最近一次写入失败的提示（clearError 清掉） */
  error: () => string | null
  clearError: () => void
  /** schema / 状态 / 窗口 / 提示任一变化都通知 */
  subscribe: (cb: () => void) => () => void
  /** 窗口按范围区分（collection-windows.ts）：不给 = 不限范围 */
  windowState: (viewId: string, scope?: WindowScope) => WindowState
  /** 开始看一个窗口（引用计数，返回退订） */
  watchWindow: (viewId: string, scope?: WindowScope) => () => void
  loadMore: (viewId: string, scope?: WindowScope) => void
  /** 套增量用的时区与人员名（日历 / 时间线按它把创建 / 编辑时间折成日子、给几个窗口合起来排序） */
  queryCtx: () => QueryCtx
  /** 已加载窗口里（或属性区单独取的）这一行的最新一份 */
  findRow: (rowId: string) => CollectionRow | undefined
  /** 窗口 / 单行响应里最近一份 refs（关联 / 汇总指向哪里、汇总目标的定义）；还没取到 = null */
  refs: () => CollectionRefs | null
  /** 行页面属性区：单独取一行的计算值（引用计数，返回退订；row-watch.ts） */
  watchRow: (rowId: string) => () => void
  rowState: (rowId: string) => RowState
  setValues: (rowId: string, set: RowSet) => Promise<boolean>
  renameRow: (rowId: string, title: string) => Promise<boolean>
  /** 手动排序（after / before = 落下后的前后邻居，null = 那一侧没有）；带 set = 同时改值（看板跨列） */
  moveRow: (rowId: string, after: string | null, before: string | null, set?: RowSet) => Promise<boolean>
  /** 乐观新建：行立即插进窗口，同步返回 id；ready = 服务端确认（失败 null，行已撤掉并提示）。
   *  at = 落在哪个窗口的末尾（手动排序且窗口没取完时请求带 after = 已加载的最后一行）。值非法 = null，什么都不做 */
  createRow: (input?: NewRowInput, at?: { viewId: string } & WindowScope) => NewRow | null
  trashRows: (ids: string[]) => Promise<boolean>
  /** 批量：改值（乐观）/ 复制（副本紧跟原行）/ 挪到同空间的另一个集合；行多了自动分批 */
  setValuesMany: (ids: string[], set: RowSet) => Promise<boolean>
  duplicateRows: (ids: string[]) => Promise<boolean>
  moveRowsTo: (ids: string[], to: string) => Promise<boolean>
  /** 释放这次 open（每个 open 只能 release 一次，多调无效） */
  release: () => void
}

export type NewRow = { id: string; ready: Promise<CollectionRow | null> }

/** 批量接口每次最多带多少行（与服务端 routes/collections.ts 的上限一致） */
const BULK_SET_MAX = 500
const BULK_MOVE_MAX = 500
const BULK_DUPLICATE_MAX = 100

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : COPY.collection.writeFailed
}

/** 页面列表里这个集合的行：父页是它的活 doc 页（id → 标题） */
function childrenOf(cid: string, pages: readonly Page[] | null): Map<string, string> | null {
  if (!pages) return null
  const out = new Map<string, string>()
  for (const p of pages) if (p.parent_id === cid && p.kind === 'doc') out.set(p.id, p.title)
  return out
}

function parseDelta(payload: string): RowsDelta | null {
  let data: unknown
  try {
    data = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || (data as { t?: unknown }).t !== 'collection.rows') return null
  const d = data as Partial<RowsDelta>
  return { t: 'collection.rows', up: Array.isArray(d.up) ? d.up : [], rm: Array.isArray(d.rm) ? d.rm : [], ...(d.reset ? { reset: true } : {}) }
}

type Core = Omit<CollectionHandle, 'release'> & {
  acquire: () => void
  releaseOne: () => void
  teardown: (keep: boolean) => ColdCollection | null
  syncPages: (pages: readonly Page[]) => void
}

function createCore(
  cid: string,
  transport: CollectionTransport,
  pagesNow: () => readonly Page[] | null,
  onIdle: () => void,
  cold?: ColdCollection,
): Core {
  const link = transport.connect(cid, cold?.doc)
  const root = link.doc.getMap<unknown>('collection')
  const listeners = new Set<() => void>()
  const wins = new Map<string, Win>()
  let idleSeq = 0
  /** 在途的乐观新建：行 id → 是否建成（确认之前对这一行的写先等它） */
  const pending = new Map<string, Promise<boolean>>()
  /** 本地改过、服务端还没确认的标题：行 id → 标题 + 认到何时（null = 改名请求还在途）。
   *  页面列表里这一行若还是旧名（建行 / 别的改动触发的重拉早于改名落库），不拿它覆盖窗口，免得闪回旧标题 */
  const localTitles = new Map<string, { title: string; until: number | null }>()
  /** 乐观改过、服务端还没回声的值（collection-echoes.ts） */
  const echoes = createEchoes()
  let refs = 0
  let dead = false
  let synced = false
  /** 冷缓存打底：文档以前同步过，同步完成之前就能给 schema（status 仍是 connecting） */
  let warm = cold !== undefined
  let status: CollectionStatus = 'connecting'
  let schema: CollectionSchema | null = null
  let lastError: string | null = null
  let children = childrenOf(cid, pagesNow())
  let lastRefs: CollectionRefs | null = null
  /** 关联到的集合的子页与标题（collection-deps.ts）、关联 / 汇总定义的签名：变了要重取 */
  let deps = depsSnapshot(null, null)
  let compSig: string | null = null

  const emit = (): void => listeners.forEach((l) => l())
  const single = createRowWatch(transport.row && ((rowId) => transport.row!(cid, rowId)), emit, (next) => (lastRefs = next))
  const tz = (): number => transport.tzOffset?.() ?? -new Date().getTimezoneOffset()
  // refs 给公式用（逐个显示的汇总按目标属性的选项换名字），与服务端窗口查询的口径一致
  const ctx = (): QueryCtx => {
    const base: QueryCtx = lastRefs ? { tzOffset: tz(), refs: lastRefs } : { tzOffset: tz() }
    const nameOf = transport.nameOf
    if (!nameOf) return base
    const spaceId = pagesNow()?.find((p) => p.id === cid)?.space_id ?? null
    return { ...base, nameOf: (userId) => nameOf(spaceId, userId) }
  }
  const setState = (win: Win, patch: Partial<WindowState>): void => {
    win.state = { ...win.state, ...patch }
    emit()
  }

  function fetchWin(win: Win): void {
    if (dead) return
    const seq = ++win.seq
    win.fetching = true
    win.dirty = false
    win.stale = false
    win.sig = schema ? querySig(schema, win.viewId) : null
    // 重取时按已加载的行数取（不超过上限），滚动看过的那一段不至于一下子缩回首屏
    const limit = clampLimit(Math.max(pageLimit(win.scope), win.state.window?.rows.length ?? 0))
    setState(win, { loading: true })
    transport.rows(cid, { view: win.viewId, ...win.scope, limit, tz: tz() }).then(
      (data) => {
        if (dead || seq !== win.seq) return
        win.fetching = false
        if (data.refs) lastRefs = data.refs
        setState(win, { window: keepPending(win, data), loading: false, loadingMore: false, error: null })
        if (win.dirty) refresh(win)
      },
      (err: unknown) => {
        if (dead || seq !== win.seq) return
        win.fetching = false
        setState(win, { loading: false, loadingMore: false, error: errorText(err) })
      },
    )
  }

  const fits = (row: CollectionRow, viewId: string, scope: WindowScope): boolean => !!schema && fitsScope(row, schema, viewId, scope, ctx())

  /** 重取落下时，还没建好的乐观行服务端那份里没有：原来在这个窗口里的补回去（否则别的写失败 / reset 引起的重取
   *  会把正在命名的行冲掉）。先按增量口径套（计数加一），没取完的窗口不收排在末行之后的，就接在末尾（同 createRow） */
  function keepPending(win: Win, data: RowsWindow): RowsWindow {
    if (pending.size === 0 || !schema) return data
    let out = data
    for (const id of pending.keys()) {
      const row = win.state.window?.rows.find((r) => r.id === id)
      if (!row || out.rows.some((r) => r.id === id)) continue
      const next = applyRowsDelta(out, { t: 'collection.rows', up: [{ row }], rm: [] }, pickView(schema, win.viewId), schema, ctx())
      out = next.rows.some((r) => r.id === id) || !fits(row, win.viewId, win.scope) ? next : { ...next, rows: [...next.rows, row] }
    }
    return out
  }

  /** 要以服务端为准：有人看着就重取，空闲的只记下、再看时才取（流量） */
  function refresh(win: Win): void {
    if (win.refs > 0) fetchWin(win)
    else win.stale = true
  }

  const refetchAll = (): void => {
    wins.forEach(refresh)
    single.refetch()
  }

  /** 一条增量套到一个窗口上：取数在途就记下、取完重取；还没有 schema（套不了）就直接重取 */
  function applyToWin(win: Win, delta: RowsDelta): void {
    if (win.fetching) {
      win.dirty = true
      return
    }
    const current = win.state.window
    if (!current) return
    if (!schema) {
      refresh(win)
      return
    }
    const next = applyRowsDelta(current, delta, pickView(schema, win.viewId), schema, ctx())
    if (next !== current) setState(win, { window: next })
  }

  function applyDelta(delta: RowsDelta): void {
    if (delta.reset) {
      refetchAll()
      return
    }
    single.apply(delta)
    wins.forEach((win) => applyToWin(win, delta))
  }

  function recompute(): void {
    if ((!synced && !warm) || dead) return
    schema = parseCollection(root.toJSON())
    // 属性区单独取的那一行：关联 / 汇总定义变了 computed 就旧了（窗口靠 querySig，含同一份签名）
    if (compSig !== null && compSig !== computedSig(schema)) single.refetch()
    compSig = computedSig(schema)
    deps = depsSnapshot(schema, pagesNow())
    for (const win of wins.values()) {
      const sig = querySig(schema, win.viewId)
      // 首个窗口可能在 schema 到之前就取了：那份是服务端按同一份视图算的，记下签名即可
      if (win.sig === null) win.sig = sig
      else if (win.sig !== sig) {
        // 公式两端都能算：定义一变先用手上的行算出来，不用空着等重取回来（重取到的是服务端同一个算法的结果）
        const w = win.state.window
        if (w) win.state = { ...win.state, window: { ...w, rows: fillFormulas(w.rows, schema, ctx()) } }
        refresh(win)
      }
    }
    emit()
  }
  for (const w of cold?.wins ?? []) wins.set(scopeKey(w.viewId, w.scope), warmWin(w))
  root.observeDeep(recompute)
  recompute()
  link.onSynced(() => {
    const again = synced
    synced = true
    warm = false
    status = 'ready'
    recompute()
    // 断线重连：断开期间的增量不会重放，窗口全部重取。冷缓存打底的窗口都记着 stale，走后一支一样重取；
    // 这条连接建起来之后才首次取的窗口已经是新的，不再取一次
    if (again) refetchAll()
    else wins.forEach((win) => win.stale && refresh(win))
  })
  link.onDenied(() => {
    status = 'denied'
    emit()
  })
  link.onStateless((payload) => {
    const delta = parseDelta(payload)
    if (delta) applyDelta(echoes.absorb(delta))
  })

  /** 先给跟得上增量的那份：空闲时错过 reset 的窗口（stale）、取数在途的窗口可能缺着改动，乐观写与反向关联的增删
   *  都以这里为底，拿旧的那份换算会把别人刚加的当成要删的 */
  function findRow(rowId: string): CollectionRow | undefined {
    let behind: CollectionRow | undefined
    for (const win of wins.values()) {
      const hit = win.state.window?.rows.find((r) => r.id === rowId)
      if (!hit) continue
      if (!win.stale && !win.fetching) return hit
      behind ??= hit
    }
    return single.find(rowId, behind)
  }

  /** 写入失败：提示 + 以服务端为准重取（子页基线也回到最近一次页面列表） */
  function fail(err: unknown): void {
    console.error(err)
    lastError = errorText(err)
    children = childrenOf(cid, pagesNow())
    refetchAll()
    emit()
  }

  const local = (up: RowUpdate[], rm: { row: CollectionRow }[] = []): void => applyDelta({ t: 'collection.rows', up, rm })

  /** 先按当前定义规范化（空文本 → null 等），乐观值与服务端写下的才对得上；人员要成员名单，交给服务端。
   *  有非法值 = null（已记下提示，不发请求） */
  function normalize(set: RowSet): RowSet | null {
    const values: RowSet = {}
    for (const [key, raw] of Object.entries(set)) {
      const prop = schema?.props.find((p) => p.id === key)
      if (!prop || prop.type === 'person') {
        values[key] = raw
        continue
      }
      const checked = prop.type === 'relation' ? normalizeRelation(prop, raw) : validateValue(prop, raw)
      if (!checked.ok) {
        lastError = checked.error
        emit()
        return null
      }
      values[key] = checked.value
    }
    return values
  }

  /** 乐观写：已加载的行套上新值（和新位置；shown = 反向关联的新值，直接改 computed）合成一条增量，prev 只含改到的键；
   *  改了值就登记回声。position 缺省 = 位置不变 */
  function optimistic(rowId: string, values: RowSet | null, position?: number, shown?: Record<string, string[]>): void {
    const up = optimisticUpdate(rowId, values, position, shown)
    if (up) local([up])
  }

  /** optimistic 的一行：算出增量条目并登记回声，不套（批量改值攒成一条增量再套） */
  function optimisticUpdate(rowId: string, values: RowSet | null, position?: number, shown?: Record<string, string[]>): RowUpdate | null {
    const old = findRow(rowId)
    if (!old) return null
    const up = withValues(old, values ?? {}, shown, position)
    if (values && Object.keys(values).length > 0) echoes.record(rowId, values)
    return up
  }

  /** 反向关联按这一行现在的值换算成增删（relation-write.ts）；超出单次上限 = null（已记下提示） */
  function splitOf(rowId: string, values: RowSet): SplitWrite | null {
    const split = splitWrite(schema, values, findRow(rowId))
    if (typeof split !== 'string') return split
    lastError = split
    emit()
    return null
  }

  async function setValues(rowId: string, set: RowSet): Promise<boolean> {
    const values = normalize(set)
    const split = values && splitOf(rowId, values)
    if (!split) return false
    optimistic(rowId, split.stored, undefined, split.shown)
    if (!(await created(rowId))) return false
    try {
      await transport.patchRow(cid, rowId, { set: split.wire })
      return true
    } catch (err) {
      echoes.drop(rowId)
      fail(err)
      return false
    }
  }

  async function renameRow(rowId: string, title: string): Promise<boolean> {
    const next = title.trim()
    const old = findRow(rowId)
    if (old && old.title !== next) local([{ row: { ...old, title: next }, prev: { [TITLE_PROP_ID]: old.title } }])
    // 子页基线先记新名：随后的页面列表带着同一个名字，不再当成别人改名处理一遍
    if (children?.has(rowId)) children.set(rowId, next)
    localTitles.set(rowId, { title: next, until: null })
    const settle = (ok: boolean): void => {
      const mine = localTitles.get(rowId)
      if (mine?.title !== next) return // 后面又改过一次：归那一次管
      // 成功了也再认一阵：改名之前发起的页面列表重拉可能晚到，还带着旧名
      if (ok) mine.until = Date.now() + ECHO_TTL
      else localTitles.delete(rowId)
    }
    if (!(await created(rowId))) {
      settle(false)
      return false
    }
    try {
      await transport.patchRow(cid, rowId, { title: next })
      settle(true)
      return true
    } catch (err) {
      settle(false)
      fail(err)
      return false
    }
  }

  /** 挪到 after 与 before 之间；带 set = 同时改值（看板把卡片拖到别的列）：乐观增量一次同时带新值与新位置，
   *  目标列的窗口一次就把它插在落点上（分两次套会先按旧位置插一次、再挪一次），请求也只发一次 */
  async function moveRow(rowId: string, after: string | null, before: string | null, set?: RowSet): Promise<boolean> {
    const values = set ? normalize(set) : null
    if (set && !values) return false
    // null = 那一侧没有邻居；undefined = 有邻居但不在已加载的窗口里（不知道它的位置）
    const lo = after === null ? null : findRow(after)
    const hi = before === null ? null : findRow(before)
    // 邻居都在已加载的窗口里才乐观挪；夹不进去（没排过 / 精度用尽）等服务端重编号的 reset
    const at =
      lo !== undefined && hi !== undefined && (lo !== null || hi !== null)
        ? between(lo === null ? undefined : lo.position, hi === null ? undefined : hi.position)
        : null
    if (values || at !== null) optimistic(rowId, values, at ?? undefined)
    if (!(await created(rowId))) return false
    try {
      await transport.patchRow(cid, rowId, { ...(values ? { set: values } : {}), after, before })
      return true
    } catch (err) {
      if (values) echoes.drop(rowId)
      fail(err)
      return false
    }
  }

  /** 确认之前对在途新行的写先等它建成；false = 没建成（行已撤掉，这次写丢弃） */
  const created = (rowId: string): Promise<boolean> => pending.get(rowId) ?? Promise.resolve(true)

  /** 一批 id 里建成了的那些（在途的先等） */
  async function settled(ids: string[]): Promise<string[]> {
    if (!ids.some((id) => pending.has(id))) return ids
    const ok = await Promise.all(ids.map(created))
    return ids.filter((_, i) => ok[i])
  }

  /** 新行要落在这个窗口的末尾：只在手动排序（不分组，或窗口就是一组）且窗口没取完时 ——
   *  这时新行排在全局末尾会落进还没加载的那一段，用户看不见；改成紧跟已加载的最后一行 */
  function tailOf(viewId: string, scope: WindowScope): { win: Win; last: CollectionRow } | null {
    const win = wins.get(scopeKey(viewId, scope))
    const last = win?.state.window?.next ? win.state.window.rows.at(-1) : undefined
    if (!schema || !win || !last) return null
    const view = pickView(schema, viewId)
    if (view.sorts.length > 0 || (view.groupBy && scope.group === undefined)) return null
    return { win, last }
  }

  /** 已加载的最大位置 + 1（服务端建行默认排在末尾，同一口径） */
  function nextPosition(): number {
    let max = -1
    for (const win of wins.values()) for (const r of win.state.window?.rows ?? []) if (typeof r.position === 'number' && r.position > max) max = r.position
    return max + 1
  }

  /** 服务端确认：只取服务端定的字段（位置、时间、图标、创建者 / 最后编辑者、自动编号）；标题与值留本地的 —— 确认之前可能已经改过，
   *  那些写排在确认之后发。原地替换，不挪位置（确认前后在已加载的行里先后不变） */
  function confirmRow(real: CollectionRow): void {
    for (const win of wins.values()) {
      const w = win.state.window
      const i = w ? w.rows.findIndex((r) => r.id === real.id) : -1
      if (!w || i < 0) continue
      const rows = w.rows.slice()
      const { icon, position, created_at, edited_at, created_by, edited_by, edited_agent, number } = real
      rows[i] = { ...rows[i]!, icon, position, created_at, edited_at, created_by, edited_by, edited_agent, number }
      setState(win, { window: { ...w, rows } })
    }
  }

  function createRow(input: NewRowInput = {}, at?: { viewId: string } & WindowScope): NewRow | null {
    const values = input.set ? normalize(input.set) : null
    if (input.set && !values) return null
    const id = randomUuid()
    const tail = at && input.after === undefined && input.before === undefined ? tailOf(at.viewId, at) : null
    const props: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values ?? {})) if (value !== null) props[key] = value
    const now = new Date().toISOString()
    const title = input.title?.trim() ?? ''
    const position = tail ? between(tail.last.position, undefined) : nextPosition()
    // 创建者先记成自己（服务端就是按发请求的人记的）：按创建者筛选的视图里新行不会等确认才出现；编号要等确认
    const me = selfId() || null
    const row: CollectionRow = { id, title, icon: null, props, position, created_at: now, edited_at: now, has_body: false, created_by: me, edited_by: me }
    // 先记进子页基线：随后的页面列表带着它，不当成别人建的行再重取一次
    children?.set(id, title)
    // 正在取数的窗口套不上这条增量（只记 dirty、取完重取，那时服务端可能还没建好）：建成后再重取它们
    const missed = [...wins.values()].filter((w) => w.fetching)
    local([{ row }])
    if (tail) {
      // 没取完的窗口不收排在末行之后的行（applyRowsDelta 只计数）：这里是用户看得见的末尾，直接接上；
      // 游标不动（服务端按旧末行续取会再给一次这一行，续取按 id 去重）
      const w = tail.win.state.window
      if (w && fits(row, tail.win.viewId, tail.win.scope) && !w.rows.some((r) => r.id === id)) setState(tail.win, { window: { ...w, rows: [...w.rows, row] } })
    }
    const body: NewRowInput = { ...input, id, ...(values ? { set: values } : {}) }
    // 末行自己还在途（连点两次）：等它建成再带 after，否则服务端认不出这个邻居（400）
    const after = tail?.last.id
    const send = (ok: boolean): Promise<CollectionRow> => transport.createRow(cid, ok && after !== undefined ? { ...body, after } : body)
    const request = after !== undefined && pending.has(after) ? created(after).then(send) : send(after !== undefined)
    const ready = request.then(
      (real) => {
        pending.delete(id)
        if (dead) return real
        confirmRow(real)
        missed.forEach(refresh)
        return real
      },
      (err: unknown) => {
        pending.delete(id)
        if (dead) return null
        children?.delete(id)
        const cur = findRow(id)
        if (cur) local([], [{ row: cur }])
        fail(err)
        return null
      },
    )
    pending.set(id, ready.then((real) => real !== null))
    return { id, ready }
  }

  async function trashRows(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true
    const rows = ids.map(findRow).filter((r): r is CollectionRow => r !== undefined)
    for (const id of ids) children?.delete(id)
    if (rows.length > 0) local([], rows.map((row) => ({ row })))
    const live = await settled(ids)
    if (live.length === 0) return true
    try {
      await transport.trashRows(cid, live)
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  /** 批量改值：已加载的行一条增量乐观套上，请求按服务端上限分批串行发 */
  async function setValuesMany(ids: string[], set: RowSet): Promise<boolean> {
    const values = normalize(set)
    if (!values || ids.length === 0) return false
    // 反向关联每行的增删不一样（按各自现在的值换算），逐行发
    if (hasReverse(schema, values)) return (await Promise.all(ids.map((id) => setValues(id, set)))).every(Boolean)
    const ups = ids.map((id) => optimisticUpdate(id, values)).filter((u): u is RowUpdate => u !== null)
    if (ups.length > 0) local(ups)
    const live = await settled(ids)
    try {
      for (const part of chunks(live, BULK_SET_MAX)) await transport.setRows(cid, part, values)
      return true
    } catch (err) {
      for (const id of ids) echoes.drop(id)
      fail(err)
      return false
    }
  }

  /** 复制行：不做乐观（新行是页面，随后的页面列表让窗口重取） */
  async function duplicateRows(ids: string[]): Promise<boolean> {
    const live = await settled(ids)
    try {
      for (const part of chunks(live, BULK_DUPLICATE_MAX)) await transport.duplicateRows(cid, part)
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  /** 挪到别的集合：同删行，先从窗口里摘掉 */
  async function moveRowsTo(ids: string[], to: string): Promise<boolean> {
    if (ids.length === 0) return true
    const rows = ids.map(findRow).filter((r): r is CollectionRow => r !== undefined)
    for (const id of ids) children?.delete(id)
    if (rows.length > 0) local([], rows.map((row) => ({ row })))
    const live = await settled(ids)
    if (live.length === 0) return true
    try {
      for (const part of chunks(live, BULK_MOVE_MAX)) await transport.moveRows(cid, part, to)
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  function syncPages(pages: readonly Page[]): void {
    if (dead) return
    const before = deps
    deps = depsSnapshot(schema, pages)
    // 关联到的集合有行进出 / 改名，或对方集合本身不在了 / 换了空间：计算值服务端不推，重取
    const depsMoved = depsChanged(before, deps)
    const next = childrenOf(cid, pages)
    const prev = children
    children = next
    if (!prev || !next) {
      if (depsMoved) refetchAll()
      return
    }
    // 在途的新行服务端还没建好，这份列表里没有它：不算「行有进出」（否则重取会把正在命名的行冲掉）
    for (const id of pending.keys()) if (prev.has(id) && !next.has(id)) next.set(id, prev.get(id) ?? '')
    // 本地改过名、服务端还没确认的行：列表里的旧名不算改名（基线留本地的）；列表跟上了或过了认领期就放手
    const now = Date.now()
    for (const [id, mine] of localTitles) {
      const listed = next.get(id)
      if (listed === mine.title) localTitles.delete(id)
      else if (mine.until !== null && now > mine.until) localTitles.delete(id)
      else if (listed !== undefined && prev.has(id)) next.set(id, prev.get(id) ?? mine.title)
    }
    let moved = prev.size !== next.size
    const renamed = new Map<string, string>()
    for (const [id, title] of next) {
      if (!prev.has(id)) moved = true
      else if (prev.get(id) !== title) renamed.set(id, title)
    }
    if (moved || depsMoved) {
      refetchAll()
      return
    }
    if (renamed.size === 0) return
    for (const win of wins.values()) {
      const rows = win.state.window?.rows ?? []
      const up: RowUpdate[] = []
      for (const row of rows) {
        const title = renamed.get(row.id)
        if (title !== undefined && title !== row.title) up.push({ row: { ...row, title }, prev: { [TITLE_PROP_ID]: row.title } })
      }
      const outside = [...renamed.keys()].some((id) => !rows.some((r) => r.id === id))
      // 窗口外的行改了名：只有按名称筛选 / 排序的视图受影响，而窗口外的行没有整行数据可套增量 —— 重取
      if (outside && schema && viewUsesTitle(schema, win.viewId)) refresh(win)
      else if (up.length > 0) applyToWin(win, { t: 'collection.rows', up, rm: [] })
    }
  }

  return {
    id: cid,
    doc: link.doc,
    provider: link.provider,
    schema: () => schema,
    status: () => status,
    error: () => lastError,
    clearError: () => {
      if (lastError === null) return
      lastError = null
      emit()
    },
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    windowState: (viewId, scope) => wins.get(scopeKey(viewId, scope))?.state ?? EMPTY_WINDOW,
    watchWindow: (viewId, scope = {}) => {
      const key = scopeKey(viewId, scope)
      let win = wins.get(key)
      if (!win) {
        win = newWin(viewId, scope)
        wins.set(key, win)
        fetchWin(win)
      } else if ((win.stale || win.state.error !== null) && !warm && !win.fetching) {
        // 旧内容先留着显示（fetchWin 不清 window）；上次取失败的也再试一次（窗口不再随退订删掉，否则一直停在出错）。
        // 冷缓存打底、还没同步的等 onSynced 统一取
        fetchWin(win)
      }
      const w = win
      w.refs++
      let done = false
      // 没人看了也留着（随 core 一起活着，增量照常套上）：回来时立即有内容；在途的取数照常落下。
      // 日期范围窗口例外：翻月 / 横向滚动会不断产生新的，只留最近没人看的几个（idleRangeOverflow）
      return () => {
        if (done) return
        done = true
        if (--w.refs > 0) return
        w.idleSince = ++idleSeq
        for (const stale of idleRangeOverflow(wins)) wins.delete(stale)
      }
    },
    loadMore: (viewId, scope) => {
      const win = wins.get(scopeKey(viewId, scope))
      const current = win?.state.window
      if (!win || !current?.next || win.fetching || win.state.loadingMore) return
      const seq = win.seq
      setState(win, { loadingMore: true })
      transport.rows(cid, { view: viewId, ...win.scope, cursor: current.next, limit: pageLimit(win.scope), tz: tz() }).then(
        (page) => {
          if (dead || seq !== win.seq) return
          const latest = win.state.window ?? current
          const have = new Set(latest.rows.map((r) => r.id))
          setState(win, { window: { ...page, rows: latest.rows.concat(page.rows.filter((r) => !have.has(r.id))) }, loadingMore: false })
        },
        (err: unknown) => {
          if (dead || seq !== win.seq) return
          setState(win, { loadingMore: false, error: errorText(err) })
        },
      )
    },
    queryCtx: ctx,
    findRow,
    refs: () => lastRefs,
    watchRow: single.watch,
    rowState: single.state,
    setValues,
    renameRow,
    moveRow,
    createRow,
    trashRows,
    setValuesMany,
    duplicateRows,
    moveRowsTo,
    syncPages,
    acquire: () => {
      refs++
    },
    releaseOne: () => {
      refs--
      if (refs === 0) onIdle()
    },
    teardown: (keep) => {
      dead = true
      root.unobserveDeep(recompute)
      listeners.clear()
      link.destroy()
      const left: ColdCollection | null = keep && status !== 'denied' && (synced || warm) ? { doc: link.doc, wins: coldWins(wins.values()) } : null
      wins.clear()
      return left
    },
  }
}

export type CollectionStore = {
  open: (cid: string) => CollectionHandle
  /** 登出 / 换账号：清空保活与冷缓存（之前打开的连接释放时也不再留） */
  reset: () => void
  /** App 每次拿到新的页面列表都调一次（行的进出与改名从这里感知） */
  syncPages: (pages: readonly Page[]) => void
  /** 最近一次的页面列表（正文里的集合块据此判定「拥有 / 不在本页」）；null = 还没到 */
  pages: () => readonly Page[] | null
  subscribePages: (cb: () => void) => () => void
}

export function createCollectionStore(transport: CollectionTransport, cache?: CacheOptions): CollectionStore {
  let lastPages: readonly Page[] | null = null
  const pageListeners = new Set<() => void>()
  const pool = createCorePool<Core>((cid, cold, onIdle) => createCore(cid, transport, () => lastPages, onIdle, cold), cache)
  return {
    reset: pool.reset,
    open: (cid) => {
      const c = pool.open(cid)
      let released = false
      return {
        ...c,
        release: () => {
          if (released) return
          released = true
          c.releaseOne()
        },
      }
    },
    syncPages: (pages) => {
      lastPages = pages
      pool.forEach((core) => core.syncPages(pages))
      pageListeners.forEach((l) => l())
    },
    pages: () => lastPages,
    subscribePages: (cb) => {
      pageListeners.add(cb)
      return () => pageListeners.delete(cb)
    },
  }
}

const store = createCollectionStore(collectionTransport)
export const openCollection = store.open
export const syncCollectionPages = store.syncPages
export const resetCollectionCache = store.reset
/** 最近一次的页面列表（非 React 处取关联行的标题：历史流水、复制） */
export const collectionPages = store.pages

/* 空间列表（App 已有的 spaces，带我在每个空间的角色）：正文里的集合块按集合所在空间算只读，不另发请求 */
let spacesNow: readonly Space[] | null = null
const spaceListeners = new Set<() => void>()
export function syncCollectionSpaces(spaces: readonly Space[] | null): void {
  if (spaces === spacesNow) return
  spacesNow = spaces
  spaceListeners.forEach((l) => l())
}
const subscribeSpaces = (cb: () => void): (() => void) => {
  spaceListeners.add(cb)
  return () => spaceListeners.delete(cb)
}
export function useCollectionSpaces(): readonly Space[] | null {
  return useSyncExternalStore(subscribeSpaces, () => spacesNow)
}

/** 页面列表（App 经 syncCollectionPages 喂进来的同一份）：集合块不另订 control:global、不另取列表 */
export function useCollectionPages(): readonly Page[] | null {
  return useSyncExternalStore(store.subscribePages, store.pages)
}

// ---------- React 侧 ----------

const noSubscribe = (): (() => void) => () => undefined

/** 打开一个集合（组件挂载期间持有，卸载释放）；cid 为 null = 不打开 */
export function useCollection(cid: string | null): CollectionHandle | null {
  const [handle, setHandle] = useState<CollectionHandle | null>(null)
  useEffect(() => {
    if (!cid) return
    const h = openCollection(cid)
    setHandle(h)
    return () => {
      setHandle(null)
      h.release()
    }
  }, [cid])
  return handle?.id === cid ? handle : null
}

export function useCollectionSchema(handle: CollectionHandle | null): CollectionSchema | null {
  return useSyncExternalStore(handle?.subscribe ?? noSubscribe, () => handle?.schema() ?? null)
}

export function useCollectionStatus(handle: CollectionHandle | null): CollectionStatus {
  return useSyncExternalStore(handle?.subscribe ?? noSubscribe, () => handle?.status() ?? 'connecting')
}

export function useCollectionError(handle: CollectionHandle | null): string | null {
  return useSyncExternalStore(handle?.subscribe ?? noSubscribe, () => handle?.error() ?? null)
}

/** 一个视图在一个范围里（看板的一列带 group，日历 / 时间线带 range）的行窗口：挂载期间持有，loadMore 续取 */
export function useRowsWindow(
  handle: CollectionHandle | null,
  viewId: string | null,
  scope: WindowScope = {},
): WindowState & { loadMore: () => void } {
  const { group, range } = scope
  useEffect(() => {
    if (!handle || viewId === null) return
    return handle.watchWindow(viewId, { group, range })
  }, [handle, viewId, group, range])
  const state = useSyncExternalStore(handle?.subscribe ?? noSubscribe, () =>
    handle && viewId !== null ? handle.windowState(viewId, { group, range }) : EMPTY_WINDOW,
  )
  // 稳定引用：表格的「滚到底续取」观察者以它为依赖，每次渲染换一个会反复重挂
  const loadMore = useCallback(() => {
    if (handle && viewId !== null) handle.loadMore(viewId, { group, range })
  }, [handle, viewId, group, range])
  return { ...state, loadMore }
}
