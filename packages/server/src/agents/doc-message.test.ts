/* ---------- 增量轮发给 agent 的那条消息（lastUserMessage）：整条多段消息，不是最后一行 ---------- */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { lastUserMessage, serializeDoc, stripLastUserMessage } from './doc.js'

function block(name: string, ...children: Y.XmlElement[]): Y.XmlElement {
  const el = new Y.XmlElement(name)
  el.insert(0, children)
  return el
}

function para(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph')
  el.insert(0, [new Y.XmlText(text)])
  return el
}

function build(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const frag = new Y.Doc().getXmlFragment('prosemirror')
  frag.insert(0, blocks)
  return frag
}

test('多段用户消息整条取出；消息里的引用保留一层 >', () => {
  const doc = serializeDoc(
    build(
      block('user_message', para('第一问')),
      block('agent_reply', para('第一答')),
      block('user_message', para('看看这个'), para('第二段'), block('blockquote', para('引文'))),
    ),
  )
  expect(lastUserMessage(doc)).toBe('看看这个\n\n第二段\n\n> 引文')
  // 与 hash 基线同一个边界：基线 + 这条消息 = 整个视图
  expect(stripLastUserMessage(doc)).toBe('>> 第一问\n\n> 第一答')
})

test('只有一条消息 / 没有消息', () => {
  expect(lastUserMessage(serializeDoc(build(block('user_message', para('a'), para('b')))))).toBe('a\n\nb')
  expect(lastUserMessage(serializeDoc(build(para('正文'))))).toBeNull()
})
