/* ---------- markdown → 块结构：GFM 表格 ----------
 * 解析出的形状必须是 @milkdown/preset-gfm 的 table > table_header_row(table_header*) + table_row+(table_cell*)，
 * cell 内恰一个 paragraph，且写进 Yjs 后回读（doc.ts 的 blockText / serializeDoc）仍是管道表格。 */

import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { materialize } from './markdown.js'
import { ReplyWriter, serializeDoc } from './doc.js'
import { encodeStats } from '@ramet/shared/reply-stats'

const TABLE = '| a | b |\n| --- | :--: |\n| 1 | 2 |\n| 3 | 4 |'

/** 块树写进一个新建文档的 agent_reply 块（materialize 要求父元素已在文档里） */
function toDoc(markdown: string): Y.Doc {
  const { blocks } = parseBlocks(markdown)
  const doc = new Y.Doc()
  const reply = new Y.XmlElement('agent_reply')
  doc.getXmlFragment('prosemirror').insert(0, [reply])
  doc.transact(() => materialize(reply, blocks))
  return doc
}

test('GFM 表格：解析成 table 结构（不是段落文本）', () => {
  const { blocks, rich } = parseBlocks(TABLE)
  expect(rich).toBe(true)
  expect(blocks.map((b) => b.name)).toEqual(['table'])

  const table = blocks[0]!
  const rows = table.blocks ?? []
  expect(rows.length).toBe(3) // 1 表头行 + 2 正文行
  expect(rows[0]!.name).toBe('table_header_row')
  expect(rows.slice(1).map((r) => r.name)).toEqual(['table_row', 'table_row'])

  for (const row of rows) {
    expect(row.blocks?.length).toBe(2) // 每行 2 个单元格
  }
  // 表头列对齐来自分隔行（'---' → null → 'left'，':--:' → 'center'）
  expect(rows[0]!.blocks?.map((c) => [c.name, c.attrs.alignment])).toEqual([
    ['table_header', 'left'],
    ['table_header', 'center'],
  ])
  expect(rows[1]!.blocks?.map((c) => [c.name, c.attrs.alignment])).toEqual([
    ['table_cell', 'left'],
    ['table_cell', 'center'],
  ])
  // cell 内恰好一个 paragraph
  for (const row of rows) {
    for (const cell of row.blocks ?? []) expect(cell.blocks?.map((b) => b.name)).toEqual(['paragraph'])
  }
})

test('GFM 表格：落进 Yjs 的是真 table 节点，回读仍是管道形态', () => {
  const doc = toDoc(TABLE)
  const reply = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement
  const table = reply.get(0) as Y.XmlElement
  expect(table.nodeName).toBe('table')
  const rows = table.toArray().map((n) => (n as Y.XmlElement).nodeName)
  expect(rows).toEqual(['table_header_row', 'table_row', 'table_row'])
  const header = table.get(0) as Y.XmlElement
  expect((header.get(0) as Y.XmlElement).nodeName).toBe('table_header')
  expect((header.get(0) as Y.XmlElement).getAttribute('alignment')).toBe('left')

  // 回喂 agent 的上下文：表头 + 对齐分隔行 + 正文行（serializeDoc 会给每行加 '> ' 引用前缀）
  const md = serializeDoc(doc.getXmlFragment('prosemirror'))
  expect(md).toContain('| a | b |')
  expect(md).toContain('| --- | :---: |')
  expect(md).toContain('| 3 | 4 |')
})

test('只有表头没有正文行的表：退回纯文本（前端 schema 要求 table_row+）', () => {
  const { blocks } = parseBlocks('| a | b |\n| --- | --- |')
  expect(blocks.map((b) => b.name)).toEqual(['paragraph'])
})

// 可寻址块（@ramet/shared/block-address）建出来就带 id：顶层块、任意深度的列表项、回复块的直接子块；
// 其余嵌套位置（列表项里的段落等）不写。

/** 块级元素的「名字:有没有 id」序列（文档序） */
function idShape(root: Y.XmlFragment): string[] {
  const out: string[] = []
  root.forEach((child) => {
    if (!(child instanceof Y.XmlElement)) return
    out.push(`${child.nodeName}:${child.getAttribute('id') ? 'id' : '-'}`)
    if (child.nodeName !== 'paragraph') out.push(...idShape(child))
  })
  return out
}

