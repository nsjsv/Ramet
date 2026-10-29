import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { absoluteHref, editLinkTr, findLink, shortHref } from './link-edit'
import { linkRangeAt } from './link-input'
import { doc, schema, stateAt } from './test-schema'

const link = (href: string) => schema.marks.link!.create({ href })
const strong = schema.marks.strong!.create()
const t = (text: string, ...marks: ReturnType<typeof link>[]) => schema.text(text, marks)
const para = (...inline: PMNode[]) => schema.nodes.paragraph!.create(null, inline)

/** 段落里的 (文字, 链接地址 | '', 是否加粗) 列表 */
function runs(d: PMNode): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = []
  d.descendants((node) => {
    if (!node.isText) return true
    const href = node.marks.find((m) => m.type.name === 'link')?.attrs.href ?? ''
    out.push([node.text!, String(href), node.marks.some((m) => m.type.name === 'strong')])
    return false
  })
  return out
}

// 「看 Ramet 文档」：链接「Ramet 文档」= 位置 3..11（段落内容从 1 开始，「看 」占 2 格）
const base = () => doc(para(t('看 '), t('Ramet', link('https://a.com'), strong), t(' 文档', link('https://a.com')), t('。')))
const range = { from: 3, to: 11, href: 'https://a.com' }

function edit(text: string, href: string, d = base()) {
  const state = stateAt(d, 1)
  const tr = editLinkTr(state, range, text, href)
  return tr && state.apply(tr).doc
}

describe('linkRangeAt', () => {
  it('同一 href 的相邻文本（格式不同）连成一条', () => {
    expect(linkRangeAt(stateAt(base(), 1), 5)).toEqual(range)
    expect(linkRangeAt(stateAt(base(), 1), 1)).toBeNull()
  })
})

describe('editLinkTr', () => {
  it('只改地址：文字和加粗原样保留', () => {
    expect(runs(edit('Ramet 文档', 'b.com')!)).toEqual([
      ['看 ', '', false],
      ['Ramet', 'https://b.com', true],
      [' 文档', 'https://b.com', false],
      ['。', '', false],
    ])
  })

  it('改文字：整段换新字，沿用第一个字符的格式', () => {
    expect(runs(edit('新标题', 'https://a.com')!)).toEqual([
      ['看 ', '', false],
      ['新标题', 'https://a.com', true],
      ['。', '', false],
    ])
  })

  it('文字和地址一起改', () => {
    expect(runs(edit('别处', '/page/x')!)[1]).toEqual(['别处', '/page/x', true])
  })

  it('地址清空 = 摘链接留文字', () => {
    expect(runs(edit('Ramet 文档', '  ')!)).toEqual([
      ['看 ', '', false],
      ['Ramet', '', true],
      [' 文档。', '', false],
    ])
  })

  it('文字清空 = 用地址作文字', () => {
    expect(runs(edit('', 'b.com')!)[1]).toEqual(['https://b.com', 'https://b.com', true])
  })

  it('都没变 = 不写文档', () => {
    expect(edit('Ramet 文档', 'https://a.com')).toBeNull()
  })
})

describe('findLink', () => {
  it('同一 href 的多条链接：文字相同优先，再取离原位置最近的', () => {
    const d = doc(para(t('x', link('/a'))), para(t('目标', link('/a'))), para(t('目标', link('/a'))))
    const state = stateAt(d, 1)
    expect(findLink(state, { href: '/a', text: '目标', from: 1 })).toEqual({ from: 4, to: 6, href: '/a' })
    expect(findLink(state, { href: '/a', text: '目标', from: 9 })).toEqual({ from: 8, to: 10, href: '/a' })
    expect(findLink(state, { href: '/a', text: '改了字', from: 9 })).toEqual({ from: 8, to: 10, href: '/a' })
  })

  it('链接没了 = null', () => {
    expect(findLink(stateAt(doc(para(t('纯文字'))), 1), { href: '/a', text: '纯文字', from: 1 })).toBeNull()
  })
})

describe('shortHref / absoluteHref', () => {
  it('去协议、www. 与只剩域名时的末尾 /', () => {
    expect(shortHref('https://www.example.com/')).toBe('example.com')
    expect(shortHref('http://example.com/a/b?c=1')).toBe('example.com/a/b?c=1')
    expect(shortHref('mailto:me@x.com')).toBe('me@x.com')
    expect(shortHref('/page/abc')).toBe('/page/abc')
  })

  it('站内相对地址补 origin，其余原样', () => {
    expect(absoluteHref('/page/abc', 'https://r.io')).toBe('https://r.io/page/abc')
    expect(absoluteHref('https://a.com', 'https://r.io')).toBe('https://a.com')
    expect(absoluteHref('//cdn.com/x', 'https://r.io')).toBe('//cdn.com/x')
  })
})
