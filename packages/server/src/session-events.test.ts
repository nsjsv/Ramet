/* ---------- 会话事件归属 / 审批一直等 / 权限模式（全栈：本机 agent，假脚本）----------
 * agent 目录有两个本机 agent：`fake`（表外，mode 不可改）与 `claude`（同一份假脚本，id 命中真的 posture 表 ——
 * 生产代码不为 fake 开分支）。中心本机 agent 只有全局 admin 能用（它的主人就是 admin，不支持授权），
 * 页面创建人 alice 因此是 admin；非 admin 连看都看不到、用不了（machine-access.ts 的 assertLocalOwner）。
 * 「机器主人 vs 被授权的非主人」这对场景只在 connector agent 上存在，见 connector-session.test.ts。
 * 不变量：命令 / 配置 / 待批审批归会话（按页面 + agent），不归某一轮；审批只在有人答 / 停止该会话 / 进程退出时结束，
 * 没有超时；「跳过全部确认」只有机器主人能进，所有入口走同一个 authorize()。 */
import { expect, test, vi } from 'vitest'
import {
  addPage,
  agentsList,
  answerPermission,
  commandNames,
  connectDoc,
  continuePage,
  docText,
  joinPageSpace,
  postJson,
  prepareAndWait as prepared,
  replyBlocks,
  savedConfigs,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
  waitPermission,
} from './agents/test-kit.js'

const setConfig = (pageId: string, cookie: string, configId: string, value: string, agent = 'claude') =>
  postJson(`/api/pages/${pageId}/agent-config`, cookie, { agent, configId, value })

test('命令：不发消息就有；换 agent 跟着换、互不覆盖；晚到的订阅者回放得到', async () => {
  const { cookie, pageId } = await setupPage()
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  // 选 claude、一条消息都不发：斜杠菜单的数据里就有它的命令
  await prepared(sse, pageId, cookie, 'claude')
  await sse.wait((e) => e.type === 'commands' && e.agentId === 'claude' && e.list.length > 0)
  expect(commandNames(sse.events, 'claude')).toEqual(['claude-cmd'])

  // 换 agent：各有各的命令，fake 的命令不会覆盖 claude 的
  await prepared(sse, pageId, cookie, 'fake')
  await sse.wait((e) => e.type === 'commands' && e.agentId === 'fake' && e.list.length > 0)
  expect(commandNames(sse.events, 'fake')).toEqual(['fake-cmd'])
  expect(commandNames(sse.events, 'claude')).toEqual(['claude-cmd'])

  // 晚到的订阅者（刷新页面）：订阅即得全量，不用等 agent 再推
  const late = new SSECollector()
  await late.start(pageId, cookie)
  await late.wait((e) => e.type === 'commands' && e.agentId === 'fake' && e.list.length > 0)
  expect(commandNames(late.events, 'claude')).toEqual(['claude-cmd'])
  expect(commandNames(late.events, 'fake')).toEqual(['fake-cmd'])
  sse.stop()
  late.stop()
})

