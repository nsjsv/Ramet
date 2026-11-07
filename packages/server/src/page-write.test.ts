/* ---------- edit_page 的 `new` → 块（纯函数，不连库） ----------
 * 两种页面提及：裸记号 `page:<uuid>`（read_page 读到的 chip 就是这样写的），与回复里的链接形态 `[@名字](page:<uuid>)`
 * （@ramet/shared/markdown-blocks 落 agent 回复时的同一条规则）。 */
import { describe, expect, it } from 'vitest'
import type { Block, Inline } from '@ramet/shared/markdown-blocks'
import { parseNew } from './page-write.js'

const A = '0b6c2d7e-1f3a-4c5b-9d8e-7a6b5c4d3e2f'
const B = '1c7d3e8f-2a4b-4d6c-8e9f-0a1b2c3d4e5f'

const inlines = (blocks: Block[]): Inline[] => blocks.flatMap((b) => b.inlines ?? (b.blocks ? inlines(b.blocks) : []))
const chip = (pageId: string, title = '') => ({ atom: 'page_mention', attrs: { pageId, title } })

describe('parseNew：页面提及', () => {
  it('链接形态 [@名字](page:<uuid>) 落成一颗带标题的 chip，旁边不留 `[@名字](` / `)` 的碎字', () => {
    expect(inlines(parseNew(`派好了：[@修 bug](page:${A}) 跑着呢`))).toEqual([
      { text: '派好了：', marks: [] },
      chip(A, '修 bug'),
      { text: ' 跑着呢', marks: [] },
    ])
  })

  it('裸记号照旧升成 chip（标题空）；和链接形态写在同一行也各是各的', () => {
    expect(inlines(parseNew(`前面 page:${A} 后面`))).toEqual([{ text: '前面 ', marks: [] }, chip(A), { text: ' 后面', marks: [] }])
    expect(inlines(parseNew(`见 page:${A} 和 [@任务](page:${B})`))).toEqual([{ text: '见 ', marks: [] }, chip(A), { text: ' 和 ', marks: [] }, chip(B, '任务')])
  })

  it('多行里的记号逐行落块；行内代码里的记号不动', () => {
    const blocks = parseNew(`第一行 [@甲](page:${A})\n\`page:${B}\` 原样`)
    expect(blocks).toHaveLength(2)
    expect(inlines([blocks[0]!])).toEqual([{ text: '第一行 ', marks: [] }, chip(A, '甲')])
    expect(inlines([blocks[1]!])).toEqual([
      { text: `page:${B}`, marks: [{ name: 'inlineCode', attrs: {} }] },
      { text: ' 原样', marks: [] },
    ])
  })

  it('不是这个形状的 page: 链接（块引用、文字不是 @ 开头）留成链接，不切出空 chip', () => {
    for (const md of [`[@某块](page:${A}#blk)`, `[文档](page:${A})`]) {
      expect(inlines(parseNew(md)).some((i) => 'atom' in i)).toBe(false)
    }
  })
})
