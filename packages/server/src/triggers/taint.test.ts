/* ---------- taintedSince：主人上次亲自发言之后有没有读到外来事件（纯函数） ---------- */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { taintedSince } from './taint.js'

const OWNER = 'u-alice'

type Block = { name?: string; attrs?: Record<string, string>; text: string }

function page(...blocks: Block[]): Y.XmlFragment {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  frag.insert(
    0,
    blocks.map((b) => {
      const el = new Y.XmlElement(b.name ?? 'user_message')
      for (const [k, v] of Object.entries(b.attrs ?? {})) el.setAttribute(k, v)
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, b.text)
      p.insert(0, [t])
      el.insert(0, [p])
      return el
    }),
  )
  return frag
}

const external: Block = { attrs: { notice: 'event', external: '1', rule: 'r1', author: '' }, text: '规则「评论找我」· bob 在《周报》的评论' }

describe('taintedSince', () => {
  it('外来事件之后：返回它的抬头；主人亲自说一句就解除', () => {
    expect(taintedSince(page({ attrs: { author: OWNER }, text: '你好' }, external), OWNER)).toBe(external.text)
    expect(taintedSince(page(external, { name: 'agent_reply', text: '看到了' }), OWNER)).toBe(external.text)
    expect(taintedSince(page(external, { attrs: { author: OWNER }, text: '好的' }), OWNER)).toBeNull()
    // 老消息没有作者：Genet 页是个人页，算主人的
    expect(taintedSince(page(external, { attrs: { author: '' }, text: '好的' }), OWNER)).toBeNull()
  })

  it('不算主人亲自说的：规则 / 定时器以主人身份写的指令、任务通知、定时提醒、别人写的消息', () => {
    const later: Block[] = [
      { attrs: { author: OWNER, rule: 'r2' }, text: '规则写的指令' },
      { attrs: { author: OWNER, timer: 't1' }, text: '定时器写的指令' },
      { attrs: { author: '', notice: 'done', task: 'p1' }, text: '任务做完了' },
      { attrs: { author: '', notice: 'timer', timer: 't1' }, text: '定时「喝水」' },
      { attrs: { author: 'u-bob' }, text: '我是 bob' },
    ]
    for (const after of later) {
      expect(taintedSince(page(external, after), OWNER)).toBe(external.text)
    }
  })

  it('评论呼叫：串里有别人的评论（external）算外来，只有主人自己的不算；通知本身不算主人亲自说话', () => {
    const call: Block = { attrs: { notice: 'comment', external: '1', author: '' }, text: '你在《周报》的评论里叫了 Genet' }
    expect(taintedSince(page(call), OWNER)).toBe(call.text)
    expect(taintedSince(page({ attrs: { notice: 'comment', author: '' }, text: '你在《周报》的评论里叫了 Genet' }), OWNER)).toBeNull()
    expect(taintedSince(page(external, { attrs: { notice: 'comment', author: '' }, text: '你在《周报》的评论里叫了 Genet' }), OWNER)).toBe(external.text)
  })

  it('主人自己触发的事件（没有 external）不算外来', () => {
    expect(taintedSince(page({ attrs: { notice: 'event', rule: 'r1', author: '' }, text: '规则「x」· alice 的评论' }), OWNER)).toBeNull()
    expect(taintedSince(page(), OWNER)).toBeNull()
  })
})
