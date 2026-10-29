// ---------- 行属性的投影器（唯一投影 collection_rows 的地方） ----------
// 行属性值的真相是行文档 page:<rowId> 的 Y.Map('props')；collection_rows.props 是它的可查询副本（窗口查询、筛选排序读它）。
// 改值的来源很多：表格单元格（REST 经 DocWriter）、行页面属性区（浏览器协同连接）、恢复版本、agent 的写入，
// 最后都是这张 map 变了。所以投影挂在文档上而不是挂在各条写路径上：
//   · afterLoadDocument：每个 page: 文档加载完挂一个 observeDeep（普通页面这张 map 一直是空的，不触发），并校准一次副本
//     （崩溃窗口：增量已落库、副本还没写进程就挂了，下次加载时按文档补上）
//   · 观察者：按行攒约 100ms 写一次副本；行在集合里，就把 { row, prev } 交给增量批次（只发给正看着这个集合的连接）
//   · beforeUnloadDocument：卸载前把没刷的写完；关停时 drain 等全部在途写入
//   · afterStoreDocument：正文索引（content_text）已落库；集合的行「正文有没有字」变了就发一条整行增量（has_body，
//     表格据此决定画不画通用文档图标）。正文不是属性，不写副本
// 同一行的校准 / 去抖到点 / flushRow 排在同一条链上依次执行：上一次写进副本的值是下一次 prev 的基准。
// REST 写值要「响应前副本已落库」：flushRow 跳过去抖当场写，并等它写完。

import type { Extension } from '@hocuspocus/server'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import type { RowUpdate } from '@ramet/shared/collection-model'
import { PAGE_DOC_NAME } from '../collab.js'
import { RowsDeltas, type DeltaSink } from './delta.js'
import { memberRow, propsDiff, readHasBody, readReplica, replicaProps, sameProps, writeEmptyReplica, writeReplica } from './store.js'

/** 一行属性变了之后多久写副本（这段里的连续改动并成一次） */
export const PROJECT_DELAY_MS = 100

type Tracker = {
  rowId: string
  doc: Y.Doc
  props: Y.Map<unknown>
  observer: () => void
  timer: NodeJS.Timeout | null
  /** 这一行的写副本按序排队（每一步都自己接住错误，链不会断） */
  chain: Promise<void>
  /** 副本里现在是什么（上次写进去的 / 校准时读出来的，已清洗）；null = 还没校准 */
  last: Record<string, unknown> | null
  /** 校准时是不是活集合的行（不是就不查正文有没有字） */
  member: boolean
  /** 上次知道的「正文有没有字」；null = 还没校准 */
  body: boolean | null
}

export type Projector = {
  /** 挂进 createHocuspocus 的扩展 */
  extension: Extension
  /** 立刻把这一行还没写的属性写进副本并等写完（REST 改值在响应前调；文档已卸载 = 卸载前已经写过了） */
  flushRow(rowId: string): Promise<void>
  /** 不是属性变化的增量（PATCH after / before 改的手动顺序）也走同一个批次 */
  publish(collectionId: string, update: RowUpdate): void
  /** 手动顺序重编号了整个集合：这一批只发 reset，观看者重取窗口 */
  reset(collectionId: string): void
  /** 关停：在 hocuspocus.destroy 之后调，等全部在途的副本写入落库 */
  drain(): Promise<void>
}

const errText = (rowId: string): string => `[collections] 行属性副本写入失败(page:${rowId}):`

