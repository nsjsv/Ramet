/* ---------- pi / omp 的 RPC 客户端：配对、事件、扩展 UI、ready / v2 分块、宿主工具、超时、进程退出（真子进程，不碰库）---------- */
import { afterEach, expect, test } from 'vitest'
import type { PiEvent, UiDialogRequest, UiNoticeRequest } from './protocol.js'
import { PiRpc, PiRpcError, PiRpcTimeoutError, type PiRpcOptions } from './rpc.js'

const opened: PiRpc[] = []
afterEach(() => {
  for (const r of opened.splice(0)) r.kill()
})

/** 子进程脚本的公共前缀：严格按 LF 读 stdin，每行交给 onMsg(m)；send(m) 写一行 */
const PRELUDE = `
  let buf = ''
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onMsg(JSON.parse(l)) }
  })
`

function open(script: string, extra: Partial<PiRpcOptions> = {}) {
  const events: PiEvent[] = []
  const notices: UiNoticeRequest[] = []
  const errors: string[] = []
  const rpc = new PiRpc({
    id: 'pi',
    dialect: 'pi',
    command: process.execPath,
    args: ['-e', PRELUDE + script],
    onEvent: (e) => events.push(e),
    onUiDialog: () => null,
    onUiNotice: (n) => notices.push(n),
    onProtocolError: (m) => errors.push(m),
    ...extra,
  })
  opened.push(rpc)
  return { rpc, events, notices, errors }
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('命令按 id 配对（乱序应答也对得上）；success:false 变成带 code 的 PiRpcError；发出去的帧是 {id, type, …参数}', async () => {
  const { rpc } = open(`
    function onMsg(m) {
      if (m.type === 'set_model') return send({ id: m.id, type: 'response', command: 'set_model', success: false, error: 'Model not found: x/y', code: 'nope' })
      setTimeout(() => send({ id: m.id, type: 'response', command: m.type, success: true, data: { echo: m, hasJsonrpc: 'jsonrpc' in m } }), m.delay ?? 0)
    }
  `)
  expect(await rpc.ready()).toBeNull()
  const slow = rpc.call('get_state', { delay: 80 })
  const fast = rpc.call('get_commands', { delay: 0 })
  expect(await fast).toMatchObject({ echo: { type: 'get_commands', id: 'r2' }, hasJsonrpc: false })
  expect(await slow).toMatchObject({ echo: { type: 'get_state', id: 'r1', delay: 80 } })
  const bad = await rpc.request('set_model', { provider: 'x', modelId: 'y' }).catch((e: unknown) => e)
  expect(bad).toBeInstanceOf(PiRpcError)
  expect(bad).toMatchObject({ command: 'set_model', message: 'Model not found: x/y', code: 'nope' })
})

test('事件交给 onEvent；没有 id 的失败应答与迟到的应答只进 onProtocolError；不是 JSON 的行丢掉', async () => {
  const { rpc, events, errors } = open(`
    process.stdout.write('not json\\n')
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi\\u2028there' } })
    send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' })
    send({ id: 'r999', type: 'response', command: 'abort', success: true })
    function onMsg(m) { send({ id: m.id, type: 'response', command: m.type, success: true }) }
  `)
  expect(await rpc.call('abort')).toBeUndefined()
  await until(() => events.length === 2 && errors.length === 1)
  expect(events[1]).toMatchObject({ assistantMessageEvent: { delta: 'hi there' } })
  expect(errors).toEqual(['parse: Failed to parse command'])
})

test('扩展 UI：对话框按返回值应答、返回 null 回 cancelled；展示类请求不应答；pi 的 timeout 到期自己撤回、不再应答', async () => {
  const seen: Array<{ req: UiDialogRequest; aborted: () => boolean }> = []
  const reports: unknown[][] = []
  const { notices } = open(
    `
    const got = []
    send({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] })
    send({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Run?', message: 'rm -rf x' })
    send({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Name?', timeout: 150 })
    send({ type: 'extension_ui_request', id: 'u4', method: 'notify', message: 'hello', notifyType: 'info' })
    function onMsg(m) {
      got.push(m)
      if (got.length === 2) setTimeout(() => send({ type: 'report', got }), 400)
    }
  `,
    {
      onUiDialog: (req, signal) => {
        seen.push({ req, aborted: () => signal.aborted })
        if (req.method === 'select') return { value: 'Beta' }
        if (req.method === 'confirm') return null
        // input：一直不答，等 pi 的 timeout 到期
        return new Promise((resolve) => signal.addEventListener('abort', () => setTimeout(() => resolve({ value: 'late' }), 20)))
      },
      onEvent: (e) => {
        if ((e as { type: string }).type === 'report') reports.push((e as unknown as { got: unknown[] }).got)
      },
    },
  )
  await until(() => reports.length === 1)
  expect(reports[0]).toEqual([
    { type: 'extension_ui_response', id: 'u1', value: 'Beta' },
    { type: 'extension_ui_response', id: 'u2', cancelled: true },
  ])
  expect(seen.find((s) => s.req.method === 'input')!.aborted()).toBe(true)
  expect(notices).toEqual([{ type: 'extension_ui_request', id: 'u4', method: 'notify', message: 'hello', notifyType: 'info' }])
})

test('omp：等 ready 帧、协商 v2；cancel {targetId} 撤回对话框；ask 的答案原样回去', async () => {
  let withdrawn = false
  const reports: unknown[] = []
  const { rpc } = open(
    `
    send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 4096 })
    function onMsg(m) {
      if (m.type === 'negotiate_protocol') {
        send({ id: m.id, type: 'response', command: m.type, success: true, data: { protocolVersion: 2 } })
        send({ type: 'extension_ui_request', id: 'a1', method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'] })
        setTimeout(() => send({ type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'a1' }), 50)
        send({ type: 'extension_ui_request', id: 'q1', method: 'ask', questions: [{ id: 'pm', question: 'PM?', options: [{ label: 'npm' }] }] })
        return
      }
      send({ type: 'report', m })
    }
  `,
    {
      dialect: 'omp',
      onUiDialog: (req, signal) => {
        if (req.method === 'ask') return { answers: [{ id: 'pm', selectedOptions: [], customInput: 'yarn' }] }
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => {
            withdrawn = true
            resolve({ value: 'Approve' })
          }),
        )
      },
      onEvent: (e) => reports.push((e as unknown as { m: unknown }).m),
    },
  )
  expect(await rpc.ready()).toMatchObject({ type: 'ready', supportedProtocolVersions: [1, 2] })
  expect(await rpc.negotiate()).toBe(true)
  expect(rpc.chunked).toBe(true)
  await until(() => withdrawn && reports.length >= 1)
  await new Promise((r) => setTimeout(r, 100))
  // 被撤回的 a1 不应答，只有 ask 的答案
  expect(reports).toEqual([{ type: 'extension_ui_response', id: 'q1', answers: [{ id: 'pm', selectedOptions: [], customInput: 'yarn' }] }])
})

