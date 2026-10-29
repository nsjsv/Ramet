import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { blockTexts, CREATE_SUMMARY, diffBlocks, MAX_BLOCKS, summarizeChange, SUMMARY_TEXT_MAX, textOf } from './updates.js'

// 造一个含 N 个块(每块 paragraph > text)的页面正文 doc
function docWithBlocks(blocks: string[]): Y.Doc {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  frag.insert(
    0,
    blocks.map((text) => {
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, text)
      p.insert(0, [t])
      return p
    }),
  )
  return doc
}

/** 段落里放一个 image 节点（image 是行内 atom，attrs 见前端 image schema） */
function imageAttrs(src: string, alt = '', title = ''): Y.XmlElement {
  const img = new Y.XmlElement('image')
  img.setAttribute('src', src)
  img.setAttribute('alt', alt)
  img.setAttribute('title', title)
  return img
}

function docWithImage(src: string, alt = '', title = ''): Y.Doc {
  const doc = new Y.Doc()
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [imageAttrs(src, alt, title)])
  doc.getXmlFragment('prosemirror').insert(0, [p])
  return doc
}

// 嵌套结构:blockquote > paragraph > text(摘要只管拼文字,不关心层级)
function docWithNested(): Y.Doc {
  const doc = new Y.Doc()
  const quote = new Y.XmlElement('blockquote')
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, '引用里的文字')
  p.insert(0, [t])
  quote.insert(0, [p])
  doc.getXmlFragment('prosemirror').insert(0, [quote])
  return doc
}

describe('blockTexts', () => {
  test('顶层块逐块取文字', () => {
    expect(blockTexts(docWithBlocks(['第一段', '第二段', '']))).toEqual(['第一段', '第二段', ''])
  })

  test('嵌套元素递归拼接文字', () => {
    expect(blockTexts(docWithNested())).toEqual(['引用里的文字'])
  })

  test('超 MAX_BLOCKS 截断', () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => `块${i}`)
    const out = blockTexts(docWithBlocks(blocks))
    expect(out).toHaveLength(MAX_BLOCKS)
    expect(out[0]).toBe('块0')
  })

  test('空文档 → 空数组', () => {
    expect(blockTexts(new Y.Doc())).toEqual([])
  })
})

describe('textOf 图片记号', () => {
  const ID = '11111111-2222-3333-4444-555555555555'

  test('本站图片 → image:<uuid>（原图与 /display 归一成同一个 id）', () => {
    expect(textOf(docWithImage(`/api/files/${ID}`).getXmlFragment('prosemirror'))).toBe(`image:${ID}`)
    expect(textOf(docWithImage(`/api/files/${ID}/display`).getXmlFragment('prosemirror'))).toBe(`image:${ID}`)
  })

  test('有 alt 时同一行补一句原文，换行压成空格', () => {
    const frag = docWithImage(`/api/files/${ID}`, '系统\n架构 图').getXmlFragment('prosemirror')
    expect(textOf(frag)).toBe(`image:${ID} 系统 架构 图`)
  })

  test('外链图片只给 src 原文，不下载、不取字节（没有 image: 的 uuid 形态）', () => {
    const frag = docWithImage('https://example.com/a.png', '封面').getXmlFragment('prosemirror')
    expect(textOf(frag)).toBe('image:https://example.com/a.png')
    // 外链的 alt 不追加（alt 只对本站图片有意义）
    expect(textOf(frag)).not.toContain('封面')
  })

  test('图片与相邻文本共处一段时按行内拼接', () => {
    const doc = new Y.Doc()
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    t.insert(0, '看图 ')
    p.insert(0, [t, imageAttrs(`/api/files/${ID}`)])
    doc.getXmlFragment('prosemirror').insert(0, [p])
    expect(textOf(doc.getXmlFragment('prosemirror'))).toBe(`看图 image:${ID}`)
  })
})

