// ---------- 失败次数限速（进程内）----------
// 给「重输登录密码」这类敏感确认用：同一个键（用户 id）在窗口内失败 max 次后，窗口结束前一律拒绝，连正确密码也拒，
// 否则限速形同虚设。登录接口本身没有限速。单进程内存计数，重启清零。

export class FailureLimiter {
  private failures = new Map<string, number[]>()

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** 还要等多少毫秒才允许再试；0 = 现在可以试 */
  blockedFor(key: string, now: number = Date.now()): number {
    const recent = this.recent(key, now)
    if (recent.length < this.max) return 0
    return recent[0]! + this.windowMs - now
  }

  /** 记一次失败 */
  fail(key: string, now: number = Date.now()): void {
    const recent = this.recent(key, now)
    recent.push(now)
    this.failures.set(key, recent)
  }

  /** 成功后清零 */
  reset(key: string): void {
    this.failures.delete(key)
  }

  /** 窗口内的失败时刻（顺手丢掉过期的，Map 不会无限涨） */
  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs)
    if (kept.length === 0) this.failures.delete(key)
    else this.failures.set(key, kept)
    return kept
  }
}
