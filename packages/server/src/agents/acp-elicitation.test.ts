/* ---------- 提问（ACP elicitation/create）：AcpAgent + 真子进程，不起服务、不碰库 ----------
 * form 模式的提问挂成一条带 form 的审批（结束语义与审批一致），答案原样回给 agent。
 * 跳过 = decline；停止该会话 / agent 撤回（$/cancel_request）/ 所在的一轮结束 = cancel，每次结束都发 permission_resolved。
 * 受限会话（随手 AI）自动 decline、不发事件；必填字段认不出的表单直接 cancel。
 * fake-agent 的形状取自各家真实表单（ASK_SHAPES），归一细节在 ask-form.test.ts。 */
import { afterEach, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpAgent } from './acp.js'
import type { AgentEvent, PermissionEvent } from './types.js'

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

const spawned: AcpAgent[] = []
afterEach(() => {
  for (const agent of spawned.splice(0)) agent.kill()
})

function spawnAgent(): AcpAgent {
  const agent = new AcpAgent({ id: 'claude', label: 'Claude', command: process.execPath, args: [FAKE_AGENT] })
  spawned.push(agent)
  return agent
}

/** 录下适配器的全部事件，并能等到某种事件出现（等事件本身，没有定时器） */
function tape(agent: AcpAgent) {
  const events: AgentEvent[] = []
  const wakers: Array<() => void> = []
  agent.on((ev) => {
    events.push(ev)
    for (const wake of wakers.splice(0)) wake()
  })
  return {
    events,
    text: () => events.map((e) => (e.type === 'text' ? e.delta : '')).join(''),
    async when(match: (ev: AgentEvent) => boolean): Promise<AgentEvent> {
      for (;;) {
        const hit = events.find(match)
        if (hit) return hit
        const { promise, resolve } = Promise.withResolvers<void>()
        wakers.push(resolve)
        await promise
      }
    },
  }
}

const say = (text: string) => [{ type: 'text' as const, text }]
const isAsk = (ev: AgentEvent): ev is PermissionEvent => ev.type === 'permission' && ev.form !== undefined

async function ask(agent: AcpAgent, t: ReturnType<typeof tape>, sessionId: string, shape: string) {
  const turn = agent.prompt(sessionId, say(`表单提问:${shape}`))
  const ev = (await t.when(isAsk)) as PermissionEvent
  return { turn, ev }
}

test('claude 形状：挂成带 form 的审批（选项是 提交 / 跳过），答案原样回给 agent；待答期间 busy', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  const { turn, ev } = await ask(agent, t, sessionId, 'claude')
  expect(ev.options.map((o) => o.optionId)).toEqual(['accept', 'decline'])
  expect(ev.title).toBe('用哪个包管理器？')
  expect(ev.form?.toolCallId).toBe('ask-claude')
  expect(ev.form?.fields.map((f) => [f.key, f.kind])).toEqual([
    ['question_0', 'choice'],
    ['question_0_custom', 'text'],
    ['question_1', 'choice'],
  ])
  expect(agent.sessionState(sessionId).approvals).toHaveLength(1)

  const content = { question_0: 'pnpm', question_0_custom: '要 v9', question_1: ['lint', 'test'] }
  expect(agent.respondPermission(ev.requestId, 'accept', content)).toBe(true)
  await turn
  expect(t.text()).toContain(`ask:accept:${JSON.stringify(content)}`)
  expect(t.events.some((e) => e.type === 'permission_resolved' && e.requestId === ev.requestId)).toBe(true)
  expect(agent.sessionState(sessionId).approvals).toEqual([])
})

test('跳过 = decline；停止该会话 = cancel', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  const first = await ask(agent, t, sessionId, 'opencode')
  agent.respondPermission(first.ev.requestId, 'decline')
  await first.turn
  expect(t.text()).toContain('ask:decline:null')

  t.events.length = 0
  const second = await ask(agent, t, sessionId, 'omp-confirm')
  agent.cancel(sessionId)
  await second.turn
  expect(t.text()).toContain('ask:cancel:null')
  expect(t.events.some((e) => e.type === 'permission_resolved' && e.requestId === second.ev.requestId)).toBe(true)
})

test('各家形状归一：codex 的密码类、omp 的无标题 enum 与 boolean', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  for (const [shape, check] of [
    ['codex', (ev: PermissionEvent) => {
      expect(ev.form?.required).toEqual(['env', 'token'])
      expect(ev.form?.fields.find((f) => f.key === 'token')).toMatchObject({ kind: 'text', secret: true })
    }],
    ['omp-select', (ev: PermissionEvent) => {
      expect(ev.form?.toolCallId).toBeUndefined()
      expect(ev.form?.fields).toEqual([
        { key: 'value', kind: 'choice', multi: false, options: [{ value: 'Approve', label: 'Approve' }, { value: 'Deny', label: 'Deny' }] },
      ])
    }],
    ['omp-confirm', (ev: PermissionEvent) => {
      expect(ev.form?.fields).toEqual([{ key: 'value', kind: 'boolean' }])
    }],
  ] as const) {
    t.events.length = 0
    const { turn, ev } = await ask(agent, t, sessionId, shape)
    check(ev)
    agent.respondPermission(ev.requestId, 'decline')
    await turn
  }
})

test('必填字段认不出的表单：不弹，直接 cancel', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  await agent.prompt(sessionId, say('表单提问:weird'))
  expect(t.text()).toContain('ask:cancel:null')
  expect(t.events.some((e) => e.type === 'permission')).toBe(false)
})

test('agent 用 $/cancel_request 撤回：卡片摘掉（resolved），agent 收到 cancel', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  await agent.prompt(sessionId, say('表单撤回'))
  const ev = t.events.find(isAsk)
  expect(ev).toBeDefined()
  expect(t.events.some((e) => e.type === 'permission_resolved' && e.requestId === ev!.requestId)).toBe(true)
  expect(t.text()).toContain('ask-withdrawn:cancel')
  expect(agent.busy).toBe(false)
})

test('提问不比所在的一轮活得久：一轮结束时还没答的按 cancel 结束', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newSession(process.cwd())
  await agent.prompt(sessionId, say('表单超时'))
  const ev = t.events.find(isAsk)
  expect(ev).toBeDefined()
  expect(t.events.some((e) => e.type === 'permission_resolved' && e.requestId === ev!.requestId)).toBe(true)
  expect(agent.sessionState(sessionId).approvals).toEqual([])
  await agent.prompt(sessionId, say('报表单超时'))
  expect(t.text()).toContain('ask-late:cancel')
})

test('随手 AI 的受限会话：自动 decline，不发事件', async () => {
  const agent = spawnAgent()
  const t = tape(agent)
  const { sessionId } = await agent.newRestrictedSession(process.cwd())
  await agent.prompt(sessionId, say('表单提问:claude'))
  expect(t.text()).toContain('ask:decline:null')
  expect(t.events.some((e) => e.type === 'permission')).toBe(false)
})
