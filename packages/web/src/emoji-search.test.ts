import { describe, expect, it } from 'vitest'
import data from '@emoji-mart/data/sets/15/twitter.json'
import zh from './emoji-zh.json'
import { addZhKeywords, hexKey, suffixes, type EmojiMartData, type ZhKeywords } from './emoji-search'

/** emoji-mart 搜索的最小复刻（node_modules/emoji-mart/dist/module.js 的 search）：
 * 词串 = ',' + 各 keywords 小写用 ',' 连接；命中 = indexOf(',' + 查询词) 非 -1（词首前缀匹配） */
function matches(keywords: string[], query: string): boolean {
  return `,${keywords.map((k) => k.toLowerCase()).join(',')}`.indexOf(`,${query.toLowerCase()}`) !== -1
}

describe('hexKey', () => {
  it('小写并去掉 fe0f', () => {
    expect(hexKey('2764-FE0F')).toBe('2764')
    expect(hexKey('1F926-200D-2642-FE0F')).toBe('1f926-200d-2642')
    expect(hexKey('1f680')).toBe('1f680')
  })
})

describe('suffixes', () => {
  it('词本身 + 所有后缀', () => {
    expect(suffixes('火箭')).toEqual(['火箭', '箭'])
    expect(suffixes('嘿嘿笑脸')).toEqual(['嘿嘿笑脸', '嘿笑脸', '笑脸', '脸'])
  })
})

describe('addZhKeywords', () => {
  const zhMini: ZhKeywords = { '1f680': ['火箭', '发射'], '1f1e6': ['区域指标 A'] }
  const mini = (): EmojiMartData => ({
    emojis: {
      rocket: { keywords: ['ship', 'launch'], skins: [{ unified: '1f680' }] },
      regional_indicator_a: { skins: [{ unified: '1f1e6' }] },
      unlisted: { keywords: ['x'], skins: [{ unified: '1f9ff' }] },
    },
  })

  it('保留英文关键词并并入中文词及其后缀', () => {
    const out = addZhKeywords(mini(), zhMini)
    const kw = out.emojis.rocket!.keywords!
    expect(kw).toEqual(expect.arrayContaining(['ship', 'launch', '火箭', '箭', '发射', '射']))
  })

  it('带空格的名字拆片后再展开；原本没有 keywords 的也能补上', () => {
    const out = addZhKeywords(mini(), zhMini)
    expect(out.emojis.regional_indicator_a!.keywords).toEqual(expect.arrayContaining(['区域指标', '指标', '标', 'A']))
  })

  it('词表里没有的 emoji 原样不动', () => {
    const out = addZhKeywords(mini(), zhMini)
    expect(out.emojis.unlisted!.keywords).toEqual(['x'])
  })

  it('词首与词中都能命中（emoji-mart 是前缀匹配）', () => {
    const kw = addZhKeywords(mini(), zhMini).emojis.rocket!.keywords!
    expect(matches(kw, '火')).toBe(true)
    expect(matches(kw, '箭')).toBe(true)
    expect(matches(kw, 'launch')).toBe(true)
    expect(matches(kw, '猫')).toBe(false)
  })
})

/* 真数据对齐：词表（emojibase 17）与选择器数据（emoji-mart sets/15）的码点要对得上，
 * 否则中文词表静默挂不上 —— 这里守住覆盖率和几个典型词 */
describe('真实数据', () => {
  const merged = addZhKeywords(structuredClone(data) as unknown as EmojiMartData, zh as ZhKeywords)
  const kwOf = (id: string) => merged.emojis[id]?.keywords ?? []

  it('绝大多数 emoji 都挂上了中文词', () => {
    const all = Object.values(merged.emojis)
    const withZh = all.filter((e) => (e.keywords ?? []).some((k) => /[一-鿿]/.test(k)))
    expect(withZh.length / all.length).toBeGreaterThan(0.95)
  })

  it('典型中文词能搜到对应 emoji', () => {
    expect(matches(kwOf('rocket'), '火箭')).toBe(true)
    expect(matches(kwOf('grinning'), '笑')).toBe(true)
    expect(matches(kwOf('cat'), '猫')).toBe(true)
    expect(matches(kwOf('dog'), '狗')).toBe(true)
  })
})