test('omp v2 分块：拆开的帧（多字节字符跨块）拼回一条；打断 / 乱序 / 超过上限的序列丢掉，之后的帧照常', async () => {
  const { rpc, events, errors } = open(
    `
    send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: 4096 })
    function chunks(obj, id, size) {
      const bytes = Buffer.from(JSON.stringify(obj), 'utf8')
      const out = []
      for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
      return out.map((b, index) => ({ type: 'rpc_chunk', chunkId: id, index, count: out.length, byteLength: bytes.length, data: b.toString('base64') }))
    }
    const big = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '中文跨块'.repeat(40) }] } }
    for (const c of chunks(big, 'c1', 7)) send(c)
    // 打断：第 0 块后插进别的帧
    const broken = chunks(big, 'c2', 50)
    send(broken[0]); send({ type: 'agent_start' }); send(broken[1])
    // 乱序
    const shuffled = chunks(big, 'c3', 50)
    send(shuffled[1])
    // 超过 ready 声明的重组上限
    send({ type: 'rpc_chunk', chunkId: 'c4', index: 0, count: 1, byteLength: 999999, data: '' })
    send({ type: 'agent_end', messages: [] })
    function onMsg() {}
  `,
    { dialect: 'omp' },
  )
  await rpc.ready()
  await until(() => events.some((e) => e.type === 'agent_end'))
  expect(events.map((e) => e.type)).toEqual(['message_end', 'agent_start', 'agent_end'])
  const text = (events[0] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
  expect(text).toBe('中文跨块'.repeat(40))
  expect(errors).toHaveLength(4)
  expect(errors[0]).toContain('c2')
  expect(errors[3]).toContain('超过上限')
})

test('omp 宿主工具：返回值回 host_tool_result、抛错带 isError、progress 发 host_tool_update；host_tool_cancel 撤回后不再应答', async () => {
  const reports: unknown[] = []
  let cancelled = false
  open(
    `
    const got = []
    send({ type: 'host_tool_call', id: 'h1', toolCallId: 't1', toolName: 'read_page', arguments: { id: 'p1' } })
    send({ type: 'host_tool_call', id: 'h2', toolCallId: 't2', toolName: 'boom', arguments: {} })
    send({ type: 'host_tool_call', id: 'h3', toolCallId: 't3', toolName: 'slow', arguments: {} })
    setTimeout(() => send({ type: 'host_tool_cancel', id: 'x', targetId: 'h3' }), 50)
    function onMsg(m) { got.push(m); if (got.length === 3) setTimeout(() => send({ type: 'report', got }), 200) }
  `,
    {
      dialect: 'omp',
      onHostTool: async (call, signal, progress) => {
        if (call.toolName === 'boom') throw new Error('page gone')
        if (call.toolName === 'slow') {
          await new Promise((r) => signal.addEventListener('abort', r))
          cancelled = true
          return { content: [{ type: 'text', text: 'late' }] }
        }
        progress({ content: [{ type: 'text', text: 'reading' }] })
        return { content: [{ type: 'text', text: `page:${String(call.arguments.id)}` }] }
      },
      onEvent: (e) => reports.push((e as unknown as { got: unknown }).got),
    },
  )
  await until(() => reports.length === 1)
  expect(cancelled).toBe(true)
  const got = reports[0] as unknown[]
  expect(got).toHaveLength(3)
  expect(got[0]).toEqual({ type: 'host_tool_update', id: 'h1', partialResult: { content: [{ type: 'text', text: 'reading' }] } })
  expect(got).toContainEqual({ type: 'host_tool_result', id: 'h1', result: { content: [{ type: 'text', text: 'page:p1' }] } })
  expect(got).toContainEqual({ type: 'host_tool_result', id: 'h2', result: { content: [{ type: 'text', text: 'page gone' }] }, isError: true })
})

test('超时：PiRpcTimeoutError，迟到的应答丢掉', async () => {
  const { rpc, errors } = open(`
    function onMsg(m) { setTimeout(() => send({ id: m.id, type: 'response', command: m.type, success: true }), 150) }
  `)
  const r = await rpc.call('abort', {}, 50).catch((e: unknown) => e)
  expect(r).toBeInstanceOf(PiRpcTimeoutError)
  await new Promise((res) => setTimeout(res, 200))
  expect(errors).toEqual([])
})

test('进程退出：在飞命令与 ready 等待全部带退出说明失败，在办的对话框被撤回，onExit 报崩溃', async () => {
  let exit: { reason: string; crashed: boolean } | null = null
  let dialogAborted = false
  const { rpc } = open(
    `
    send({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'x', message: 'y' })
    function onMsg(m) {
      if (m.type === 'abort') { process.stderr.write('omp blew up\\n'); process.exit(3) }
    }
  `,
    {
      dialect: 'omp',
      onUiDialog: (_req, signal) => new Promise((resolve) => signal.addEventListener('abort', () => ((dialogAborted = true), resolve(null)))),
      onExit: (e) => (exit = e),
    },
  )
  const ready = rpc.ready().catch((e: unknown) => e)
  const pending = rpc.call('get_state').catch((e: unknown) => e)
  await new Promise((r) => setTimeout(r, 100))
  void rpc.call('abort').catch(() => undefined)
  await rpc.done
  expect(exit).toMatchObject({ crashed: true })
  expect(exit!.reason).toContain('退出码 3')
  expect(exit!.reason).toContain('omp blew up')
  expect(String(await pending)).toContain('退出码 3')
  expect(String(await ready)).toContain('退出码 3')
  expect(dialogAborted).toBe(true)
  expect(String(await rpc.call('get_state').catch((e: unknown) => e))).toContain('退出码 3')
})
