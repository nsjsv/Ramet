import { describe, expect, it } from 'vitest'
import { twemojiName, twemojiUrl } from './emoji'

describe('twemojiName', () => {
  it('单码点：小写十六进制', () => {
    expect(twemojiName('🚀')).toBe('1f680')
  })

  it('没有 ZWJ 时剥掉 fe0f', () => {
    expect(twemojiName('❤️')).toBe('2764')
    expect(twemojiName('🗂️')).toBe('1f5c2')
  })

  it('ZWJ 序列保留 fe0f', () => {
    expect(twemojiName('👁️‍🗨️')).toBe('1f441-fe0f-200d-1f5e8-fe0f')
    expect(twemojiName('👨‍👩‍👧')).toBe('1f468-200d-1f469-200d-1f467')
  })

  it('国旗（区域指示符对）/ 肤色 / 键帽', () => {
    expect(twemojiName('🇯🇵')).toBe('1f1ef-1f1f5')
    expect(twemojiName('👍🏽')).toBe('1f44d-1f3fd')
    expect(twemojiName('#️⃣')).toBe('23-20e3')
  })
})

describe('twemojiUrl', () => {
  it('落在自托管的 /twemoji/ 下', () => {
    expect(twemojiUrl('🚀')).toBe('/twemoji/1f680.svg')
  })
})
