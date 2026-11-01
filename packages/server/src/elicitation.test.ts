/* ---------- 提问的中心链路（假 CLI，真库）----------
 * 提问经 SSE 到达（带 form 与 agentId）；POST /permission 按表单校验答案（不合 → 400 带原因，提问还挂着）；
 * 提交后 agent 收到答案、那一步工具调用的 activity 是「问题 → 答：…」；收件箱里是「等你回答」条目；跳过 = decline。
 * 用两家原生的提问：claude 的 AskUserQuestion（有多选）、codex 的 requestUserInput（跳过 = 空答案）。
 * 表单形状与答案组装的执行端细节在 agents/drivers/claude|codex/*.test.ts。 */
import { expect, test } from 'vitest'
import { base, connectDoc, continuePage, docText, postJson, setupPage, SSECollector, userMessage, waitFor, waitPermission } from './agents/test-kit.js'
import type { PermissionEvent } from './agents/types.js'

function answer(pageId: string, cookie: string, ask: PermissionEvent, body: Record<string, unknown>): Promise<Response> {
  return postJson(`/api/pages/${pageId}/permission`, cookie, { agentId: ask.agentId, requestId: ask.requestId, ...body })
}

test('提问：SSE 带 form → 不合表单回 400（提问还在）→ 提交后 agent 收到答案，步骤 activity 记下问答', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '提问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie, { agent: 'claude' })).toBe(202)
  const ask = await waitPermission(sse, (ev) => ev.form !== undefined)
  expect(ask.agentId).toBe('claude')
  const toolCallId = ask.form?.toolCallId
  expect(toolCallId).toMatch(/^toolu_ask_/)

  // 提问只能提交或跳过；答案不合表单给原因
  expect((await answer(pageId, cookie, ask, { optionId: 'allow' })).status).toBe(400)
  const bad = await answer(pageId, cookie, ask, { optionId: 'accept', content: { question_0: 'yarn' } })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as { message: string }).message).toBe('「包管理器」不在可选项里')
  expect((await answer(pageId, cookie, ask, { optionId: 'accept', content: { nope: 1 } })).status).toBe(400)

  expect((await answer(pageId, cookie, ask, { optionId: 'accept', content: { question_0: 'pnpm', question_1: ['Lint'] } })).status).toBe(200)
  await sse.wait((ev) => ev.type === 'permission_resolved' && ev.requestId === ask.requestId)
  await sse.wait((ev) => ev.type === 'step' && ev.step.id === toolCallId && ev.step.activity === '请回答下面这些问题 → 答：包管理器：pnpm；功能：Lint')
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()
  await waitFor(() => docText(a).includes('answers:{"用哪个包管理器？":"pnpm","要哪些功能？":"Lint"}'))
  a.destroy()
})

test('收件箱：待答的提问是「等你回答」条目（不是审批）；跳过 = decline', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '提问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)
  const ask = await waitPermission(sse, (ev) => ev.form !== undefined)
  expect(ask.agentId).toBe('fake')

  const inbox = (await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()) as { items: Array<Record<string, unknown>> }
  expect(inbox.items).toContainEqual(
    expect.objectContaining({ type: 'question', pageId, agentId: 'fake', requestId: ask.requestId, text: '请回答下面这些问题' }),
  )
  expect(inbox.items.some((item) => item.type === 'approval')).toBe(false)

  expect((await answer(pageId, cookie, ask, { optionId: 'decline' })).status).toBe(200)
  await sse.wait((ev) => ev.type === 'step' && ev.step.id === ask.form?.toolCallId && ev.step.activity === '请回答下面这些问题 → 跳过')
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()
  // codex 的提问没有「拒绝」：跳过 = 空答案
  await waitFor(() => docText(a).includes('answers:declined'))
  a.destroy()
})