test('materialize：直接写进正文的顶层块与列表项带 id，各不相同', () => {
  const doc = new Y.Doc()
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => materialize(body, parseBlocks('段落\n\n- 一\n  - 二\n\n```\ncode\n```').blocks))
  expect(idShape(body)).toEqual([
    'paragraph:id',
    'bullet_list:id',
    'list_item:id',
    'paragraph:-',
    'bullet_list:-',
    'list_item:id',
    'paragraph:-',
    'code_block:id',
  ])
  const ids: string[] = []
  const walk = (f: Y.XmlFragment) =>
    f.forEach((c) => {
      if (!(c instanceof Y.XmlElement)) return
      const id = c.getAttribute('id')
      if (id) ids.push(id)
      walk(c)
    })
  walk(body)
  expect(new Set(ids).size).toBe(ids.length)
})

test('materialize：写进回复块时，回复的直接子块（段落 / 列表）带 id，列表项照样有，列表项里的段落不写', () => {
  const doc = toDoc('段落\n\n- 一')
  const reply = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement
  expect(idShape(reply)).toEqual(['paragraph:id', 'bullet_list:id', 'list_item:id', 'paragraph:-'])
})

/* ---------- 页面提及：`[@名字](page:<页 id>)` 落成 page_mention 原子（@ramet/shared/markdown-blocks 的 pageMentionOf） ---------- */

const PAGE = '0b6c2d7e-1f3a-4c5b-9d8e-7a6b5c4d3e2f'

/** 第一段的行内内容 */
const inlinesOf = (markdown: string) => parseBlocks(markdown).blocks[0]?.inlines ?? []

test('页面提及的链接形态：文字恰为 @名字、只有这一个 page: 链接 → page_mention{pageId,title}', () => {
  expect(inlinesOf(`看 [@周报](page:${PAGE}) 吧`)).toEqual([
    { text: '看 ', marks: [] },
    { atom: 'page_mention', attrs: { pageId: PAGE, title: '周报' } },
    { text: ' 吧', marks: [] },
  ])
  // id 统一小写（同导入）；标题里转义过的 markdown 记号原样回来；写入方在 == 之间垫的零宽空格去掉
  expect(inlinesOf(`[@\\*\\*粗\\*\\* \\[x\\] a=\u200b=b](page:${PAGE.toUpperCase()})`)).toEqual([
    { atom: 'page_mention', attrs: { pageId: PAGE, title: '**粗** [x] a==b' } },
  ])
})

test('页面提及的链接形态：别的写法照旧是链接', () => {
  const linkOnly = (markdown: string) => inlinesOf(markdown).every((i) => !('atom' in i))
  expect(linkOnly(`[周报](page:${PAGE})`)).toBe(true) // 不是 @ 开头
  expect(linkOnly(`[@](page:${PAGE})`)).toBe(true) // 只有 @
  expect(linkOnly(`[@周报](page:${PAGE}#blk-1)`)).toBe(true) // 块引用
  expect(linkOnly('[@周报](page:not-a-page-id)')).toBe(true)
  expect(linkOnly(`[@周报](https://x.com/${PAGE})`)).toBe(true)
  expect(linkOnly(`[@**周报**](page:${PAGE})`)).toBe(true) // 链接里还有别的格式
  expect(linkOnly(`**[@周报](page:${PAGE})**`)).toBe(true) // 链接外面有格式
})

test('agent 回复收尾：任务链接在 Yjs 里是 page_mention 元素（不是带 link 的文字）', () => {
  const doc = new Y.Doc()
  const writer = new ReplyWriter(doc, 'ramet:assistant')
  writer.finalize(`派好了：[@修 bug](page:${PAGE})`, encodeStats({ o: 'end' }), null)
  const reply = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement
  const para = reply.get(0) as Y.XmlElement
  const parts = para.toArray()
  const chip = parts.find((n): n is Y.XmlElement => n instanceof Y.XmlElement)
  expect(chip?.nodeName).toBe('page_mention')
  expect(chip?.getAttribute('pageId')).toBe(PAGE)
  expect(chip?.getAttribute('title')).toBe('修 bug')
  const texts = parts.filter((n): n is Y.XmlText => n instanceof Y.XmlText)
  expect(texts.map((t) => t.toDelta())).toEqual([[{ insert: '派好了：' }]])
})
