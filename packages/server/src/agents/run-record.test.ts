/* ---------- run 模型的不变量（纯函数 + RunRecord，不起服务） ----------
 * 换段规则、合批保序、快照 + 后续事件 = 终态、上限、stats 缺省不补 0、老过程页解析。 */
import { expect, test } from 'vitest'
import {
  applyRunEvent,
  decodePlan,
  encodePlan,
  emptyRun,
  MAX_PLAN_ENTRIES,
  MAX_PLAN_TEXT,
  MAX_RUN_STEPS,
  MAX_THOUGHT_TOTAL,
  normalizePlan,
  type PlanEntry,
  type RunEvent,
  type RunState,
} from '@ramet/shared/run-model'
import { decodeStats } from '@ramet/shared/reply-stats'
import { RunRecord } from './run-record.js'
import { createRunState } from './run-state.js'
import { projectAgentEvent } from './remote-run.js'

function recorder(): { rec: RunRecord; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { rec: new RunRecord('reply-1', Date.now(), (ev) => events.push(ev)), events }
}

const tool = (id: string, status: 'pending' | 'completed' | 'failed' = 'completed') =>
  ({ type: 'tool', id, kind: 'read', title: id, status }) as const

test('换段:说一句 → 工具 → 新的一段 ⇒ 旧的一段收成说明,插在工具之前;当前只剩新的一段', () => {
  const { rec, events } = recorder()
  rec.text('我先看看')
  rec.tool(tool('t1'))
  rec.text('结论')
  rec.close()
  expect(rec.state.text).toBe('结论')
  expect(rec.state.entries.map((e) => e.k)).toEqual(['say', 'tool'])
  expect(rec.state.entries[0]).toMatchObject({ k: 'say', text: '我先看看' })
  const kinds = events.map((e) => e.type)
  expect(kinds.indexOf('said')).toBeGreaterThan(kinds.indexOf('step'))
  expect(kinds.lastIndexOf('reply')).toBeGreaterThan(kinds.indexOf('said'))
})

test('子代理正文不进父回复，贴到唤起它的那一步；后到的快照替换这行', () => {
  const { rec } = recorder()
  rec.text('父回复')
  rec.text('先读文件', 'task-1')
  rec.tool({ type: 'tool', id: 'task-1', kind: 'think', title: '查主机名', status: 'in_progress' })
  expect(rec.state.text).toBe('父回复')
  expect(rec.state.entries.find((e) => e.k === 'tool' && e.id === 'task-1')).toMatchObject({ activity: '先读文件' })
  rec.tool({ type: 'tool', id: 'task-1', activity: 'read · hostname', status: 'in_progress' })
  expect(rec.state.entries.find((e) => e.k === 'tool' && e.id === 'task-1')).toMatchObject({
    activity: 'read · hostname',
    title: '查主机名',
  })
  rec.tool({ type: 'tool', id: 'child-1', parentId: 'task-1', kind: 'read', title: 'hostname', status: 'in_progress' })
  expect(rec.state.text).toBe('父回复')
  expect(rec.state.entries.filter((e) => e.k === 'tool')).toHaveLength(2)
})

test('换段:工具后只吐空白不换段;思考也算两段之间的间隔', () => {
  const a = recorder()
  a.rec.text('唯一的一段')
  a.rec.tool(tool('t1'))
  a.rec.text('\n\n')
  a.rec.close()
  expect(a.rec.state.text).toBe('唯一的一段')
  expect(a.events.some((e) => e.type === 'said')).toBe(false)

  const b = recorder()
  b.rec.text('甲')
  b.rec.thought('想一下')
  b.rec.text('乙')
  b.rec.close()
  expect(b.rec.state.entries.map((e) => e.k)).toEqual(['say', 'thought'])
  expect(b.rec.state.text).toBe('乙')
  // 思考被后面的正文结束
  expect(b.rec.state.entries[1]).toMatchObject({ k: 'thought', text: '想一下' })
  expect(b.rec.state.entries[1]!.end).toBeTypeOf('number')
})

test('合批:100ms 内的多个 chunk 合成一条;类型切换先冲刷,顺序与发生顺序一致', () => {
  const { rec, events } = recorder()
  for (const piece of ['一', '二', '三']) rec.text(piece)
  rec.thought('想')
  rec.thought('法')
  rec.flush()
  expect(events).toEqual([
    expect.objectContaining({ type: 'reply', d: '一二三' }),
    expect.objectContaining({ type: 'think', d: '想法' }),
  ])
})

