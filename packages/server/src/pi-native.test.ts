/* ---------- pi / omp 原生驱动的端到端（真库 + 假 pi 系 CLI）----------
 * 本机 agent 与 connector 上的 agent 各跑一遍，pi 与 omp 两种方言：一轮正文落文档 + 第二轮在同一个会话里只发新消息、
 * Ramet 工具（pi：扩展注册的 MCP；omp：宿主工具）、切模型下一轮生效、停止本轮（审批卡随之消失）。
 * omp 另有：审批允许 / 本会话允许 / 拒绝、ask 多题多选 + 自由输入、子代理步骤与单独停止。
 * 权限姿态：本机主人（admin）切 yolo 后 omp 真的不再审批；connector 上被授权的非主人设 yolo 403、主人可以。
 * 执行端细节（对话框映射、配置项、换档重起）在 agents/drivers/pi/*.test.ts。
 */
import './pi-native-env.js'
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
type Dialect = 'pi' | 'omp'
type Ctx = { cookie: string; pageId: string; agent: string; connectorId: string | null; a: HocuspocusProvider; sse: SSECollector }

async function setup(where: Where, dialect: Dialect): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  let agent: string = dialect
  let connectorId: string | null = null
  if (where === 'connector') {
    const { spaceId, ownerId } = await pageOwnership(pageId)
    connectorId = await startConnector({ spaceId, ownerId, name: 'pibox', cookie })
    agent = `c:${connectorId}:${dialect}`
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
  for (const dialect of ['pi', 'omp'] as const) {
    test(`${where} ${dialect}：一轮正文落文档；第二轮在同一个会话里只发新消息；配置项到了前端`, async () => {
      const ctx = await setup(where, dialect)
      await send(ctx, '你好')
      await waitFor(() => docText(ctx.a).includes('turn:full model=fake/m1 thinking=medium'))
      await settled(ctx.sse, 1)
      const first = (await agentSession(ctx.pageId))?.[ctx.agent]?.sessionId
      expect(first).toBeTruthy()
      expect(
        ctx.sse.events.some((e) => e.type === 'config' && e.agentId === ctx.agent && e.options.some((o) => o.id === 'model' && o.currentValue === 'fake/m1')),
      ).toBe(true)

      await send(ctx, '再来一次')
      await waitFor(() => docText(ctx.a).includes('turn:delta'))
      await settled(ctx.sse, 2)
      expect((await agentSession(ctx.pageId))?.[ctx.agent]?.sessionId).toBe(first)
      done(ctx)
    })

    test(`${where} ${dialect}：会话里有 Ramet 的页面工具`, async () => {
      const ctx = await setup(where, dialect)
      if (dialect === 'pi') {
        // 驱动带的扩展按会话注册了 MCP（服务名 ramet、脚本 ramet.mjs、回打中心的地址）
        await send(ctx, '报 MCP')
        await waitFor(() => /mcp:ramet ramet\.mjs http/.test(docText(ctx.a)))
      } else {
        // omp：驱动自己当 MCP 客户端，把工具经 set_host_tools 交给 omp
        await send(ctx, '报工具')
        await waitFor(() => /tools:\S*ramet_read_page/.test(docText(ctx.a)))
      }
      done(ctx)
    })

    test(`${where} ${dialect}：切模型下一轮生效`, async () => {
      const ctx = await setup(where, dialect)
      await send(ctx, '你好')
      await settled(ctx.sse, 1)
      expect((await setConfig(ctx, 'model', 'fake/m2')).status).toBe(200)
      await ctx.sse.wait((e) => e.type === 'config' && e.agentId === ctx.agent && e.options.some((o) => o.id === 'model' && o.currentValue === 'fake/m2'))
      await send(ctx, '审批模式')
      await waitFor(() => docText(ctx.a).includes('model:fake/m2'))
      done(ctx)
    })

    test(`${where} ${dialect}：停止本轮，挂着的审批随之结束`, async () => {
      const ctx = await setup(where, dialect)
      // pi 的审批来自扩展的 confirm（假 pi 照权限扩展的做法发），omp 的是审批 select
      await send(ctx, '需要权限')
      const perm = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent)
      expect(perm.options.map((o) => o.optionId)).toEqual(dialect === 'pi' ? ['allow', 'reject'] : ['allow', 'allow-always', 'reject'])
      expect((await postJson(`/api/pages/${ctx.pageId}/stop`, ctx.cookie)).status).toBeLessThan(300)
      await ctx.sse.wait((e) => e.type === 'permission_resolved' && e.requestId === perm.requestId)
      await settled(ctx.sse, 1)
      expect(docText(ctx.a)).not.toContain('granted:')
      done(ctx)
    })
  }

  test(`${where} omp：审批允许一次 / 本会话总是允许 / 拒绝回到 omp`, async () => {
    const ctx = await setup(where, 'omp')
    const seen = new Set<string>()
    const next = async () => {
      const perm = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent && !seen.has(e.requestId))
      seen.add(perm.requestId)
      return perm
    }
    const answers: Array<[string, string]> = [
      ['allow', 'granted:allow_once'],
      ['allow-always', 'granted:allow_always'],
      ['reject', 'granted:reject_once'],
    ]
    for (const [i, [optionId, echo]] of answers.entries()) {
      await send(ctx, '需要权限 审批可总是')
      const perm = await next()
      expect(perm.toolCall).toMatchObject({ kind: 'execute' })
      expect(perm.view).toMatchObject({ command: 'npm test -- --run' })
      expect((await answerPermission(ctx.pageId, ctx.cookie, perm, optionId)).status).toBe(200)
      await waitFor(() => docText(ctx.a).includes(echo))
      await settled(ctx.sse, i + 1)
    }
    done(ctx)
  })

  test(`${where} omp：ask 多题多选 + 自由输入，答案回到 omp，步骤记下问答`, async () => {
    const ctx = await setup(where, 'omp')
    await send(ctx, '提问')
    const ask = await waitPermission(ctx.sse, (e) => e.agentId === ctx.agent && e.form !== undefined)
    const toolCallId = ask.form?.toolCallId
    expect(toolCallId).toMatch(/^call_ask_/)
    expect(ask.form?.fields.find((f) => f.key === 'question_1')).toMatchObject({ kind: 'choice', multi: true })
    const res = await postJson(`/api/pages/${ctx.pageId}/permission`, ctx.cookie, {
      agentId: ask.agentId,
      requestId: ask.requestId,
      optionId: 'accept',
      content: { question_0_custom: 'yarn', question_1: ['Lint', 'Docs'] },
    })
    expect(res.status).toBe(200)
    await ctx.sse.wait((e) => e.type === 'step' && e.step.id === toolCallId && (e.step.activity ?? '').startsWith('请回答下面这些问题 → 答：'))
    await waitFor(() => docText(ctx.a).includes('"用哪个包管理器？":"yarn"') && docText(ctx.a).includes('"要哪些功能？":"Lint, Docs"'))
    done(ctx)
  })

  test(`${where} omp：子代理是可停的步骤，单独停掉它，主回合照常收尾`, async () => {
    const ctx = await setup(where, 'omp')
    await send(ctx, '起子代理慢')
    const started = await ctx.sse.wait((e) => e.type === 'step' && Boolean(e.step.view?.handle))
    if (started.type !== 'step') throw new Error('不是步骤事件')
    const handle = started.step.view!.handle!
    // 子代理里的步骤挂在它下面
    await ctx.sse.wait((e) => e.type === 'step' && e.step.parentId === started.step.id)
    const stop = await postJson(`/api/pages/${ctx.pageId}/stop-command`, ctx.cookie, { terminalId: handle })
    expect(await stop.json()).toEqual({ ok: true })
    await waitFor(() => docText(ctx.a).includes('subagent:stopped'))
    await ctx.sse.wait((e) => e.type === 'status' && e.state === 'done')
    done(ctx)
  })
}

