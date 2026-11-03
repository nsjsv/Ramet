// ---------- 集合增量的批次 ----------
// 服务端只推这几类增量：投影器发出的行属性变化（projector.ts），PATCH after / before 改的手动顺序（prev 为空），
// 以及计算值（关联解析、反向关联、汇总）跟着别的行变了的行（prev 为空，见 fanout.ts）。
// 手动顺序重编号（改了这个集合所有行的 position）、或这个集合依赖的集合改了定义时，这一批只发 reset：观看者丢掉窗口重取。
// 行的进出、改名不在这里：它们本来就广播 changed，客户端从重拉到的页面列表感知。
//
// 每个集合约 100ms 合并成一条 RowsDelta，经集合文档 page:<cid> 的 broadcastStateless 只发给正连着这个集合文档的连接
// （它们已过 pageAccess），不走 control:global：改一格不该让全站重拉页面列表。
// 发出前过一步异步的 enrich（给行补上计算值、把影响扇出到依赖这个集合的集合）。每个集合一条 Promise 链：
// enrich 再慢，同一个集合的批次也按攒成的先后发出。集合文档没加载（没人看）就不发：没有观看者，下次打开会重新查询。

import type { RowsDelta, RowUpdate } from '@ramet/shared/collection-model'

/** 合并窗口 */
export const DELTA_WINDOW_MS = 100

/** 找集合文档（注入 hocuspocus.documents.get；没加载 = undefined） */
export type DeltaSink = (docName: string) => { broadcastStateless(payload: string): void } | undefined

/** 发出前的一步：up 是这一批的行改动（同批一行一条），touched 是只有计算值要重算的行 id（别的集合的改动扇出来的）。
 *  返回最终要发的行改动（补好计算值、并上 touched 里还在集合里的行） */
export type BatchEnrich = (collectionId: string, up: RowUpdate[], touched: string[]) => Promise<RowUpdate[]>

/** 同一批里一行只出现一次：row 取最新的，prev 取最早的（前一次没改、后一次才改的键，本批之前的值记在后一次的 prev 里）。
 *  最早那次没有 prev（这一行本批才进集合）就仍然没有 */
export function mergeUpdate(earlier: RowUpdate, later: RowUpdate): RowUpdate {
  if (!earlier.prev) return { row: later.row }
  return { row: later.row, prev: { ...later.prev, ...earlier.prev } }
}

type Batch = { reset: boolean; up: Map<string, RowUpdate>; touched: Set<string> }

export class RowsDeltas {
  /** 集合 id → 这一批：行 id → 这一行的改动；touched = 只需重算计算值的行；reset = 这一批作废逐行改动、只告诉观看者重取 */
  private readonly batches = new Map<string, Batch>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 每个集合正在 enrich / 发出的那一批（下一批排在它后面） */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly sink: DeltaSink,
    private readonly windowMs = DELTA_WINDOW_MS,
    private readonly enrich?: BatchEnrich,
  ) {}

  push(collectionId: string, update: RowUpdate): void {
    const batch = this.batch(collectionId)
    // 已经要重取了：逐行改动没有意义（重取到的就是最新的）
    if (batch.reset) return
    const earlier = batch.up.get(update.row.id)
    batch.up.set(update.row.id, earlier ? mergeUpdate(earlier, update) : update)
  }

  /** 这些行的计算值要重算（别的集合的改动扇出来的）：发出前由 enrich 读当时的行重算，不在这里带行 ——
   *  带着扇出那一刻读到的行，可能比本集合前一批里同一行的改动还旧，后发的旧行会把新值盖回去 */
  touch(collectionId: string, rowIds: Iterable<string>): void {
    const batch = this.batch(collectionId)
    if (batch.reset) return
    for (const id of rowIds) batch.touched.add(id)
  }

  /** 顺序基准变了（手动顺序重编号 / 依赖的集合改了定义）：这一批只发 reset，同批已攒的与之后到的逐行改动一并丢掉 */
  reset(collectionId: string): void {
    const batch = this.batch(collectionId)
    batch.reset = true
    batch.up.clear()
    batch.touched.clear()
  }

  private batch(collectionId: string): Batch {
    let batch = this.batches.get(collectionId)
    if (!batch) {
      batch = { reset: false, up: new Map(), touched: new Set() }
      this.batches.set(collectionId, batch)
    }
    if (!this.timers.has(collectionId)) {
      const timer = setTimeout(() => this.send(collectionId), this.windowMs)
      // 不拖住进程退出：关停时 dispose 清掉
      timer.unref()
      this.timers.set(collectionId, timer)
    }
    return batch
  }

  private send(collectionId: string): void {
    this.timers.delete(collectionId)
    const batch = this.batches.get(collectionId)
    this.batches.delete(collectionId)
    if (!batch || (!batch.reset && batch.up.size === 0 && batch.touched.size === 0)) return
    const run = (this.chains.get(collectionId) ?? Promise.resolve()).then(() => this.deliver(collectionId, batch))
    this.chains.set(collectionId, run)
    void run.then(() => {
      if (this.chains.get(collectionId) === run) this.chains.delete(collectionId)
    })
  }

  private async deliver(collectionId: string, batch: Batch): Promise<void> {
    let delta: RowsDelta
    if (batch.reset) delta = { t: 'collection.rows', up: [], rm: [], reset: true }
    else {
      let up = [...batch.up.values()]
      try {
        if (this.enrich) up = await this.enrich(collectionId, up, [...batch.touched])
        delta = { t: 'collection.rows', up, rm: [] }
      } catch (err) {
        // 补不上计算值的行发出去会让观看者看到空的关联 / 汇总：改让他们重取
        console.error(`[collections] 集合增量的计算值失败(page:${collectionId}):`, err)
        delta = { t: 'collection.rows', up: [], rm: [], reset: true }
      }
      if (!delta.reset && delta.up.length === 0) return
    }
    try {
      this.sink(`page:${collectionId}`)?.broadcastStateless(JSON.stringify(delta))
    } catch (err) {
      // 广播失败只记日志（观看者下次查询会校正）
      console.error(`[collections] 集合增量广播失败(page:${collectionId}):`, err)
    }
  }

  /** 等正在 enrich / 发出的批次走完（关停时在连接池关闭前调） */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()])
  }

  /** 关停：丢掉还没发的批次（集合文档都已卸载，发不出去了） */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.batches.clear()
  }
}