test('快照:中途订阅拿到的快照 + 之后的事件 = 服务端终态(合批缓冲里的字不会重复)', () => {
  const { rec, events } = recorder()
  rec.thought('先想')
  rec.text('第一段')
  rec.tool(tool('t1', 'pending'))
  rec.text('第二段开头')
  const snap = rec.snapshot()
  const seen = events.length
  rec.text('……结尾')
  rec.tool(tool('t1', 'completed'))
  rec.text('第三段')
  rec.close()
  if (snap.type !== 'run') throw new Error('快照类型不对')
  const client: RunState = snap.state
  for (const ev of events.slice(seen)) {
    if (ev.type === 'reply' || ev.type === 'think' || ev.type === 'said' || ev.type === 'step') applyRunEvent(client, ev)
  }
  expect(client.text).toBe(rec.state.text)
  expect(client.entries.map((e) => [e.k, e.k === 'tool' ? e.status : e.text])).toEqual(
    rec.state.entries.map((e) => [e.k, e.k === 'tool' ? e.status : e.text]),
  )
})

test('上限:整轮思考超过上限后不再记录也不再推送,但如实标一次截断', () => {
  const { rec, events } = recorder()
  const big = 'x'.repeat(20_000)
  for (let i = 0; i < 20; i++) {
    rec.thought(big)
    rec.tool(tool(`t${i}`)) // 每次都开一条新思考
  }
  rec.thought('再想也不接') // 到顶后被丢弃的增量
  rec.close()
  expect(rec.state.thoughtChars).toBeLessThanOrEqual(MAX_THOUGHT_TOTAL)
  const pushed = events.filter((e) => e.type === 'think').reduce((n, e) => n + (e.type === 'think' ? e.d.length : 0), 0)
  expect(pushed).toBeLessThanOrEqual(MAX_THOUGHT_TOTAL)
  // 丢弃的思考不再无限推流,但状态/归档里如实标截断,且只标一次
  expect(rec.state.info?.truncated).toBe(true)
  expect(events.filter((e) => e.type === 'info')).toHaveLength(1)
})

test('stats:没报用量就没有 token 项(不写 0);报了就全带上', () => {
  const { rec } = recorder()
  rec.tool(tool('t1'))
  const bare = decodeStats(rec.stats('cancelled', 1200, undefined))
  expect(bare).toEqual({ o: 'cancelled', ms: 1200, st: 1 })
  const full = decodeStats(rec.stats('end', 900, { total: 1500, input: 1000, output: 200, cacheRead: 300 }))
  expect(full).toMatchObject({ o: 'end', tk: 1500, in: 1000, out: 200, cr: 300 })
  expect('cw' in full).toBe(false)
})

test('审批请求里的工具数据并入同一个工具步骤(有 toolCallId 就用它),不另起一步', () => {
  const { rec } = recorder()
  // 先有真正的工具调用步骤
  rec.tool({ type: 'tool', id: 'tc-1', kind: 'edit', title: '写文件', status: 'pending' })
  // 审批请求带同一个 toolCallId:必须并入 tc-1,而不是按 requestId 另起一步
  rec.permission({
    type: 'permission',
    requestId: 'perm-9',
    title: '写文件',
    options: [{ optionId: 'allow_once', name: '允许' }],
    toolCall: { toolCallId: 'tc-1', kind: 'edit', title: '写文件' },
  })
  const tools = rec.state.entries.filter((e) => e.k === 'tool')
  expect(tools).toHaveLength(1)
  expect(tools[0]!.id).toBe('tc-1')
  expect(tools[0]!.acp).toMatchObject({ permission: { options: [{ optionId: 'allow_once' }] } })
  expect(tools[0]!.status).toBe('pending') // 不臆造完成
})

test('审批没有 toolCallId（fs 写闸门之类）:退化到 requestId 成一步;没有 toolCall 的审批不进过程', () => {
  const { rec } = recorder()
  rec.permission({
    type: 'permission',
    requestId: 'perm-3',
    title: '写入文件 /tmp/a',
    options: [{ optionId: 'allow', name: '允许' }],
    toolCall: { title: '写入文件 /tmp/a' },
  })
  rec.permission({ type: 'permission', requestId: 'perm-4', title: '别的', options: [] })
  expect(rec.state.entries.filter((e) => e.k === 'tool').map((e) => e.id)).toEqual(['perm-3'])
})