test('审批：两个 agent 同时待批，requestId 相同也不串，各答各的；旁观者（viewer）答不了', async () => {
  const { cookie, pageId: p1 } = await setupPage()
  const p2 = await addPage(p1, cookie)
  const d1 = await connectDoc(p1, cookie)
  const d2 = await connectDoc(p2, cookie)
  userMessage(d1.document, '需要权限')
  userMessage(d2.document, '需要权限')
  const s1 = new SSECollector()
  const s2 = new SSECollector()
  await s1.start(p1, cookie)
  await s2.start(p2, cookie)
  expect(await continuePage(p1, cookie, { agent: 'fake' })).toBe(202)
  expect(await continuePage(p2, cookie, { agent: 'claude' })).toBe(202)
  const a1 = await waitPermission(s1)
  const a2 = await waitPermission(s2)

  expect(a1.agentId).toBe('fake')
  expect(a2.agentId).toBe('claude')
  // 两个进程各自从 perm-0 数起：撞号是常态（这是本文件里第一个产生审批的用例，所以两边都是 perm-0）
  expect(a1.requestId).toBe(a2.requestId)
  // 拿对方的 agentId 答：这一页没有那条审批
  expect((await postJson(`/api/pages/${p1}/permission`, cookie, { agentId: 'claude', requestId: a1.requestId, optionId: 'allow_once' })).status).toBe(404)
  // 旁观者没有写权限：不能替别人答
  const viewer = await joinPageSpace(p1, 'viewer1', { role: 'viewer' })
  expect((await answerPermission(p1, viewer, a1, 'allow_once')).status).toBe(404)

  // p1 的答复只落到 p1，p2 的审批还在等
  expect((await answerPermission(p1, cookie, a1, 'allow_once')).status).toBe(200)
  await waitFor(() => docText(d1).includes('granted:allow_once'))
  expect(docText(d2)).not.toContain('granted:')
  expect(s2.events.some((e) => e.type === 'permission_resolved')).toBe(false)
  expect((await answerPermission(p2, cookie, a2, 'reject_once')).status).toBe(200)
  await waitFor(() => docText(d2).includes('granted:reject_once'))
  for (const s of [s1, s2]) s.stop()
  d1.destroy()
  d2.destroy()
})

test('审批：晚到的订阅者回放得到待批；答了之后 agent 继续；已结束的审批再答 404', async () => {
  const { cookie, pageId } = await setupPage()
  const d = await connectDoc(pageId, cookie)
  userMessage(d.document, '需要权限')
  const first = new SSECollector()
  await first.start(pageId, cookie)
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  const pending = await waitPermission(first)

  const late = new SSECollector()
  await late.start(pageId, cookie)
  expect(await waitPermission(late)).toMatchObject({ requestId: pending.requestId, agentId: 'fake' })

  expect((await answerPermission(pageId, cookie, pending, 'allow_once')).status).toBe(200)
  for (const s of [first, late]) {
    await s.wait((e) => e.type === 'permission_resolved' && e.requestId === pending.requestId && e.agentId === 'fake')
  }
  await waitFor(() => docText(d).includes('granted:allow_once'))
  expect((await answerPermission(pageId, cookie, pending, 'allow_once')).status).toBe(404)
  first.stop()
  late.stop()
  d.destroy()
})

test('审批比这一轮活得久：轮次结束后仍待批、仍能答，答后 agent 收到结果', async () => {
  const { cookie, pageId } = await setupPage()
  const d = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  userMessage(d.document, '后台审批')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  const pending = await waitPermission(sse)
  await sse.wait((e) => e.type === 'status' && e.state === 'done')
  // 这一轮结束了，审批没有：新订阅者照样回放到它（刷新页面不丢）
  const late = new SSECollector()
  await late.start(pageId, cookie)
  await waitPermission(late, (e) => e.requestId === pending.requestId)

  expect((await answerPermission(pageId, cookie, pending, 'allow_once')).status).toBe(200)
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === pending.requestId)
  // agent 收到的就是所选的选项（同一个进程记着）
  userMessage(d.document, '报后台审批')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(d).includes('bg:allow_once'))
  sse.stop()
  late.stop()
  d.destroy()
})

test('审批没有超时（假时钟）：推进 11 分钟审批仍在、进程没被闲置回收，之后答得上、agent 收到的是我们选的选项', async () => {
  const { cookie, pageId } = await setupPage()
  const d = await connectDoc(pageId, cookie) // 协同连接走真实时钟，先连好
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const late = new SSECollector()
  // 从这里起时钟归测试：只换 setTimeout/clearTimeout，并随真实时间自走（轮询 / 收尾里的等待照常往前走）。
  // 中心的 IdleRecycler 在 continue 时才 arm，所以它的 10 分钟窗口也在假时钟上
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
  try {
    userMessage(d.document, '后台审批') // 这一轮正常结束，审批还挂着：没有在飞 prompt，只剩待批
    expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
    const pending = await waitPermission(sse)
    await sse.wait((e) => e.type === 'status' && e.state === 'done')
    sse.stop() // 长连接不跨越时间跳跃；跳完用新订阅看回放

    await vi.advanceTimersByTimeAsync(11 * 60_000) // 审批不能被 5 分钟默认拒绝；busy 若只看在飞 prompt，10 分钟窗口一到就会回收进程
    await late.start(pageId, cookie)
    await waitPermission(late, (e) => e.requestId === pending.requestId)
    // 真能答才算还活着：进程被回收 / 审批被超时拒绝的话，这里是 404 / 409
    expect((await answerPermission(pageId, cookie, pending, 'reject_once')).status).toBe(200)
    await late.wait((e) => e.type === 'permission_resolved' && e.requestId === pending.requestId)
    userMessage(d.document, '报后台审批')
    expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
    await waitFor(() => docText(d).includes('bg:reject_once'))
  } finally {
    vi.useRealTimers()
    late.stop()
    d.destroy()
  }
})

