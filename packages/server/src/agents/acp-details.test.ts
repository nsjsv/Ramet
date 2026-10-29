/* ---------- ACP 详情：真实适配器 → 投影 → RunRecord / 共享 reducer ----------
 * 真子进程跑 fake-agent.mjs 的「详情验收」分支（全是 ACP v1 合法负载），经真 AcpAgent 解析成 AgentEvent，
 * 再走 live 路径共用的 projectAgentEvent 折进 RunRecord；RunRecord 发出的 RunEvent 喂给共享 applyRunEvent，
 * 断言「快照 + 后续事件 = 终态」。不 mock 适配器。 */
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { applyRunEvent, mergeStep, type RunEvent, type RunState, type ToolEntry } from '@ramet/shared/run-model'
import { AcpAgent } from './acp.js'
import { RunRecord } from './run-record.js'
import { projectAgentEvent } from './remote-run.js'
import { createRunState } from './run-state.js'
import type { AgentEvent, PromptResult } from './types.js'

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const DETAIL_PROMPT = '详情验收'

type Folded = {
  record: RunRecord
  events: RunEvent[]
  result: PromptResult
}

/** 真子进程 → 真适配器 → 共用投影 → RunRecord。events = RunRecord 发出的成品 RunEvent。 */
async function foldDetailPrompt(prompt = DETAIL_PROMPT): Promise<Folded> {
  const agent = new AcpAgent({ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] })
  const { sessionId } = await agent.newSession(process.cwd())
  const seen: AgentEvent[] = []
  const off = agent.on((ev) => seen.push(ev))
  const result = await agent.prompt(sessionId, [{ type: 'text', text: prompt }])
  off()
  agent.kill()

  const run = createRunState({ pageId: 'p1', userId: 'u1', adapterKey: 'fake', remote: null })
  const events: RunEvent[] = []
  const record = new RunRecord('reply-1', run.startedAt, (ev) => events.push(ev))
  run.record = record
  for (const ev of seen) projectAgentEvent(run, record, ev, undefined, sessionId)
  record.close()
  return { record, events, result }
}

const toolEntry = (rec: RunRecord, id: string) =>
  rec.state.entries.find((e): e is ToolEntry => e.k === 'tool' && e.id === id)

test('详情验收:工具原始字段/增量合并/子代理归属/ACP 元数据/真实用量,一处都不丢', async () => {
  const { record, result } = await foldDetailPrompt()
  const state = record.state

  // 完整思考 + 中间正文被顶成说明条目;最终回复独立
  const thought = state.entries.find((e) => e.k === 'thought')
  expect(thought?.k === 'thought' && thought.text).toContain('ReplyWriter 怎么落块')
  expect(state.entries.some((e) => e.k === 'say' && e.text.includes('我先看代码结构。'))).toBe(true)
  expect(state.text).toContain('## 结论')

  // dt-1:两次 locations、rawInput、_meta、content(文字+diff)、rawOutput 全保留;状态完成
  const dt1 = toolEntry(record, 'dt-1')
  expect(dt1).toMatchObject({ k: 'tool', status: 'completed', title: '读取 run-record.ts', detail: 'packages/server/src/agents/run-record.ts' })
  const acp = dt1!.acp as Record<string, unknown>
  expect(acp.locations).toEqual([
    { path: 'packages/server/src/agents/run-record.ts', line: 12 },
    { path: 'packages/shared/src/run-model.ts' },
  ])
  expect(acp.rawInput).toEqual({ file_path: 'packages/server/src/agents/run-record.ts', offset: 0, limit: 200 })
  expect(acp.rawOutput).toBe('{"lines":240,"hash":"deadbeef"}')
  expect(acp._meta).toEqual({ provider: 'fake-acp', traceId: 'tr-detail-1' })
  expect((acp.content as Array<{ type: string }>).map((c) => c.type)).toEqual(['content', 'diff'])
  // 小负载不应被标截断
  expect(dt1!.truncated).toBeUndefined()

  // 子代理:正文/思考与原回复分开,归到唤起它的 dt-1;子工具挂在 dt-1 下
  expect(dt1!.output).toContain('子代理:已读完 run-record.ts')
  expect(dt1!.thought).toContain('子代理:要不要顺带看 run-finalize?')
  expect(state.text).not.toContain('子代理:')
  const child = toolEntry(record, 'dt-child')
  expect(child).toMatchObject({ k: 'tool', parentId: 'dt-1', status: 'completed', activity: 'grep · 收尾出口' })

  // 子代理正文先于父工具到达：dt-2 的工具事件里带上先攒的 output/thought
  const dt2 = toolEntry(record, 'dt-2')
  expect(dt2).toMatchObject({ k: 'tool', status: 'completed' })
  expect(dt2!.output).toContain('子代理:正在核对 run-finalize 的两条出口。')
  expect(dt2!.thought).toContain('子代理:先看 finally 再下结论。')
  expect(state.text).not.toContain('正在核对 run-finalize')

  // ACP 会话元数据:按 sessionUpdate 命名键合并;原始 promptResponse 保留 stopReason/_meta
  const info = record.state.info!
  expect(info.context).toMatchObject({ used: 51234, size: 200000, cost: { amount: 0.0123, currency: 'USD' } })
  const infoAcp = info.acp as Record<string, unknown>
  // 其余 session update 按 sessionUpdate 命名键存；usage_update 走 info.context（带 cost）而非 info.acp；
  // plan 有自己的原语（state.plan），不重复进 info.acp
  for (const key of ['current_mode_update', 'config_option_update', 'promptResponse']) {
    expect(infoAcp[key]).toBeDefined()
  }
  expect(infoAcp.plan).toBeUndefined()
  expect(state.plan).toEqual([
    { content: '读 run-record.ts', status: 'completed', priority: 'high' },
    { content: '补详情测试', status: 'in_progress', priority: 'medium' },
  ])
  expect(infoAcp.promptResponse).toMatchObject({
    stopReason: 'end_turn',
    _meta: { session: 'fake-acp', turns: 3 },
    usage: { totalTokens: 20480, cachedWriteTokens: 0, thoughtTokens: 1024 },
  })

  // 真实用量:缺项不补 0;显式 0 保留
  expect(result.usage).toMatchObject({ cacheRead: 3072, cacheWrite: 0, thought: 1024 })
  const archived = record.record({ agent: 'fake', parentId: 'p1' }, 'end', 16000, result.usage)
  expect(archived.usage).toMatchObject({ total: 20480, cacheWrite: 0, thought: 1024 })
  expect(archived.info).toBeDefined()
  // 计划随过程页一起归档(最后一份)
  expect(archived.plan).toEqual(state.plan)
})