test('轮次投影不碰会话级事件:命令 / 配置 / 审批不折进 RunRecord，也不占 seq', () => {
  const run = createRunState({ pageId: 'p1', userId: 'u1', adapterKey: 'fake', remote: null })
  const { rec, events } = recorder()
  projectAgentEvent(run, rec, { type: 'commands', list: [{ name: 'x' }], sessionId: 's1' }, undefined, 's1')
  projectAgentEvent(run, rec, { type: 'config', options: [], sessionId: 's1' }, undefined, 's1')
  projectAgentEvent(run, rec, { type: 'permission', requestId: 'perm-0', title: 't', options: [], sessionId: 's1' }, undefined, 's1')
  projectAgentEvent(run, rec, { type: 'permission_resolved', requestId: 'perm-0', sessionId: 's1' }, undefined, 's1')
  expect(run.lastSeq).toBe(-1)
  rec.close()
  expect(events).toEqual([])
  // 轮次事件照常：同一会话的文字占号，别的会话的丢掉
  projectAgentEvent(run, rec, { type: 'text', delta: 'hi', sessionId: 's1' }, 4, 's1')
  projectAgentEvent(run, rec, { type: 'text', delta: '串台', sessionId: 's2' }, 5, 's1')
  expect(run.lastSeq).toBe(4)
  rec.close()
  expect(rec.state.text).toBe('hi')
})

test('子代理增量合批:相邻同类合成一条;换 kind/换步骤才冲刷,且顺序不乱', () => {
  const { rec, events } = recorder()
  rec.tool(tool('t1'))
  rec.text('子一', 't1')
  rec.text('子二', 't1')
  rec.thought('思一', 't1')
  rec.text('子三', 't1')
  rec.flush()
  // 两次 output 合成一条 child;类型切换(think)冲刷;再切回 output 又冲刷
  expect(events.filter((e) => e.type === 'child')).toEqual([
    expect.objectContaining({ id: 't1', kind: 'output', d: '子一子二' }),
    expect.objectContaining({ id: 't1', kind: 'thought', d: '思一' }),
    expect.objectContaining({ id: 't1', kind: 'output', d: '子三' }),
  ])
  const entry = rec.state.entries.find((e) => e.k === 'tool' && e.id === 't1')
  expect(entry?.k === 'tool' && entry.output).toBe('子一子二子三')
})

test('子代理正文先于工具到达:攒着,步骤出现时随该步带出;父工具始终没到则收尾落一步', () => {
  const a = recorder()
  a.rec.text('子先到', 't9')
  a.rec.tool(tool('t9'))
  a.rec.flush()
  const step = a.events.find((e) => e.type === 'step' && e.step.id === 't9')
  expect(step?.type === 'step' && step.step.output).toBe('子先到')

  const b = recorder()
  b.rec.text('孤儿子正文', 'never')
  b.rec.close()
  const orphan = b.rec.state.entries.find((e) => e.k === 'tool' && e.id === 'never')
  expect(orphan?.k === 'tool' && orphan.output).toBe('孤儿子正文')
})

test('上限:步数超限后不再新增条目,同样如实标记一次截断', () => {
  const capped = recorder()
  for (let i = 0; i < 260; i++) capped.rec.tool(tool(`c${i}`))
  expect(capped.rec.state.entries.filter((e) => e.k === 'tool').length).toBe(MAX_RUN_STEPS)
  expect(capped.rec.state.info?.truncated).toBe(true)
})

// agent 的计划清单（ACP plan）：整份替换的当前值，不是时间线条目

const planOf = (...items: Array<[string, PlanEntry['status']]>): PlanEntry[] =>
  items.map(([content, status]) => ({ content, status }))

test('plan:整份替换;同一份清单再报一遍不重发;不占步骤、不换段', () => {
  const { rec, events } = recorder()
  rec.text('先列个计划')
  rec.plan(planOf(['读代码', 'in_progress'], ['写测试', 'pending']))
  rec.plan(planOf(['读代码', 'completed'], ['写测试', 'in_progress']))
  rec.plan(planOf(['读代码', 'completed'], ['写测试', 'in_progress'])) // 原样再报:不发
  rec.text('，开始。')
  rec.close()
  expect(events.filter((e) => e.type === 'plan')).toHaveLength(2)
  expect(rec.state.plan).toEqual(planOf(['读代码', 'completed'], ['写测试', 'in_progress']))
  // 计划不是工具步骤:不进条目、不触发换段,前后两句话还是同一段
  expect(rec.state.entries).toHaveLength(0)
  expect(rec.state.text).toBe('先列个计划，开始。')
  expect(rec.hasPlan()).toBe(true)
  expect(rec.record({ agent: 'a', parentId: 'p' }, 'end', 1, undefined).plan).toEqual(rec.state.plan)
})