test('停止：结束该会话的待批并广播 resolved；同一 agent 另一页的审批不受影响', async () => {
  const { cookie, pageId: p1 } = await setupPage()
  const p2 = await addPage(p1, cookie)
  const d1 = await connectDoc(p1, cookie)
  const d2 = await connectDoc(p2, cookie)
  userMessage(d1.document, '需要权限')
  userMessage(d2.document, '需要权限')
  const s1 = new SSECollector()
  const s2 = new SSECollector()
  await s1.start(p1, cookie)
  await s2.start(p2, cookie)
  expect(await continuePage(p1, cookie, { agent: 'fake' })).toBe(202)
  expect(await continuePage(p2, cookie, { agent: 'fake' })).toBe(202)
  const a1 = await waitPermission(s1)
  const a2 = await waitPermission(s2)
  expect(a1.requestId).not.toBe(a2.requestId) // 同一个进程里的两条审批

  expect((await postJson(`/api/pages/${p1}/stop`, cookie)).status).toBe(200)
  await s1.wait((e) => e.type === 'permission_resolved' && e.requestId === a1.requestId && e.agentId === 'fake')
  await s1.wait((e) => e.type === 'status' && e.state === 'done')
  expect((await answerPermission(p1, cookie, a1, 'allow_once')).status).toBe(404) // 已经结束
  // 停 A 页不能拒掉 B 页的审批（cancel 不能结束整个进程的全部待批）
  expect(s2.events.some((e) => e.type === 'permission_resolved')).toBe(false)
  expect((await answerPermission(p2, cookie, a2, 'allow_once')).status).toBe(200)
  await waitFor(() => docText(d2).includes('granted:allow_once'))
  for (const s of [s1, s2]) s.stop()
  d1.destroy()
  d2.destroy()
})

test('主人：本机 agent 的主人是服务器 admin —— admin 看得到并是主人，表外 agent 的 mode 不可改；非 admin 一个本机 agent 都看不到', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const asAdmin = await agentsList(cookie)
  expect(asAdmin.find((a) => a.id === 'claude')?.posture).toEqual({ owner: true, modes: true, unrestricted: ['bypassPermissions'] })
  expect(asAdmin.find((a) => a.id === 'fake')?.posture).toEqual({ owner: true, modes: false, unrestricted: [] })
  expect((await agentsList(bob)).filter((a) => a.id === 'claude' || a.id === 'fake')).toEqual([])
})

test('主人：本机 agent 非 admin 一律 403（连无害的配置也不行）；admin 设「跳过全部确认」可以并落成页面级意图；表外 agent 改 mode 400', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await prepared(sse, pageId, cookie, 'claude')
  await prepared(sse, pageId, cookie, 'fake')

  expect((await setConfig(pageId, bob, 'mode', 'bypassPermissions')).status).toBe(403)
  expect((await setConfig(pageId, bob, 'mode', 'default')).status).toBe(403)
  expect((await setConfig(pageId, bob, 'model', 'm2')).status).toBe(403)
  expect((await savedConfigs(pageId)).claude ?? {}).not.toHaveProperty('model', 'm2')

  expect((await setConfig(pageId, cookie, 'mode', 'default')).status).toBe(200)
  expect((await setConfig(pageId, cookie, 'model', 'm2')).status).toBe(200)
  expect((await setConfig(pageId, cookie, 'mode', 'bypassPermissions', 'fake')).status).toBe(400)
  expect((await savedConfigs(pageId)).claude).not.toHaveProperty('mode', 'bypassPermissions')

  expect((await setConfig(pageId, cookie, 'mode', 'bypassPermissions')).status).toBe(200)
  await sse.wait((e) => e.type === 'config' && e.agentId === 'claude' && e.options.some((o) => o.category === 'mode' && o.currentValue === 'bypassPermissions'))
  expect((await savedConfigs(pageId)).claude).toMatchObject({ mode: 'bypassPermissions' })
  sse.stop()
})

