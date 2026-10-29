/* ---------- 终端延迟标签的数字：最近的往返样本、分位数 ----------
 * 标签人人可见（形如「中继 · 85ms」）；诊断模式（?diag=1）下另外显示往返与回显的 p50 / p95，供传输对比用。 */

/** 最近 keep 个样本 */
export class LatencySamples {
  private xs: number[] = []
  constructor(private readonly keep = 50) {}
  add(ms: number): void {
    this.xs.push(ms)
    if (this.xs.length > this.keep) this.xs.shift()
  }
  get values(): readonly number[] {
    return this.xs
  }
}

/** 第 p 百分位（最近秩法：p50 = 中位数，p95 = 第 95%）；没有样本 = null */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!
}

/** p50 / p95，都取整；没有样本 = null */
export function spread(xs: readonly number[]): { p50: number; p95: number } | null {
  const p50 = percentile(xs, 50)
  const p95 = percentile(xs, 95)
  return p50 === null || p95 === null ? null : { p50: Math.round(p50), p95: Math.round(p95) }
}
