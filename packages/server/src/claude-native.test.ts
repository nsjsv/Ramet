/* ---------- Claude 原生驱动的端到端（真库 + 真 SDK + 假 claude）----------
 * 本机 agent 与 connector 上的 agent 各跑一遍同一组用例：一轮正文落文档、审批允许 / 拒绝、AskUserQuestion 多题多选 + 自由输入、
 * 子代理步骤与单独停止、切模型下一轮生效、停止本轮（审批卡随之消失）、第二轮在同一个会话里只发新消息。
 * 另有 connector 上的权限姿态：被授权的非主人设 bypass / auto 403、选提权的计划审批选项 403。
 * 执行端细节（选项形状、答案组装、进程重起）在 agents/drivers/claude/*.test.ts。
 */
import './claude-native-env.js'
import { expect, test } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  agentSession,
  answerPermission,
  connectDoc,
  continuePage,
  docText,
  grantMachine,
  joinPageSpace,
  pageOwnership,
  postJson,
  settled,
  setupPage,
  SSECollector,
  startConnector,
  userIdOf,
  userMessage,
  waitFor,
  waitPermission,
} from './agents/test-kit.js'

type Where = '本机' | 'connector'
type Ctx = { cookie: string; pageId: string; agent: string; connectorId: string | null; a: HocuspocusProvider; sse: SSECollector }

async function setup(where: Where): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  let agent = 'claude'
  let connectorId: string | null = null
  if (where === 'connector') {
    const { spaceId, ownerId } = await pageOwnership(pageId)
    connectorId = await startConnector({ spaceId, ownerId, name: 'clbox', cookie })
    agent = `c:${connectorId}:claude`
  }
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, pageId, agent, connectorId, a, sse }
}

function done(ctx: Ctx): void {
  ctx.sse.stop()
  ctx.a.destroy()
}

async function send(ctx: Ctx, text: string, cookie = ctx.cookie): Promise<void> {
  userMessage(ctx.a.document, text)
  expect(await continuePage(ctx.pageId, cookie, { agent: ctx.agent })).toBe(202)
}

const setConfig = (ctx: Ctx, configId: string, value: string, cookie = ctx.cookie) =>
  postJson(`/api/pages/${ctx.pageId}/agent-config`, cookie, { agent: ctx.agent, configId, value })

