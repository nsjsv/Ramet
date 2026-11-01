/* ---------- 续跑的纯函数：能不能续（resumeTarget）、接上旧档案（RunRecord.resumeFrom）、续跑说明（不起服务）---------- */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { applyRunEvent, type RunEvent } from '@ramet/shared/run-model'
import { encodeStats } from '@ramet/shared/reply-stats'
import { resumeTarget } from './doc.js'
import { RunRecord, type RunRecordV1 } from './run-record.js'
import { RESUME_TAG, resumeNote } from './resume-turn.js'

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

const reply = (id: string, o: string, extra: Record<string, string> = {}) =>
  el('agent_reply', { id, agent: 'fake', stats: encodeStats({ o: o as 'end' }), ...extra })

test('resumeTarget：最后一块、失败或停止的回复能续；带上回复下标、中断方式与过程页 id', () => {
  const frag = build(el('user_message'), reply('r1', 'error', { run: 'run-1' }), el('paragraph'))
  const t = resumeTarget(frag, 'r1')
  expect(t).toMatchObject({ ok: true, index: 1, agent: 'fake', outcome: 'error', run: 'run-1' })
  expect(resumeTarget(build(el('user_message'), reply('r1', 'cancelled')), 'r1')).toMatchObject({ ok: true, outcome: 'cancelled', run: '' })
})

test('resumeTarget：后面还有消息 / 回复、没有失败或停止、带队、找不到、前面没有用户消息都不能续', () => {
  expect(resumeTarget(build(el('user_message'), reply('r1', 'error'), el('user_message')), 'r1')).toEqual({ ok: false, reason: 'not-last' })
  expect(resumeTarget(build(el('user_message'), reply('r1', 'error'), reply('r2', 'end')), 'r1')).toEqual({ ok: false, reason: 'not-last' })
  expect(resumeTarget(build(el('user_message'), reply('r1', 'end')), 'r1')).toEqual({ ok: false, reason: 'not-interrupted' })
  expect(resumeTarget(build(el('user_message'), reply('r1', 'run')), 'r1')).toEqual({ ok: false, reason: 'not-interrupted' })
  expect(resumeTarget(build(el('user_message'), reply('r1', 'error', { team: '{}' })), 'r1')).toEqual({ ok: false, reason: 'team' })
  expect(resumeTarget(build(el('user_message')), 'nope')).toEqual({ ok: false, reason: 'no-reply' })
  expect(resumeTarget(build(reply('r1', 'error')), 'r1')).toEqual({ ok: false, reason: 'no-message' })
})

const archived: RunRecordV1 = {
  v: 1,
  agent: 'fake',
  parentId: 'p',
  replyId: 'r1',
  startedAt: 0,
  ms: 5000,
  outcome: 'error',
  usage: { total: 10, input: 6, output: 4, cacheRead: 2 },
  output: '写到一半',
  entries: [
    { k: 'thought', t: 0, end: 100, text: '想想' },
    { k: 'tool', id: 't1', kind: 'read', title: '读', status: 'completed', t: 200, end: 300 },
  ],
  sessionId: 's1',
  cwd: '/w',
  error: '断了',
}

test('resumeFrom：旧条目接过来，续跑后第一段正文到来时半截正文收成说明（接在旧条目之后），新步骤在它后面', () => {
  const events: RunEvent[] = []
  const rec = RunRecord.resumeFrom('r1', archived, Date.now() - 5000, (ev) => events.push(ev))
  expect(rec.base).toBe(2)
  expect(rec.state.text).toBe('写到一半')
  expect(rec.state.thoughtChars).toBe(2)
  // 中途订阅者拿到的快照 + 之后的事件 = 服务端终态
  const mirror = structuredClone(rec.state)
  rec.tool({ type: 'tool', id: 't2', kind: 'read', title: '确认', status: 'completed' })
  rec.text('接着做完了')
  const ms = rec.close()
  for (const ev of events) applyRunEvent(mirror, ev)
  expect(mirror).toEqual(rec.state)
  expect(rec.state.text).toBe('接着做完了')
  expect(rec.state.entries.map((e) => (e.k === 'tool' ? e.id : e.k))).toEqual(['thought', 't1', 'say', 't2'])
  expect(rec.state.entries[2]).toMatchObject({ k: 'say', text: '写到一半', t: 5000 })
  expect(ms).toBeGreaterThanOrEqual(5000)
  // 用量与中断前那段相加
  const record = rec.record({ agent: 'fake', parentId: 'p' }, 'end', ms, { total: 5, input: 3, output: 2, thought: 1 })
  expect(record.usage).toEqual({ total: 15, input: 9, output: 6, cacheRead: 2, thought: 1 })
  expect(record.output).toBe('接着做完了')
  expect(record.sessionId).toBeUndefined()
})

test('resumeFrom：续跑后只吐空白不换段（空白丢掉）；没说别的就收尾，半截正文仍是正文', () => {
  const rec = RunRecord.resumeFrom('r1', archived, Date.now(), () => undefined)
  rec.text('\n')
  rec.close()
  expect(rec.state.text).toBe('写到一半')
  expect(rec.state.entries.some((e) => e.k === 'say')).toBe(false)
})

test('续跑说明：带前缀；失败的转述原因，停止的说明是用户停的', () => {
  expect(resumeNote('error', '连接断开')).toContain(`${RESUME_TAG} 上一次执行中途断开了（连接断开）`)
  expect(resumeNote('error')).toContain('原因不明')
  expect(resumeNote('cancelled').startsWith(`${RESUME_TAG} 用户刚才手动停止了这一轮`)).toBe(true)
})
