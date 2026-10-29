import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cssTimeMs, motionMs } from './motion'

/* 不变量：JS 读到的时长 = CSS 自己理解的时长，不管构建把令牌文本写成哪种形式。
 * 生产构建的 CSS 压缩会把 `--d-2: 200ms` 写成 `.2s`，parseFloat 读成 0.2（ms），
 * 「等退场动画演完再摘类」的定时器近乎立即触发，侧栏预览先跳成整高再淡出。dev 不压缩，看不出。 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 让 motionMs 读到指定的令牌文本（不依赖 DOM） */
function stubTokens(values: Record<string, string>): void {
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => values[name] ?? '' }))
}

describe('cssTimeMs', () => {
  test.each([
    ['200ms', 200],
    ['.2s', 200],
    ['.12s', 120],
    ['0.32s', 320],
    ['1s', 1000],
    ['1.5s', 1500],
    ['1e2ms', 100],
    ['2e-1s', 200],
    ['+0.5s', 500],
    [' 200ms ', 200],
    ['200MS', 200],
    ['0ms', 0],
    ['0s', 0],
    ['0', 0],
  ])('%j → %d ms', (text, ms) => {
    expect(cssTimeMs(text)).toBeCloseTo(ms, 6)
  })

  test.each(['', '  ', 'ms', 's', '200', '200px', '1.s', '1.2.3s', '5em', 'calc(100ms * 2)', 'var(--x)', 'abc'])(
    '认不出的值 %j → null',
    (text) => {
      expect(cssTimeMs(text)).toBeNull()
    },
  )
})

describe('motionMs', () => {
  test('源码写法（ms）与生产构建压缩后的写法（s）读出同一个值', () => {
    const want = [120, 200, 320]
    stubTokens({ '--d-1': '120ms', '--d-2': '200ms', '--d-3': '320ms' })
    expect((['--d-1', '--d-2', '--d-3'] as const).map(motionMs)).toEqual(want)
    stubTokens({ '--d-1': '.12s', '--d-2': '.2s', '--d-3': '.32s' })
    const minified = (['--d-1', '--d-2', '--d-3'] as const).map(motionMs)
    minified.forEach((ms, i) => expect(ms).toBeCloseTo(want[i]!, 6))
  })

  test('减弱动效：令牌归零 → 0', () => {
    stubTokens({ '--d-1': '0ms', '--d-2': '0ms', '--d-3': '0s' })
    expect([motionMs('--d-1'), motionMs('--d-2'), motionMs('--d-3')]).toEqual([0, 0, 0])
  })

  test('令牌读不出：报错并退回 0，不悄悄吞掉', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubTokens({ '--d-2': 'calc(100ms * 2)' })
    expect(motionMs('--d-2')).toBe(0)
    expect(motionMs('--d-3')).toBe(0) // 令牌不存在
    expect(error).toHaveBeenCalledTimes(2)
  })
})

describe('样式源里的时长令牌', () => {
  // base.css 里每一处 --d-N 的值（含减弱动效的归零）都必须是 motionMs 读得懂的 <time>，
  // 改成 calc() / var() 时这里先红，而不是等线上动画悄悄失效。
  // 直接读文件：vitest 默认把 CSS（含 ?raw）替换成空串
  const baseCss = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8')
  const defs = [...baseCss.matchAll(/(--d-[123]):\s*([^;]+);/g)]

  test('每个令牌都有定义（源码值 + 减弱动效值）', () => {
    expect(defs.length).toBe(6)
  })

  test.each(defs.map((m) => [m[1]!, m[2]!.trim()]))('%s: %s 读得懂', (_token, value) => {
    expect(cssTimeMs(value)).not.toBeNull()
  })
})