describe('diffBlocks', () => {
  test('两侧相等 → 无摘要项', () => {
    expect(diffBlocks(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  test('尾部新增 → add', () => {
    expect(diffBlocks(['a'], ['a', '新增块'])).toEqual([{ kind: 'add', text: '新增块' }])
  })

  test('尾部删除 → del', () => {
    expect(diffBlocks(['a', '被删块'], ['a'])).toEqual([{ kind: 'del', text: '被删块' }])
  })

  test('同位置一删一加配对成 edit,文字取 cur 侧', () => {
    expect(diffBlocks(['旧内容'], ['新内容'])).toEqual([{ kind: 'edit', text: '新内容' }])
  })

  test('中间改动 + 相等段保序:edit 只落在改动处', () => {
    const items = diffBlocks(['a', '旧', 'c'], ['a', '新', 'c'])
    expect(items).toEqual([{ kind: 'edit', text: '新' }])
  })

  test('多删少加:一个 edit + 一个落单 del(同时含「已删除」和新增项,PRD 场景)', () => {
    const items = diffBlocks(['保留', '删一', '删二'], ['保留', '加一'])
    expect(items).toEqual([
      { kind: 'edit', text: '加一' },
      { kind: 'del', text: '删二' },
    ])
  })

  test('少删多加:一个 edit + 一个落单 add(与上一例对称,余量在 add 侧)', () => {
    const items = diffBlocks(['A', '删一', 'B'], ['A', '加一', '加二', 'B'])
    expect(items).toEqual([
      { kind: 'edit', text: '加一' },
      { kind: 'add', text: '加二' },
    ])
  })

  test('删一块 + 另位置加一块(公共块隔开):同时含 del 与 add(PRD 验收 3)', () => {
    const items = diffBlocks(['a', '被删块', 'b'], ['a', 'b', '新增块'])
    expect(items).toEqual([
      { kind: 'del', text: '被删块' },
      { kind: 'add', text: '新增块' },
    ])
  })

  test('无公共块:整个序列一个游程,del/add 就近配对,多余一侧落单', () => {
    const items = diffBlocks(['删一', '删二'], ['加一', '加二', '加三'])
    expect(items).toEqual([
      { kind: 'edit', text: '加一' },
      { kind: 'edit', text: '加二' },
      { kind: 'add', text: '加三' },
    ])
  })

  test('LCS 语义:两处独立改动各自成 edit,不把相等段算进差异', () => {
    const items = diffBlocks(['x', 'a1', 'mid', 'b1', 'y'], ['x', 'a2', 'mid', 'b2', 'y'])
    expect(items).toEqual([
      { kind: 'edit', text: 'a2' },
      { kind: 'edit', text: 'b2' },
    ])
  })

  test('空 → 全 add;全删 → 空', () => {
    expect(diffBlocks([], ['a', 'b'])).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
    expect(diffBlocks(['a', 'b'], [])).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
    ])
    expect(diffBlocks([], [])).toEqual([])
  })

  test('空块不进摘要:加减空行无项;字删光记成删除原文字;空行不打乱相邻块的配对', () => {
    expect(diffBlocks(['a'], ['a', ''])).toEqual([])
    expect(diffBlocks(['a', ' ', 'b'], ['a', 'b'])).toEqual([])
    expect(diffBlocks(['a', '旧文字'], ['a', ''])).toEqual([{ kind: 'del', text: '旧文字' }])
    expect(diffBlocks(['x', 'abc', 'y'], ['x', '', 'abd', 'y'])).toEqual([{ kind: 'edit', text: 'abd' }])
  })

  test('超 80 字符的摘要文字截断(SUMMARY_TEXT_MAX)', () => {
    const long = '长'.repeat(SUMMARY_TEXT_MAX + 30)
    const items = diffBlocks([], [long])
    expect(items[0]!.text).toHaveLength(SUMMARY_TEXT_MAX)
    const dels = diffBlocks([long], [])
    expect(dels[0]!.text).toHaveLength(SUMMARY_TEXT_MAX)
  })
})

describe('summarizeChange', () => {
  test('首条快照(无前驱)→ create,空文字', () => {
    expect(summarizeChange(null, { title: '任意', blocks: ['a'] })).toEqual(CREATE_SUMMARY)
    expect(CREATE_SUMMARY).toEqual([{ kind: 'create', text: '' }])
  })

  test('标题不同追加 title 项(新标题),标题相同不追加', () => {
    const prev = { title: '旧标题', blocks: ['a'] }
    const cur = { title: '新标题', blocks: ['a'] }
    expect(summarizeChange(prev, cur)).toEqual([{ kind: 'title', text: '新标题' }])
    expect(summarizeChange(cur, cur)).toEqual([])
  })

  test('正文 + 标题同时变更:diff 项在前,title 项在末尾', () => {
    const items = summarizeChange(
      { title: '旧标题', blocks: ['旧段'] },
      { title: '新标题', blocks: ['新段'] },
    )
    expect(items).toEqual([
      { kind: 'edit', text: '新段' },
      { kind: 'title', text: '新标题' },
    ])
  })
})