export function createProjector(pool: Pool, sink: DeltaSink): Projector {
  const trackers = new Map<string, Tracker>()
  const inflight = new Set<Promise<void>>()
  const deltas = new RowsDeltas(sink)

  function enqueue(t: Tracker, step: (t: Tracker) => Promise<void>): Promise<void> {
    const run = t.chain.then(() => step(t))
    t.chain = run
    inflight.add(run)
    const done = (): void => {
      inflight.delete(run)
    }
    run.then(done, done)
    return run
  }

  function cancel(t: Tracker): void {
    if (!t.timer) return
    clearTimeout(t.timer)
    t.timer = null
  }

  function schedule(t: Tracker): void {
    if (t.timer) return
    t.timer = setTimeout(() => {
      t.timer = null
      void enqueue(t, project)
    }, PROJECT_DELAY_MS)
    // 不拖住进程退出：卸载 / 关停时会显式写完
    t.timer.unref()
  }

  /** 行在活集合里：把改后的行和 prev 交给增量批次 */
  async function announce(rowId: string, prev: Record<string, unknown>): Promise<void> {
    if (Object.keys(prev).length === 0) return
    const found = await memberRow(pool, rowId)
    if (found) deltas.push(found.collectionId, { row: found.row, prev })
  }

  /** 加载时校准：副本与文档不一致就按文档重写；集合的行还没有副本就补一行空的 */
  async function calibrate(t: Tracker): Promise<void> {
    try {
      const stored = await readReplica(pool, t.rowId)
      // 页面行已不在（物理删除的竞态）：没有可写的
      if (!stored) return
      t.member = stored.member
      t.body = stored.body
      const next = replicaProps(t.props.toJSON())
      if (stored.props !== null && sameProps(next, stored.props)) {
        t.last = next
        return
      }
      if (stored.props === null && Object.keys(next).length === 0) {
        if (stored.member) await writeEmptyReplica(pool, t.rowId)
        t.last = next
        return
      }
      if (!(await writeReplica(pool, t.rowId, next, true))) return
      t.last = next
      await announce(t.rowId, propsDiff(replicaProps(stored.props ?? {}), next))
    } catch (err) {
      // last 仍是 null：下一次写副本前会再校准
      console.error(errText(t.rowId), err)
    }
  }

  /** 把文档里的 props 写进副本（与上次写进去的不同才写） */
  async function project(t: Tracker): Promise<void> {
    cancel(t)
    if (t.last === null) return calibrate(t)
    try {
      const next = replicaProps(t.props.toJSON())
      if (sameProps(next, t.last)) return
      if (!(await writeReplica(pool, t.rowId, next, true))) return
      const prev = propsDiff(t.last, next)
      t.last = next
      await announce(t.rowId, prev)
    } catch (err) {
      console.error(errText(t.rowId), err)
    }
  }

  /** 存完文档：行的正文从无字变有字（或反过来）就发整行（prev 为空，同手动顺序的增量） */
  async function recheckBody(t: Tracker): Promise<void> {
    if (!t.member || t.body === null) return
    try {
      const body = await readHasBody(pool, t.rowId)
      if (body === null || body === t.body) return
      t.body = body
      const found = await memberRow(pool, t.rowId)
      if (found) deltas.push(found.collectionId, { row: found.row, prev: {} })
    } catch (err) {
      console.error(errText(t.rowId), err)
    }
  }

  /** 不再跟踪这份文档：摘观察者，还没写的写掉 */
  function retire(t: Tracker): void {
    t.props.unobserveDeep(t.observer)
    if (t.timer) {
      cancel(t)
      void enqueue(t, project)
    }
  }

  const extension: Extension = {
    extensionName: 'collection-projector',
    // 加载完才挂（onLoadDocument 还在往文档里灌快照与增量）：之后的改动都是真改动
    async afterLoadDocument({ documentName, document }) {
      const rowId = PAGE_DOC_NAME.exec(documentName)?.[1]
      if (!rowId) return
      try {
        const old = trackers.get(rowId)
        if (old && old.doc !== document) retire(old)
        const t: Tracker = {
          rowId,
          doc: document,
          props: document.getMap<unknown>('props'),
          observer: () => schedule(t),
          timer: null,
          chain: Promise.resolve(),
          last: null,
          member: false,
          body: null,
        }
        t.props.observeDeep(t.observer)
        trackers.set(rowId, t)
        await enqueue(t, calibrate)
      } catch (err) {
        // 投影出错不能拖垮文档加载（这里抛出去，Hocuspocus 会断开连接）
        console.error(errText(rowId), err)
      }
    },
    async afterStoreDocument({ documentName, document }) {
      const rowId = PAGE_DOC_NAME.exec(documentName)?.[1]
      const t = rowId ? trackers.get(rowId) : undefined
      if (!t || t.doc !== document) return
      await enqueue(t, recheckBody)
    },
    async beforeUnloadDocument({ documentName, instance }) {
      const rowId = PAGE_DOC_NAME.exec(documentName)?.[1]
      const t = rowId ? trackers.get(rowId) : undefined
      if (!t || instance.documents.get(documentName) !== t.doc) return
      cancel(t)
      await enqueue(t, project)
    },
    async afterUnloadDocument({ documentName, instance }) {
      const rowId = PAGE_DOC_NAME.exec(documentName)?.[1]
      const t = rowId ? trackers.get(rowId) : undefined
      // 卸载期间又有连接进来、同名文档已重新加载：留给新的那份
      if (!rowId || !t || instance.documents.get(documentName) === t.doc) return
      retire(t)
      trackers.delete(rowId)
    },
  }

  return {
    extension,
    async flushRow(rowId) {
      const t = trackers.get(rowId)
      if (!t) return
      cancel(t)
      await enqueue(t, project)
    },
    publish(collectionId, update) {
      deltas.push(collectionId, update)
    },
    reset(collectionId) {
      deltas.reset(collectionId)
    },
    async drain() {
      for (const t of trackers.values()) retire(t)
      trackers.clear()
      while (inflight.size > 0) await Promise.allSettled([...inflight])
      deltas.dispose()
    },
  }
}
