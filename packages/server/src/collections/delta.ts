// ---------- 集合增量的批次 ----------
// 服务端只推两类增量：投影器发出的行属性变化（projector.ts），以及 PATCH after / before 改的手动顺序（prev 为空）。
// 手动顺序重编号（改了这个集合所有行的 position）时这一批只发 reset：观看者丢掉窗口重取。
// 行的进出、改名不在这里：它们本来就广播 changed，客户端从重拉到的页面列表感知。
//
// 每个集合约 100ms 合并成一条 RowsDelta，经集合文档 page:<cid> 的 broadcastStateless 只发给正连着这个集合文档的连接
// （它们已过 pageAccess），不走 control:global：改一格不该让全站重拉页面列表。
// 集合文档没加载（没人看）就丢掉这一批：没有观看者，下次打开会重新查询。

import type { RowsDelta, RowUpdate } from '@ramet/shared/collection-model'

/** 合并窗口 */
export const DELTA_WINDOW_MS = 100

/** 找集合文档（注入 hocuspocus.documents.get；没加载 = undefined） */
export type DeltaSink = (docName: string) => { broadcastStateless(payload: string): void } | undefined

/** 同一批里一行只出现一次：row 取最新的，prev 取最早的（前一次没改、后一次才改的键，本批之前的值记在后一次的 prev 里）。
 *  最早那次没有 prev（这一行本批才进集合）就仍然没有 */
export function mergeUpdate(earlier: RowUpdate, later: RowUpdate): RowUpdate {
  if (!earlier.prev) return { row: later.row }
  return { row: later.row, prev: { ...later.prev, ...earlier.prev } }
}

export class RowsDeltas {
  /** 集合 id → 这一批：行 id → 这一行的改动；reset = 这一批作废逐行改动、只告诉观看者重取 */
  private readonly batches = new Map<string, { reset: boolean; up: Map<string, RowUpdate> }>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly sink: DeltaSink,
    private readonly windowMs = DELTA_WINDOW_MS,
  ) {}

  push(collectionId: string, update: RowUpdate): void {
    const batch = this.batch(collectionId)
    // 已经要重取了：逐行改动没有意义（重取到的就是最新的）
    if (batch.reset) return
    const earlier = batch.up.get(update.row.id)
    batch.up.set(update.row.id, earlier ? mergeUpdate(earlier, update) : update)
  }

  /** 顺序基准变了（手动顺序重编号）：这一批只发 reset，同批已攒的与之后到的逐行改动一并丢掉 */
  reset(collectionId: string): void {
    const batch = this.batch(collectionId)
    batch.reset = true
    batch.up.clear()
  }

  private batch(collectionId: string): { reset: boolean; up: Map<string, RowUpdate> } {
    let batch = this.batches.get(collectionId)
    if (!batch) {
      batch = { reset: false, up: new Map() }
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
    if (!batch || (!batch.reset && batch.up.size === 0)) return
    const delta: RowsDelta = batch.reset
      ? { t: 'collection.rows', up: [], rm: [], reset: true }
      : { t: 'collection.rows', up: [...batch.up.values()], rm: [] }
    try {
      this.sink(`page:${collectionId}`)?.broadcastStateless(JSON.stringify(delta))
    } catch (err) {
      // 定时器回调里抛出去就是未捕获异常：广播失败只记日志（观看者下次查询会校正）
      console.error(`[collections] 集合增量广播失败(page:${collectionId}):`, err)
    }
  }

  /** 关停：丢掉还没发的批次（集合文档都已卸载，发不出去了） */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.batches.clear()
  }
}
