// ---------- 适配器空闲回收策略 ----------
// 回收的是没有任何在飞工作的适配器进程。"空闲" = 距上一次客户端→agent 请求或上一次在飞工作结束的时间。
// 中心(AgentManager)与 connector 共用这一份判据，两边各自维护计时器，判据必然漂移。
//
// 到期时 busy 只续期、不回收：长任务（omp 单轮 16 分钟、162 步）全程只发事件、不发请求，
// 只按"最后一次请求"计时会中途判空闲，SIGTERM 掉在飞轮次，用户看到「已停止」。

export const IDLE_AGENT_MS = 10 * 60_000

/** 空闲到期后仍 busy 的续期量：适配器真的卡死（prompt 永不回）时不留僵尸进程。 */
export const BUSY_GRACE_MS = 2 * 60_000

export type IdleRecyclerOptions = { idleMs?: number; busyGraceMs?: number }

/** 每个 key 一个计时器。arm 从"现在"重新计时（请求到达 / 工作结束 / 首次 spawn）；
 *  到期时 isBusy 为真就顺延 busyGraceMs 再看，不忙才 reclaim（持有方负责 kill 子进程 / 摘掉实例）。 */
export class IdleRecycler {
  private timers = new Map<string, NodeJS.Timeout>()
  private idleMs: number
  private busyGraceMs: number

  constructor(
    private isBusy: (key: string) => boolean,
    private reclaim: (key: string) => void,
    { idleMs = IDLE_AGENT_MS, busyGraceMs = BUSY_GRACE_MS }: IdleRecyclerOptions = {},
  ) {
    this.idleMs = idleMs
    this.busyGraceMs = busyGraceMs
  }

  arm(key: string): void {
    this.clear(key)
    this.set(key, this.idleMs)
  }

  /** 计时器不再需要（实例已被回收/摘除/连接失效） */
  clear(key: string): void {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
  }

  private set(key: string, ms: number): void {
    const timer = setTimeout(() => this.onIdle(key), ms)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private onIdle(key: string): void {
    this.timers.delete(key)
    if (this.isBusy(key)) {
      this.set(key, this.busyGraceMs)
      return
    }
    this.reclaim(key)
  }
}
