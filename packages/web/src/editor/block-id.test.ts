import { describe, expect, test } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { findBlock, planBlockIds } from './block-id'

// 不变量见 block-id.ts 文件头：每个可寻址块都有非空 id，一页之内唯一，重复时身份跟着内容走。
// 用最小 schema 直接测纯函数，插件只是把 planBlockIds 的结果逐条写回。

const id = { default: '' }
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*', attrs: { id } },
    hr: { group: 'block', atom: true, attrs: { id } },
    blockquote: { group: 'block', content: 'block+', attrs: { id } },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { id } },
    list_item: { content: 'paragraph block*', attrs: { id, checked: { default: null } } },
    table: { group: 'block', content: 'paragraph+', attrs: { id } },
    agent_reply: { group: 'block', content: 'block+', attrs: { id } },
  },
})
const n = schema.nodes

const p = (text: string, pid = '') => n.paragraph!.create({ id: pid }, text ? schema.text(text) : null)
const li = (lid: string, ...content: PMNode[]) => n.list_item!.create({ id: lid }, content)
const ul = (uid: string, ...items: PMNode[]) => n.bullet_list!.create({ id: uid }, items)
const doc = (...blocks: PMNode[]) => n.doc!.create(null, blocks)
const reply = (rid: string, ...blocks: PMNode[]) => n.agent_reply!.create({ id: rid }, blocks)

/** 计数器发 id，测试里可预测 */
function ids(): () => string {
  let i = 0
  return () => `new-${++i}`
}

/** planBlockIds 的改写套到原文档上，读出「块类型:id」序列（文档序，只看块级） */
function fixed(d: PMNode): string[] {
  const patches = planBlockIds(d, ids())
  const byPos = new Map(patches.map((x) => [x.pos, x.id]))
  const out: string[] = []
  d.descendants((node, pos) => {
    if (!node.isBlock) return false
    out.push(`${node.type.name}:${byPos.has(pos) ? byPos.get(pos) : String(node.attrs.id)}`)
    return !node.isTextblock
  })
  return out
}

describe('planBlockIds：补缺', () => {
  test('顶层块与任意深度的列表项补 id；嵌套在容器里的段落不补', () => {
    const d = doc(
      p('a'),
      n.hr!.create(),
      ul('', li('', p('x'), ul('', li('', p('y'))))),
      n.blockquote!.create(null, [p('q')]),
      n.table!.create(null, [p('cell')]),
    )
    expect(fixed(d)).toEqual([
      'paragraph:new-1',
      'hr:new-2',
      'bullet_list:new-3',
      'list_item:new-4',
      'paragraph:',
      'bullet_list:',
      'list_item:new-5',
      'paragraph:',
      'blockquote:new-6',
      'paragraph:',
      'table:new-7',
      'paragraph:',
    ])
  })

  test('空片段的占位文档（默认的一个空段落）不发 id：发了它就会被 y-prosemirror 当内容写进共享文档', () => {
    expect(planBlockIds(n.doc!.createAndFill()!, ids())).toEqual([])
    expect(planBlockIds(doc(p('字')), ids())).toEqual([{ pos: 0, id: 'new-1' }])
  })

  test('AI 回复的直接子块补 id（回复里的列表项照旧补，回复里引用块内的段落不补）', () => {
    const d = doc(reply('R', p('一段'), p('两段'), ul('', li('', p('x'))), n.blockquote!.create(null, [p('q')])))
    expect(fixed(d)).toEqual([
      'agent_reply:R',
      'paragraph:new-1',
      'paragraph:new-2',
      'bullet_list:new-3',
      'list_item:new-4',
      'paragraph:',
      'blockquote:new-5',
      'paragraph:',
    ])
  })

  test('AI 回复里复制出的同 id 子块去重：有文字的保留', () => {
    expect(fixed(doc(reply('R', p('', 'X'), p('内容', 'X'))))).toEqual(['agent_reply:R', 'paragraph:new-1', 'paragraph:X'])
  })

  test('全部合规时零改写（插件据此不产生事务）', () => {
    const d = doc(p('a', 'A'), ul('U', li('L', p('x'))), n.hr!.create({ id: 'H' }))
    expect(planBlockIds(d, ids())).toEqual([])
  })
})

describe('planBlockIds：去重（身份跟着内容走）', () => {
  test('段落中间回车：两段同 id，前半段保留，后半段换新', () => {
    expect(fixed(doc(p('前半', 'X'), p('后半', 'X')))).toEqual(['paragraph:X', 'paragraph:new-1'])
  })

  test('段落开头回车：前面是空段，带内容的后半段保留', () => {
    expect(fixed(doc(p('', 'X'), p('内容', 'X')))).toEqual(['paragraph:new-1', 'paragraph:X'])
  })

  test('都没文字：第一个保留', () => {
    expect(fixed(doc(p('', 'X'), p('', 'X')))).toEqual(['paragraph:X', 'paragraph:new-1'])
  })

  test('列表条目开头回车：list 与条目都跟着内容走', () => {
    const d = doc(ul('U', li('L', p(''))), ul('U', li('L', p('买牛奶'))))
    expect(fixed(d)).toEqual([
      'bullet_list:new-1',
      'list_item:new-2',
      'paragraph:',
      'bullet_list:U',
      'list_item:L',
      'paragraph:',
    ])
  })

  test('不可寻址位置上的重复清空，不发新 id', () => {
    // 顶层段落 X 缩进进列表项后保留了 id，又在它中间回车，嵌套的两段同 id
    const d = doc(ul('U', li('L', p('前', 'X'), p('后', 'X'))))
    expect(fixed(d)).toEqual(['bullet_list:U', 'list_item:L', 'paragraph:X', 'paragraph:'])
  })

  test('嵌套与顶层之间也去重：文档序第一个有文字的保留', () => {
    const d = doc(ul('U', li('L', p('条目里', 'X'))), p('顶层', 'X'))
    expect(fixed(d)).toEqual(['bullet_list:U', 'list_item:L', 'paragraph:X', 'paragraph:new-1'])
  })
})

describe('findBlock：任意深度', () => {
  const d = doc(p('a', 'A'), ul('U', li('L1', p('x'), ul('U2', li('L2', p('y'))))))

  test('顶层块', () => {
    expect(findBlock(d, 'A')?.node.textContent).toBe('a')
  })

  test('嵌套列表项：带父列表', () => {
    const hit = findBlock(d, 'L2')
    expect(hit?.node.textContent).toBe('y')
    expect(hit?.parent?.attrs.id).toBe('U2')
    expect(d.nodeAt(hit!.pos)?.attrs.id).toBe('L2')
  })

  test('Fragment 也能找（同步块渲染从源页 Y 转出的是片段）', () => {
    expect(findBlock(d.content, 'L1')?.parent?.attrs.id).toBe('U')
  })

  test('不存在 / 空 id → null', () => {
    expect(findBlock(d, 'nope')).toBeNull()
    expect(findBlock(d, '')).toBeNull()
  })
})
