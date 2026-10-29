import { describe, expect, test } from 'vitest'
import type { ViewMutationRecord } from '@milkdown/kit/prose/view'
import { shellMutationFilter } from './shell-mutation'

// 只忽略外壳自己造成的变动；contentDOM 被浏览器删掉 / 文字落到 contentDOM 外面都必须交给 PM（返回 false），
// 否则模型和画面分叉。vitest 没有 DOM，用只实现 contains 的假节点搭出 nodeView 的树。

class FakeNode {
  parent: FakeNode | null = null
  constructor(readonly name: string) {}
  append(...children: FakeNode[]): this {
    for (const child of children) child.parent = this
    return this
  }
  contains(other: FakeNode | null): boolean {
    for (let cur = other; cur; cur = cur.parent) if (cur === this) return true
    return false
  }
}

const asNode = (n: FakeNode): Node => n as unknown as Node

function codeBlockTree() {
  const dom = new FakeNode('div.code-block')
  const head = new FakeNode('div.code-head')
  const langBtn = new FakeNode('button.code-lang')
  const pre = new FakeNode('pre.code-src')
  const code = new FakeNode('code')
  const text = new FakeNode('#text')
  const span = new FakeNode('span.hljs')
  const diagram = new FakeNode('div.mermaid-view')
  head.append(langBtn)
  code.append(text, span)
  pre.append(code)
  dom.append(head, pre, diagram)
  const ignore = shellMutationFilter(asNode(dom), asNode(code), [asNode(head), asNode(diagram)])
  return { dom, head, langBtn, pre, code, text, span, diagram, ignore }
}

function childList(target: FakeNode, added: FakeNode[], removed: FakeNode[] = []): ViewMutationRecord {
  return { type: 'childList', target, addedNodes: added, removedNodes: removed } as unknown as ViewMutationRecord
}
const attributes = (target: FakeNode): ViewMutationRecord => ({ type: 'attributes', target }) as unknown as ViewMutationRecord
const characterData = (target: FakeNode): ViewMutationRecord => ({ type: 'characterData', target }) as unknown as ViewMutationRecord

describe('shellMutationFilter：交给 PM 的变动', () => {
  test('Firefox 删掉最后一个字时把变空的 <code>（contentDOM）一起删掉：不忽略，PM 才会整块重读重画', () => {
    const t = codeBlockTree()
    expect(t.ignore(childList(t.pre, [], [t.code]))).toBe(false)
  })

  test('文字 / <br> 落到 pre 里、code 外面：不忽略', () => {
    const t = codeBlockTree()
    const stray = new FakeNode('#text')
    expect(t.ignore(childList(t.pre, [stray]))).toBe(false)
  })

  test('contentDOM 里的打字、增删节点：不忽略', () => {
    const t = codeBlockTree()
    expect(t.ignore(characterData(t.text))).toBe(false)
    expect(t.ignore(childList(t.code, [], [t.text]))).toBe(false)
    expect(t.ignore(attributes(t.span))).toBe(false)
  })

  test('dom 上的 pre 被删 / 换：不忽略', () => {
    const t = codeBlockTree()
    expect(t.ignore(childList(t.dom, [], [t.pre]))).toBe(false)
    expect(t.ignore(childList(t.dom, [t.diagram], [t.pre]))).toBe(false)
  })

  test('选区变动：不忽略', () => {
    const t = codeBlockTree()
    expect(t.ignore({ type: 'selection', target: asNode(t.text) })).toBe(false)
  })
})

describe('shellMutationFilter：外壳自己的变动照旧忽略', () => {
  test('顶栏 / mermaid 图里的任何变动', () => {
    const t = codeBlockTree()
    expect(t.ignore(characterData(t.langBtn))).toBe(true)
    expect(t.ignore(attributes(t.langBtn))).toBe(true)
    expect(t.ignore(childList(t.diagram, [new FakeNode('svg')]))).toBe(true)
  })

  test('dom / pre / code 自身的属性（class、data-language）', () => {
    const t = codeBlockTree()
    expect(t.ignore(attributes(t.dom))).toBe(true)
    expect(t.ignore(attributes(t.pre))).toBe(true)
    expect(t.ignore(attributes(t.code))).toBe(true)
  })

  test('dom 上挂上 / 摘下 mermaid 图', () => {
    const t = codeBlockTree()
    expect(t.ignore(childList(t.dom, [t.diagram]))).toBe(true)
    expect(t.ignore(childList(t.dom, [], [t.diagram]))).toBe(true)
  })
})