test('plan:agent 清空清单 = 空数组(替换),不是缺省;从没报过的回合没有 plan', () => {
  const { rec, events } = recorder()
  rec.plan([]) // 还没有计划时报空清单:什么都没变,不发
  expect(events).toHaveLength(0)
  expect(rec.state.plan).toBeUndefined()
  rec.plan(planOf(['一件事', 'pending']))
  rec.plan([])
  expect(rec.state.plan).toEqual([])
  expect(rec.hasPlan()).toBe(false)
  expect(rec.record({ agent: 'a', parentId: 'p' }, 'end', 1, undefined)).not.toHaveProperty('plan')
})

test('plan:快照 + 后续事件 = 终态(前端 store 用同一个 reducer)', () => {
  const { rec, events } = recorder()
  rec.plan(planOf(['甲', 'pending']))
  const snapshot = structuredClone(rec.state)
  rec.plan(planOf(['甲', 'completed'], ['乙', 'in_progress']))
  rec.close()
  const rebuilt: RunState = snapshot
  for (const ev of events.slice(1)) applyRunEvent(rebuilt, ev)
  expect(rebuilt.plan).toEqual(rec.state.plan)
  // 订阅前没有 plan 事件的快照不带这个字段
  expect(emptyRun()).not.toHaveProperty('plan')
})

test('plan:经轮次投影进 RunRecord;别的会话的 plan 不串', () => {
  const run = createRunState({ pageId: 'p', userId: 'u', adapterKey: 'a', remote: null })
  const { rec } = recorder()
  projectAgentEvent(run, rec, { type: 'plan', entries: planOf(['我的', 'pending']), sessionId: 's1' }, undefined, 's1')
  projectAgentEvent(run, rec, { type: 'plan', entries: planOf(['别人的', 'pending']), sessionId: 's2' }, undefined, 's1')
  expect(rec.state.plan).toEqual(planOf(['我的', 'pending']))
})

test('normalizePlan:对端给什么形状都归一;条数 / 字数超限如实标 truncated', () => {
  expect(normalizePlan(undefined)).toEqual({ entries: [], truncated: false })
  const odd = normalizePlan([
    { content: '  有空格  ', status: 'bogus', priority: 'urgent' }, // 未知 status 落 pending、未知 priority 丢掉
    { content: '', status: 'completed' }, // 空内容跳过
    'not an object',
    { content: '完整', status: 'completed', priority: 'low' },
  ])
  expect(odd.entries).toEqual([
    { content: '有空格', status: 'pending' },
    { content: '完整', status: 'completed', priority: 'low' },
  ])
  expect(odd.truncated).toBe(false)

  const many = normalizePlan(Array.from({ length: MAX_PLAN_ENTRIES + 5 }, (_, i) => ({ content: `步骤${i}`, status: 'pending' })))
  expect(many.entries).toHaveLength(MAX_PLAN_ENTRIES)
  expect(many.truncated).toBe(true)
  const long = normalizePlan([{ content: 'x'.repeat(MAX_PLAN_TEXT + 10), status: 'pending' }])
  expect(long.entries[0]!.content).toHaveLength(MAX_PLAN_TEXT)
  expect(long.truncated).toBe(true)

  // 超限的标记走 reducer 进 state.truncated(归档时带进 info)
  const state = emptyRun()
  applyRunEvent(state, { type: 'plan', entries: long.entries, truncated: true, t: 0 })
  expect(state.truncated).toBe(true)
})

test('回复块 plan 属性:编码 / 解码往返;空计划不留属性;坏串当没有', () => {
  const plan: PlanEntry[] = [{ content: '读', status: 'completed', priority: 'high' }, { content: '写', status: 'pending' }]
  expect(decodePlan(encodePlan(plan))).toEqual(plan)
  expect(encodePlan([])).toBe('')
  expect(encodePlan(undefined)).toBe('')
  expect(decodePlan('')).toEqual([])
  expect(decodePlan('not json')).toEqual([])
  expect(decodePlan(42)).toEqual([])
})