test('本机 omp：机器主人（admin）能切 yolo，omp 真的不再审批', async () => {
  const ctx = await setup('本机', 'omp')
  await send(ctx, '你好')
  await settled(ctx.sse, 1)
  expect((await setConfig(ctx, 'mode', 'yolo')).status).toBe(200)
  await send(ctx, '审批模式')
  await waitFor(() => docText(ctx.a).includes('perm-mode:yolo'))
  await settled(ctx.sse, 2)
  await send(ctx, '需要权限')
  await waitFor(() => docText(ctx.a).includes('granted:allow_once'))
  expect(ctx.sse.events.some((e) => e.type === 'permission')).toBe(false)
  done(ctx)
})

test('connector omp：被授权的非主人设 yolo 403、其它审批档可以；主人能设', async () => {
  const ctx = await setup('connector', 'omp')
  const bob = await joinPageSpace(ctx.pageId, 'bob', { role: 'member' })
  await grantMachine(ctx.connectorId!, await userIdOf('bob'))
  await send(ctx, '你好', bob)
  await settled(ctx.sse, 1)
  expect((await setConfig(ctx, 'mode', 'yolo', bob)).status).toBe(403)
  expect((await setConfig(ctx, 'mode', 'write', bob)).status).toBe(200)
  expect((await setConfig(ctx, 'mode', 'config', bob)).status).toBe(200)
  expect((await setConfig(ctx, 'mode', 'yolo')).status).toBe(200)
  await ctx.sse.wait((e) => e.type === 'config' && e.agentId === ctx.agent && e.options.some((o) => o.category === 'mode' && o.currentValue === 'yolo'))
  done(ctx)
})
