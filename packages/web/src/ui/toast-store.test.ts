import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createToastStore, TOAST_MAX, TOAST_MS } from './toast-store'
import { createLayerStore } from './layer-host'

const EXIT = 120

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const live = (s: ReturnType<typeof createToastStore>): string[] => s.snapshot().filter((t) => !t.leaving).map((t) => t.message)

describe('toast store', () => {
  test('到时先演退场，退场演完才摘掉', () => {
    const s = createToastStore(() => EXIT)
    s.push('a', 'info')
    vi.advanceTimersByTime(TOAST_MS.info - 1)
    expect(s.snapshot()[0]?.leaving).toBe(false)
    vi.advanceTimersByTime(1)
    expect(s.snapshot()[0]?.leaving).toBe(true)
    vi.advanceTimersByTime(EXIT)
    expect(s.snapshot()).toEqual([])
  })

  test('出错的停留更久；可以自定时长', () => {
    const s = createToastStore(() => 0)
    s.push('err', 'error')
    s.push('custom', 'info', 10_000)
    vi.advanceTimersByTime(TOAST_MS.info)
    expect(live(s)).toEqual(['err', 'custom'])
    vi.advanceTimersByTime(TOAST_MS.error - TOAST_MS.info)
    expect(live(s)).toEqual(['custom'])
  })

  test('最多同时 3 条：新的进来，最早那条退场；新的排在最后', () => {
    const s = createToastStore(() => EXIT)
    for (const m of ['1', '2', '3', '4']) s.push(m, 'info')
    expect(TOAST_MAX).toBe(3)
    expect(live(s)).toEqual(['2', '3', '4'])
    expect(s.snapshot().map((t) => t.message)).toEqual(['1', '2', '3', '4'])
    vi.advanceTimersByTime(EXIT)
    expect(s.snapshot().map((t) => t.message)).toEqual(['2', '3', '4'])
  })

  test('同一句话还在显示：不叠第二条，重新计时', () => {
    const s = createToastStore(() => 0)
    s.push('same', 'error')
    vi.advanceTimersByTime(TOAST_MS.error - 100)
    s.push('same', 'error')
    expect(s.snapshot()).toHaveLength(1)
    vi.advanceTimersByTime(TOAST_MS.error - 1)
    expect(live(s)).toEqual(['same'])
    vi.advanceTimersByTime(1)
    expect(s.snapshot()).toEqual([])
  })

  test('悬停暂停计时，移开后接着走（至少再留一会儿）', () => {
    const s = createToastStore(() => 0)
    const id = s.push('a', 'info')
    vi.advanceTimersByTime(1000)
    s.pause(id)
    vi.advanceTimersByTime(60_000)
    expect(live(s)).toEqual(['a'])
    s.resume(id)
    vi.advanceTimersByTime(TOAST_MS.info - 1000 - 1)
    expect(live(s)).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(s.snapshot()).toEqual([])

    const late = s.push('b', 'info')
    vi.advanceTimersByTime(TOAST_MS.info - 10)
    s.pause(late)
    s.resume(late)
    vi.advanceTimersByTime(1000)
    expect(live(s)).toEqual(['b'])
  })

  test('点叉立即退场；对已经摘掉的再点无害', () => {
    const s = createToastStore(() => 0)
    const id = s.push('a', 'info')
    s.dismiss(id)
    expect(s.snapshot()).toEqual([])
    s.dismiss(id)
    s.pause(id)
    s.resume(id)
    expect(s.snapshot()).toEqual([])
  })

  test('订阅方在变化时收到通知', () => {
    const s = createToastStore(() => 0)
    const fn = vi.fn()
    const off = s.subscribe(fn)
    s.push('a', 'info')
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    s.push('b', 'info')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('layer store', () => {
  test('按加入顺序排；摘掉只摘自己，重复摘无害', () => {
    const s = createLayerStore()
    const fn = vi.fn()
    s.subscribe(fn)
    const offA = s.add('a')
    const offB = s.add('b')
    expect(s.snapshot().map((l) => l.node)).toEqual(['a', 'b'])
    offA()
    offA()
    expect(s.snapshot().map((l) => l.node)).toEqual(['b'])
    expect(fn).toHaveBeenCalledTimes(3)
    offB()
    expect(s.snapshot()).toEqual([])
  })
})