test('快照 + 后续事件 = 终态(共享 reducer 逐条重放,info/child/step 都不重复不丢)', async () => {
  const agent = new AcpAgent({ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] })
  const { sessionId } = await agent.newSession(process.cwd())
  const seen: AgentEvent[] = []
  const off = agent.on((ev) => seen.push(ev))
  await agent.prompt(sessionId, [{ type: 'text', text: DETAIL_PROMPT }])
  off()
  agent.kill()

  const run = createRunState({ pageId: 'p1', userId: 'u1', adapterKey: 'fake', remote: null })
  const events: RunEvent[] = []
  const record = new RunRecord('reply-1', run.startedAt, (ev) => events.push(ev))
  const half = Math.floor(seen.length / 2)
  for (let i = 0; i < half; i++) projectAgentEvent(run, record, seen[i]!, undefined, sessionId)
  record.flush()
  const snap = record.snapshot()
  const cut = events.length
  for (let i = half; i < seen.length; i++) projectAgentEvent(run, record, seen[i]!, undefined, sessionId)
  record.close()

  if (snap.type !== 'run') throw new Error('快照类型不对')
  const client: RunState = snap.state
  // events 是 RunRecord 发出的成品 RunEvent（reply/think/said/step/child/info）——直接重放
  for (const ev of events.slice(cut)) applyRunEvent(client, ev)
  expect(client).toEqual(record.state)
})

test('acp 增量合并:缺省键保持(只有 status 的更新不抹字段);显式 null/[] 才覆盖', () => {
  const base = mergeStep(undefined, {
    id: 't',
    acp: { rawInput: { a: 1 }, content: [{ type: 'content' }], locations: [{ path: 'a.ts' }] },
    status: 'pending',
  })
  const statusOnly = mergeStep(base, { id: 't', status: 'in_progress' })
  expect(statusOnly.acp).toEqual({ rawInput: { a: 1 }, content: [{ type: 'content' }], locations: [{ path: 'a.ts' }] })

  const cleared = mergeStep(base, { id: 't', acp: { locations: [], rawInput: null } })
  expect(cleared.acp!.locations).toEqual([])
  expect(cleared.acp!.rawInput).toBeNull()
  expect(cleared.acp!.content).toEqual([{ type: 'content' }]) // 未提到的键保持
  expect(cleared.status).toBe('pending') // acp 之外的字段不受影响
})

test('没报用量的分支:usage 不臆造(缺项不是 0)', async () => {
  const { result } = await foldDetailPrompt('你好')
  expect(result.usage).toBeUndefined()
})

test('纯文本分片不发 info(不逼 flush);带 _meta 的子代理分片才发,且不含正文', async () => {
  const agent = new AcpAgent({ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] })
  const { sessionId } = await agent.newSession(process.cwd())
  const seen: AgentEvent[] = []
  const off = agent.on((ev) => seen.push(ev))
  await agent.prompt(sessionId, [{ type: 'text', text: DETAIL_PROMPT }])
  off()
  agent.kill()

  // 详情分支里有大量流式父正文分片(say),它们没有额外元数据 → 不应各发一条 info
  const chunkInfos = seen.filter((ev) => ev.type === 'info' && ev.info.acp !== undefined && 'agent_message_chunk' in ev.info.acp)
  expect(chunkInfos.length).toBeLessThanOrEqual(4) // 只有带 _meta 的子代理分片会发;父正文分片一条都不发
  for (const ev of chunkInfos) {
    if (ev.type !== 'info' || !ev.info.acp) continue
    const block = ev.info.acp.agent_message_chunk as Record<string, unknown>
    // 正文 body 被剔除;只留 _meta 等元数据
    expect(block).toMatchObject({ _meta: { claudeCode: expect.anything() } })
    expect(block.content).toBeUndefined()
  }
})