test('主人：会话处于「跳过全部确认」时非 admin 发起本机 agent → 403（agent 一个字都没看到）；admin 发起照常，agent 真的在该档下跑', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await prepared(sse, pageId, cookie, 'claude')
  expect((await setConfig(pageId, cookie, 'mode', 'bypassPermissions')).status).toBe(200)

  userMessage(a.document, '第一问')
  expect(await continuePage(pageId, bob, { agent: 'claude' })).toBe(403)
  expect(docText(a)).not.toContain('turn:')
  expect(replyBlocks(a)).toHaveLength(0) // 连占位回复块都没建

  expect(await continuePage(pageId, cookie, { agent: 'claude' })).toBe(202)
  await waitFor(() => docText(a).includes('mode=bypassPermissions'))
  sse.stop()
  a.destroy()
})

test('主人：本机 agent 的审批 —— 非 admin 答不了（403，审批留着），不论选项；admin 选「跳过全部确认」会话真的切过去，之后非 admin 的下一轮发不起来', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  userMessage(a.document, '退出计划')
  expect(await continuePage(pageId, cookie, { agent: 'claude' })).toBe(202)
  const plan = await waitPermission(sse, (e) => e.agentId === 'claude')
  expect(plan.options.map((o) => o.optionId)).toContain('exit-plan-bypass')

  expect((await answerPermission(pageId, bob, plan, 'exit-plan-bypass')).status).toBe(403)
  expect((await answerPermission(pageId, bob, plan, 'exit-plan-default')).status).toBe(403)
  // 403 不吞审批：新订阅者还看得到它
  const late = new SSECollector()
  await late.start(pageId, cookie)
  await waitPermission(late, (e) => e.requestId === plan.requestId)

  // admin 选了：会话切进 bypassPermissions（agent 只推了 current_mode_update），镜像据此广播并落成页面级意图
  expect((await answerPermission(pageId, cookie, plan, 'exit-plan-bypass')).status).toBe(200)
  await sse.wait((e) => e.type === 'config' && e.agentId === 'claude' && e.options.some((o) => o.category === 'mode' && o.currentValue === 'bypassPermissions'))
  await waitFor(async () => (await savedConfigs(pageId)).claude?.mode === 'bypassPermissions')
  await waitFor(() => docText(a).includes('plan-exit:exit-plan-bypass'))

  // 之后非 admin 的下一轮：连发起都 403
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, bob, { agent: 'claude' })).toBe(403)
  sse.stop()
  late.stop()
  a.destroy()
})

test('主人：admin 选普通审批选项不受限', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  userMessage(a.document, '退出计划')
  expect(await continuePage(pageId, cookie, { agent: 'claude' })).toBe(202)
  const plan = await waitPermission(sse, (e) => e.agentId === 'claude')
  expect((await answerPermission(pageId, cookie, plan, 'exit-plan-default')).status).toBe(200)
  await waitFor(() => docText(a).includes('plan-exit:exit-plan-default'))
  sse.stop()
  a.destroy()
})

test('主人：消息 attrs 里的 mode 不生效（消息 attrs 谁都能写，权限姿态只走受控的会话配置通道）', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问', { opts: 'mode=bypassPermissions' })
  expect(await continuePage(pageId, cookie, { agent: 'claude' })).toBe(202)
  await waitFor(() => docText(a).includes('> turn:full'))
  expect(docText(a)).toContain('mode=default')
  expect(docText(a)).not.toContain('mode=bypassPermissions')
  a.destroy()
})
