import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { initProseMirrorDoc, prosemirrorToYXmlFragment } from 'y-prosemirror'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { doc, p, posOf, schema } from '../editor/test-schema'
import { encodeAnchor, resolveAnchor, type YContext } from './comment-anchor'

/** 一份协同文档：Y 端是真相，PM 文档与 mapping 每次从 Y 现建（等于远端改动后 y-prosemirror 重建的结果） */
function setup(initial: PMNode) {
  const ydoc = new Y.Doc()
  const type = ydoc.getXmlFragment('prosemirror')
  prosemirrorToYXmlFragment(initial, type)
  const view = () => {
    const { doc: pm, mapping } = initProseMirrorDoc(type, schema)
    return { pm, y: { doc: ydoc, type, mapping } satisfies YContext }
  }
  /** 第 i 个顶层块里的文字节点 */
  const text = (i: number): Y.XmlText => (type.get(i) as Y.XmlElement).get(0) as Y.XmlText
  return { ydoc, type, view, text }
}

const textOf = (pm: PMNode, r: { from: number; to: number } | null): string | null => (r ? pm.textBetween(r.from, r.to) : null)

describe('评论锚点', () => {
  test('原样解析回同一段字', () => {
    const s = setup(doc(p('今天讨论预算安排', 'b1'), p('第二段', 'b2')))
    const { pm, y } = s.view()
    const from = posOf(pm, '预算')
    const anchor = encodeAnchor(pm, y, from, from + 2)
    expect(anchor).toMatchObject({ blockId: 'b1', text: '预算', n: 0 })
    expect(textOf(pm, resolveAnchor(pm, y, anchor!))).toBe('预算')
  })

  test('前面插字 / 删字后仍盖住原文字，紧挨末尾打字不把高亮拉长', () => {
    const s = setup(doc(p('今天讨论预算安排', 'b1')))
    const v0 = s.view()
    const from = posOf(v0.pm, '预算')
    const anchor = encodeAnchor(v0.pm, v0.y, from, from + 2)!
    s.text(0).insert(0, '前面加了好多字')
    s.text(0).delete(7, 2) // 删掉原来的「今天」
    const idx = s.text(0).toString().indexOf('预算')
    s.text(0).insert(idx + 2, '紧挨着')
    s.text(0).insert(idx, '贴着前')
    const v1 = s.view()
    expect(textOf(v1.pm, resolveAnchor(v1.pm, v1.y, anchor))).toBe('预算')
  })

  test('删掉区间开头一部分：高亮缩到剩下的字', () => {
    const s = setup(doc(p('今天讨论预算安排', 'b1')))
    const v0 = s.view()
    const from = posOf(v0.pm, '讨论')
    const anchor = encodeAnchor(v0.pm, v0.y, from, from + 4)!
    s.text(0).delete(2, 1) // 「讨」
    const v1 = s.view()
    expect(textOf(v1.pm, resolveAnchor(v1.pm, v1.y, anchor))).toBe('论预算')
  })

  test('整段删除 = 原文已删除', () => {
    const s = setup(doc(p('今天讨论预算安排', 'b1'), p('第二段', 'b2')))
    const v0 = s.view()
    const from = posOf(v0.pm, '预算')
    const anchor = encodeAnchor(v0.pm, v0.y, from, from + 2)!
    s.type.delete(0, 1)
    const v1 = s.view()
    expect(resolveAnchor(v1.pm, v1.y, anchor)).toBeNull()
  })

  test('块里的字被删光后又打了一样的字：相对位置失效，按文字兜底找回', () => {
    const s = setup(doc(p('今天讨论预算安排', 'b1')))
    const v0 = s.view()
    const from = posOf(v0.pm, '预算')
    const anchor = encodeAnchor(v0.pm, v0.y, from, from + 2)!
    const t = s.text(0)
    t.delete(0, t.length)
    t.insert(0, '重写之后还有预算两个字')
    const v1 = s.view()
    expect(textOf(v1.pm, resolveAnchor(v1.pm, v1.y, anchor))).toBe('预算')
  })

  test('整片重建（版本恢复）：相对位置来自旧文档，靠块 id + 文字找回；没有绑定时同样走文字', () => {
    const a = setup(doc(p('今天讨论预算安排', 'b1')))
    const va = a.view()
    const from = posOf(va.pm, '预算')
    const anchor = encodeAnchor(va.pm, va.y, from, from + 2)!
    const b = setup(doc(p('改过的：讨论预算安排', 'b1')))
    const vb = b.view()
    expect(textOf(vb.pm, resolveAnchor(vb.pm, vb.y, anchor))).toBe('预算')
    expect(textOf(vb.pm, resolveAnchor(vb.pm, null, anchor))).toBe('预算')
    const c = setup(doc(p('完全不同', 'b1')))
    const vc = c.view()
    expect(resolveAnchor(vc.pm, vc.y, anchor)).toBeNull()
  })

  test('选区以下一块开头结束（三击选段）：最后一个字取本块末字', () => {
    const s = setup(doc(p('第一段', 'b1'), p('第二段', 'b2')))
    const { pm, y } = s.view()
    const from = posOf(pm, '第一段')
    const anchor = encodeAnchor(pm, y, from, posOf(pm, '第二段'))!
    expect(anchor.text).toBe('第一段')
    expect(textOf(pm, resolveAnchor(pm, y, anchor))).toBe('第一段')
  })

  test('没有块 id / 没有绑定 / 全是空白：不出锚点', () => {
    const s = setup(doc(p('没有 id 的段落'), p('  ', 'b2')))
    const { pm, y } = s.view()
    expect(encodeAnchor(pm, y, 1, 3)).toBeNull()
    const blank = posOf(pm, '  ')
    expect(encodeAnchor(pm, y, blank, blank + 2)).toBeNull()
    const s2 = setup(doc(p('有 id', 'b1')))
    const v2 = s2.view()
    expect(encodeAnchor(v2.pm, null, 1, 3)).toBeNull()
  })
})
