/* ---------- 闲置回收判据（中心与 connector 共用）----------
 * 不变量：到期时还有在飞工作就不回收。长轮次全程只发事件、不发请求，
 * 只按"最后一次请求"计时会在中途把在飞轮次 SIGTERM 掉（用户看到「已停止」）。 */

import { expect, test, vi } from 'vitest'
import { IdleRecycler } from './idle.js'

test('到期时才看忙不忙：忙 → 续期不回收；闲 → 回收', () => {
  vi.useFakeTimers()
  try {
    let busy = true
    const reclaimed: string[] = []
    const recycler = new IdleRecycler(() => busy, (key) => void reclaimed.push(key), {
      idleMs: 1_000,
      busyGraceMs: 500,
    })

    recycler.arm('a')
    vi.advanceTimersByTime(1_000)
    expect(reclaimed).toEqual([]) // 在飞工作：只续期
    vi.advanceTimersByTime(500)
    expect(reclaimed).toEqual([]) // 仍在飞

    busy = false
    vi.advanceTimersByTime(500)
    expect(reclaimed).toEqual(['a']) // 忙→闲后的第一次到期才回收

    recycler.arm('b')
    vi.advanceTimersByTime(1_000)
    expect(reclaimed).toEqual(['a', 'b']) // 空闲状态下的 arm：到期即回收

    recycler.arm('c')
    recycler.clear('c')
    vi.advanceTimersByTime(60_000)
    expect(reclaimed).toEqual(['a', 'b']) // clear 后不再回收
  } finally {
    vi.useRealTimers()
  }
})

test('arm 重新计时：请求到达（arm）会把窗口推后', () => {
  vi.useFakeTimers()
  try {
    const reclaimed: string[] = []
    const recycler = new IdleRecycler(() => false, (key) => reclaimed.push(key), { idleMs: 1_000 })

    recycler.arm('a')
    vi.advanceTimersByTime(900)
    recycler.arm('a') // 新请求到达：从"现在"重新计时
    vi.advanceTimersByTime(900)
    expect(reclaimed).toEqual([])
    vi.advanceTimersByTime(100)
    expect(reclaimed).toEqual(['a'])
  } finally {
    vi.useRealTimers()
  }
})