for (const where of ['本机', 'connector'] as const) {
  test(`${where}：一轮正文落文档；第二轮在同一个会话里只发新消息`, async () => {
    const ctx = await setup(where)
    await send(ctx, '你好')
    await waitFor(() => docText(ctx.a).includes('turn:full model=m1'))
    await settled(ctx.sse, 1)
    const first = (await agentSession(ctx.pageId))?.[ctx.agent]?.sessionId
    expect(first).toBeTruthy()
    // 斜杠命令清单经会话镜像到了前端
    expect(ctx.sse.events.some((e) => e.type === 'commands' && e.agentId === ctx.agent && e.list.some((c) => c.name === 'fake-cmd'))).toBe(true)

    await send(ctx, '再来一次')
    await waitFor(() => docText(ctx.a).includes('turn:delta'))
    await settled(ctx.sse, 2)
    expect((await agentSession(ctx.pageId))?.[ctx.agent]?.sessionId).toBe(first)
    done(ctx)
  })

  test(`${where}：审批允许 / 拒绝回到 CLI`, async () => {
    const ctx = await setup(where)
    await send(ctx, '需要权限')
    let perm = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent)
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'reject'])
    expect(perm.view).toMatchObject({ tool: 'Bash', command: 'npm test -- --run' })
    expect((await answerPermission(ctx.pageId, ctx.cookie, perm, 'allow')).status).toBe(200)
    await waitFor(() => docText(ctx.a).includes('granted:allow_once'))
    await settled(ctx.sse, 1)

    await send(ctx, '需要权限 第二次')
    const firstId = perm.requestId
    perm = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent && e.requestId !== firstId)
    expect((await answerPermission(ctx.pageId, ctx.cookie, perm, 'reject')).status).toBe(200)
    await waitFor(() => docText(ctx.a).includes('granted:reject_once'))
    done(ctx)
  })

  test(`${where}：AskUserQuestion 多题多选 + 自由输入，答案回到 CLI，步骤记下问答`, async () => {
    const ctx = await setup(where)
    await send(ctx, '提问')
    const ask = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent && e.form !== undefined)
    const toolCallId = ask.form?.toolCallId
    expect(toolCallId).toMatch(/^toolu_ask_/)
    const res = await postJson(`/api/pages/${ctx.pageId}/permission`, ctx.cookie, {
      agentId: ask.agentId,
      requestId: ask.requestId,
      optionId: 'accept',
      content: { question_0: 'pnpm', question_1: ['Lint', 'Docs'], question_1_custom: 'Bench' },
    })
    expect(res.status).toBe(200)
    await ctx.sse.wait((e) => e.type === 'step' && e.step.id === toolCallId && (e.step.activity ?? '').startsWith('请回答下面这些问题 → 答：'))
    await waitFor(() => docText(ctx.a).includes('Lint, Docs, Bench') && docText(ctx.a).includes('pnpm'))
    done(ctx)
  })

  test(`${where}：子代理是可停的步骤，单独停掉它，主回合照常收尾`, async () => {
    const ctx = await setup(where)
    await send(ctx, '起子代理慢')
    const started = await ctx.sse.wait((e) => e.type === 'step' && Boolean(e.step.view?.handle))
    if (started.type !== 'step') throw new Error('不是步骤事件')
    const handle = started.step.view!.handle!
    expect(handle).toMatch(/^task-/)
    // 子代理里的步骤挂在它下面
    await ctx.sse.wait((e) => e.type === 'step' && e.step.parentId === started.step.id)
    const stop = await postJson(`/api/pages/${ctx.pageId}/stop-command`, ctx.cookie, { terminalId: handle })
    expect(await stop.json()).toEqual({ ok: true })
    await waitFor(() => docText(ctx.a).includes('subagent:stopped'))
    await ctx.sse.wait((e) => e.type === 'status' && e.state === 'done')
    done(ctx)
  })

  test(`${where}：切模型下一轮生效`, async () => {
    const ctx = await setup(where)
    await send(ctx, '你好')
    await settled(ctx.sse, 1)
    const res = await setConfig(ctx, 'model', 'm2')
    expect(res.status).toBe(200)
    await ctx.sse.wait((e) => e.type === 'config' && e.agentId === ctx.agent && e.options.some((o) => o.id === 'model' && o.currentValue === 'm2'))
    await send(ctx, '审批模式')
    await waitFor(() => docText(ctx.a).includes('perm-mode:default model:m2'))
    done(ctx)
  })

  test(`${where}：停止本轮，挂着的审批随之结束`, async () => {
    const ctx = await setup(where)
    await send(ctx, '需要权限')
    const perm = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent)
    expect((await postJson(`/api/pages/${ctx.pageId}/stop`, ctx.cookie)).status).toBeLessThan(300)
    await ctx.sse.wait((e) => e.type === 'permission_resolved' && e.requestId === perm.requestId)
    await settled(ctx.sse, 1)
    expect(docText(ctx.a)).not.toContain('granted:')
    done(ctx)
  })
}

test('本机：机器主人（admin）能把会话切进「跳过全部确认」，agent 真的在该档下跑', async () => {
  const ctx = await setup('本机')
  await send(ctx, '你好')
  await settled(ctx.sse, 1)
  expect((await setConfig(ctx, 'mode', 'bypassPermissions')).status).toBe(200)
  await send(ctx, '审批模式')
  await waitFor(() => docText(ctx.a).includes('perm-mode:bypassPermissions'))
  done(ctx)
})

test('connector：被授权的非主人设 bypass / auto 403、普通模式可以；选提权的计划审批选项 403 且审批留着，主人能选', async () => {
  const ctx = await setup('connector')
  const bob = await joinPageSpace(ctx.pageId, 'bob', { role: 'member' })
  await grantMachine(ctx.connectorId!, await userIdOf('bob'))
  await send(ctx, '你好', bob)
  await settled(ctx.sse, 1)
  expect((await setConfig(ctx, 'mode', 'bypassPermissions', bob)).status).toBe(403)
  expect((await setConfig(ctx, 'mode', 'auto', bob)).status).toBe(403)
  expect((await setConfig(ctx, 'mode', 'acceptEdits', bob)).status).toBe(200)
  expect((await setConfig(ctx, 'mode', 'default', bob)).status).toBe(200)

  await send(ctx, '退出计划', bob)
  const plan = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent)
  expect(plan.options.map((o) => o.optionId)).toEqual(['exit-plan:default', 'exit-plan:bypassPermissions', 'reject'])
  expect((await answerPermission(ctx.pageId, bob, plan, 'exit-plan:bypassPermissions')).status).toBe(403)
  expect((await answerPermission(ctx.pageId, ctx.cookie, plan, 'exit-plan:bypassPermissions')).status).toBe(200)
  await ctx.sse.wait((e) => e.type === 'config' && e.agentId === ctx.agent && e.options.some((o) => o.category === 'mode' && o.currentValue === 'bypassPermissions'))
  await waitFor(() => docText(ctx.a).includes('plan-exit:exit-plan-bypass'))
  done(ctx)
})
