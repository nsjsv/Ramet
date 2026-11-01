/* ---------- 一页一种工具的判定（纯函数）：锁定的工具 = 第一块顶层回复的 agent 属性对应的工具名 ---------- */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { lockedTool, mentionedReply } from './doc.js'
import { fitsLock } from './manager-types.js'

function el(name: string, attrs: Record<string, string> = {}): Y.XmlElement {
  const node = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.insert(0, [new Y.XmlElement('paragraph')])
  return node
}

function build(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const frag = new Y.Doc().getXmlFragment('prosemirror')
  frag.insert(0, blocks)
  return frag
}

test('没有回复不锁', () => {
  expect(lockedTool(build())).toBe('')
  expect(lockedTool(build(el('paragraph'), el('user_message')))).toBe('')
})

test('按第一块回复的工具锁：本机 id 与 connector 上的同一工具同名；混用过的老页面看第一块', () => {
  expect(lockedTool(build(el('user_message'), el('agent_reply', { agent: 'c:conn-1:codex' }), el('agent_reply', { agent: 'claude' })))).toBe('codex')
  expect(lockedTool(build(el('agent_reply', { agent: 'claude' }), el('agent_reply', { agent: 'c:conn-2:codex' })))).toBe('claude')
})

test('第一块回复没有 agent 属性：不锁（不拿后面的回复顶上）', () => {
  expect(lockedTool(build(el('agent_reply'), el('agent_reply', { agent: 'claude' })))).toBe('')
})

test('fitsLock：没锁都行；锁了只认同一个工具（哪台机器都行）', () => {
  expect(fitsLock('', 'codex')).toBe(true)
  expect(fitsLock('claude', 'claude')).toBe(true)
  expect(fitsLock('claude', 'c:conn-1:claude')).toBe(true)
  expect(fitsLock('claude', 'c:conn-1:codex')).toBe(false)
  expect(fitsLock('claude', 'codex')).toBe(false)
})

test('mentionedReply：往前最近一条用户消息 @ 了这块回复自己的 agent 才算', () => {
  const mention = (agentId: string): Y.XmlElement => {
    const m = new Y.XmlElement('agent_mention')
    m.setAttribute('agentId', agentId)
    return m
  }
  const msg = (...mentions: string[]): Y.XmlElement => {
    const node = new Y.XmlElement('user_message')
    const p = new Y.XmlElement('paragraph')
    p.insert(0, mentions.map(mention))
    node.insert(0, [p])
    return node
  }
  const frag = build(
    msg(),
    el('agent_reply', { id: 'r1', agent: 'claude' }),
    msg('codex', 'c:conn-1:pi'),
    el('agent_reply', { id: 'r2', agent: 'codex' }),
    el('agent_reply', { id: 'r3', agent: 'c:conn-1:pi' }),
    msg(),
    el('agent_reply', { id: 'r4', agent: 'codex' }),
  )
  expect(mentionedReply(frag, 'r1')).toBe(false)
  expect(mentionedReply(frag, 'r2')).toBe(true)
  expect(mentionedReply(frag, 'r3')).toBe(true) // 链的第二家
  expect(mentionedReply(frag, 'r4')).toBe(false) // 前一条消息没 @ 它：混用老页面里后来换了工具
  expect(mentionedReply(frag, 'missing')).toBe(false)
})
