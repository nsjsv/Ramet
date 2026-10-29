// 排队消息落进文档的形状（queue-message.ts），与前端 appendUserMessage + mention-upgrade 同口径
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { inheritedAttrs, lineInlines, userMessageElement } from './queue-message.js'

/** 行内内容 → 便于比较的形状 */
function shape(items: Array<Y.XmlText | Y.XmlElement>): unknown[] {
  const doc = new Y.Doc()
  const p = doc.getXmlFragment('t')
  const para = new Y.XmlElement('paragraph')
  p.insert(0, [para])
  para.insert(0, items)
  return para.toArray().map((c) => (c instanceof Y.XmlText ? c.toString() : { [(c as Y.XmlElement).nodeName]: (c as Y.XmlElement).getAttributes() }))
}

test('记号升成 chip：agent / 成员 / 页面 / 块引用；名字里带 `]` 也按收口锚切', () => {
  expect(shape(lineInlines('请 @[Codex](agent:c:1:codex) 审一遍，抄送 @[小王](user:u1)'))).toEqual([
    '请 ',
    { agent_mention: { agentId: 'c:1:codex', label: 'Codex' } },
    ' 审一遍，抄送 ',
    { user_mention: { userId: 'u1', name: '小王' } },
  ])
  expect(shape(lineInlines('看 @[[开源]什么？](page:p1) 和 @[那段](page:p1#b2)'))).toEqual([
    '看 ',
    { page_mention: { pageId: 'p1', title: '[开源]什么？' } },
    ' 和 ',
    { block_ref: { pageId: 'p1', blockId: 'b2', text: '那段' } },
  ])
  // 不完整的记号原样留着
  expect(shape(lineInlines('@[半截](agent:x'))).toEqual(['@[半截](agent:x'])
})

test('调用配置沿用上一条：同一来源原样沿用，换了来源不带旧目录 / 配置', () => {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  const prev = new Y.XmlElement('user_message')
  prev.setAttribute('agent', 'claude')
  prev.setAttribute('cwd', '/repo')
  prev.setAttribute('opts', 'model=m2')
  frag.insert(0, [prev])
  expect(inheritedAttrs(frag, 'claude')).toEqual({ agent: 'claude', cwd: '/repo', opts: 'model=m2' })
  expect(inheritedAttrs(frag, '')).toEqual({ agent: 'claude', cwd: '/repo', opts: 'model=m2' })
  expect(inheritedAttrs(frag, 'codex')).toEqual({ agent: 'codex', cwd: '', opts: '' })
  expect(inheritedAttrs(new Y.Doc().getXmlFragment('prosemirror'), 'codex')).toEqual({ agent: 'codex', cwd: '', opts: '' })
})

test('一条用户消息：按行成段（空行也是一段），附件图片成末尾一段；只有图时不留空段', () => {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  frag.insert(0, [
    userMessageElement('第一行\n\n第三行', ['/api/files/a'], { agent: 'claude', cwd: '', opts: '', author: 'u1' }),
    userMessageElement('', ['/api/files/b'], { agent: '', cwd: '', opts: '', author: 'u1' }),
  ])
  const [a, b] = frag.toArray() as Y.XmlElement[]
  expect(a!.getAttribute('author')).toBe('u1')
  expect(typeof a!.getAttribute('id')).toBe('string')
  expect(a!.toArray().map((p) => (p as Y.XmlElement).toArray().length)).toEqual([1, 0, 1, 1])
  expect(((a!.get(3) as Y.XmlElement).get(0) as Y.XmlElement).getAttribute('src')).toBe('/api/files/a')
  expect(b!.toArray()).toHaveLength(1)
})
