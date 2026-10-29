import { describe, expect, test } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { anchorOfRange, findTextInBlock, TEXT_ANCHOR_MAX } from './text-anchor'

/* 不变量（text-anchor.ts 文件头）：锚 = 选区起点所在的最近可寻址块（有 id）+ 落在这个块里的那段字 + 第几处；
 * 查找与复制同一口径（text 节点 + 带 leafText 的行内原子按文档序直接拼），跨 mark / 跨原子都能映射回文档位置。 */

const id = { default: '' }
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    chip: { group: 'inline', inline: true, atom: true, attrs: { label: { default: '' } }, leafText: (n) => String(n.attrs.label) },
    paragraph: { group: 'block', content: 'inline*', attrs: { id } },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { id } },
    list_item: { content: 'paragraph block*', attrs: { id } },
    agent_reply: { group: 'block', content: 'block+', attrs: { id } },
  },
  marks: { strong: {} },
})
const n = schema.nodes
const t = (s: string, bold = false) => schema.text(s, bold ? [schema.marks.strong!.create()] : [])
const p = (pid: string, ...inline: PMNode[]) => n.paragraph!.create({ id: pid }, inline)
const doc = (...blocks: PMNode[]) => n.doc!.create(null, blocks)

/** 文档里第 k 处 needle 的位置（测试里找选区端点用） */
function posOf(d: PMNode, needle: string, k = 0): number {
  let found = -1
  let seen = 0
  d.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0
    let i = node.text!.indexOf(needle)
    while (i !== -1 && found < 0) {
      if (seen++ === k) found = pos + i
      i = node.text!.indexOf(needle, i + 1)
    }
    return false
  })
  return found
}

describe('anchorOfRange', () => {
  test('段落里选几个字：块 id + 那段字，第一处 n=0', () => {
    const d = doc(p('A', t('今天开会讨论预算')))
    const from = posOf(d, '讨论')
    expect(anchorOfRange(d, from, from + 2)).toEqual({ blockId: 'A', text: '讨论', n: 0 })
  })

  test('同一句在块里出现两次：选第二处 n=1', () => {
    const d = doc(p('A', t('预算，再说预算')))
    const from = posOf(d, '预算', 1)
    expect(anchorOfRange(d, from, from + 2)).toEqual({ blockId: 'A', text: '预算', n: 1 })
  })

  test('跨 mark：字拼起来，不受加粗分段影响', () => {
    const d = doc(p('A', t('前'), t('加粗', true), t('后')))
    const from = posOf(d, '前')
    expect(anchorOfRange(d, from, from + 4)?.text).toBe('前加粗后')
  })

  test('跨块选区只取起点块里的部分', () => {
    const d = doc(p('A', t('第一段')), p('B', t('第二段')))
    const from = posOf(d, '一段')
    const to = posOf(d, '第二') + 2
    expect(anchorOfRange(d, from, to)).toEqual({ blockId: 'A', text: '一段', n: 0 })
  })

  test('列表项里的段落：锚在列表项上', () => {
    const d = doc(n.bullet_list!.create({ id: 'U' }, [n.list_item!.create({ id: 'L' }, [p('', t('买牛奶'))])]))
    const from = posOf(d, '牛奶')
    expect(anchorOfRange(d, from, from + 2)?.blockId).toBe('L')
  })

  test('AI 回复里的段落：锚在回复的子块上', () => {
    const d = doc(n.agent_reply!.create({ id: 'R' }, [p('C1', t('回答第一段')), p('C2', t('回答第二段'))]))
    const from = posOf(d, '第二段')
    expect(anchorOfRange(d, from, from + 3)).toEqual({ blockId: 'C2', text: '第二段', n: 0 })
  })

  test('超长选区截到上限；全是空白 / 块没 id → null', () => {
    const long = '字'.repeat(TEXT_ANCHOR_MAX + 50)
    const d = doc(p('A', t(long)), p('', t('无 id')), p('S', t('   ')))
    expect(anchorOfRange(d, 1, 1 + long.length)?.text.length).toBe(TEXT_ANCHOR_MAX)
    const noId = posOf(d, '无')
    expect(anchorOfRange(d, noId, noId + 1)).toBeNull()
    const blank = posOf(d, '   ')
    expect(anchorOfRange(d, blank, blank + 3)).toBeNull()
  })
})

describe('findTextInBlock', () => {
  test('第 n 处 → 文档区间；不够 n 处取第一处；找不到 → null', () => {
    const d = doc(p('A', t('预算，再说预算')))
    const block = d.child(0)
    expect(findTextInBlock(block, 0, '预算', 1)).toEqual({ from: posOf(d, '预算', 1), to: posOf(d, '预算', 1) + 2 })
    expect(findTextInBlock(block, 0, '预算', 5)).toEqual({ from: posOf(d, '预算'), to: posOf(d, '预算') + 2 })
    expect(findTextInBlock(block, 0, '不存在', 0)).toBeNull()
  })

  test('跨原子：原子按整个节点进区间', () => {
    const d = doc(p('A', t('看'), n.chip!.create({ label: '周报' }), t('再说')))
    const r = findTextInBlock(d.child(0), 0, '看周报再', 0)!
    expect(d.textBetween(r.from, r.to, '', (x) => String(x.attrs.label))).toBe('看周报再')
  })

  test('复制出的锚能原样找回同一处', () => {
    const d = doc(p('A', t('甲乙甲乙甲')))
    const from = posOf(d, '甲乙', 1)
    const a = anchorOfRange(d, from, from + 2)!
    expect(findTextInBlock(d.child(0), 0, a.text, a.n)).toEqual({ from, to: from + 2 })
  })
})
