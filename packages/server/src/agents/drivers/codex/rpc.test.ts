/* ---------- codex app-server 的 JSON-RPC 客户端：配对、服务端请求、通知、超时、撤回、进程退出（真子进程，不碰库）---------- */
import { afterEach, expect, test } from 'vitest'
import { CodexRpc, RpcError, RpcTimeoutError, type CodexRpcOptions } from './rpc.js'

const opened: CodexRpc[] = []
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

function open(script: string, extra: Partial<CodexRpcOptions> = {}): { rpc: CodexRpc; notes: Array<{ method: string; params: unknown }> } {
  const notes: Array<{ method: string; params: unknown }> = []
  const rpc = new CodexRpc({
    id: 'codex',
    command: process.execPath,
    args: ['-e', PRELUDE + script],
    onRequest: () => {
      throw new RpcError(-32601, 'not handled')
    },
    onNotification: (n) => notes.push(n),
    ...extra,
  })
  opened.push(rpc)
  return { rpc, notes }
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('请求按 id 配对；codex 回 error 变成带 code 的 RpcError；发出去的消息不带 jsonrpc 字段', async () => {
  const { rpc } = open(`
    function onMsg(m) {
      if (m.method === 'boom') return send({ id: m.id, error: { code: -32600, message: 'no rollout found' } })
      // 倒序应答：配对只看 id，不看先后
      setTimeout(() => send({ id: m.id, result: { echo: m.params, hasJsonrpc: 'jsonrpc' in m } }), m.params.delay)
    }
  `)
  const slow = rpc.call('echo', { delay: 80, n: 1 })
  const fast = rpc.call('echo', { delay: 0, n: 2 })
  expect(await fast).toEqual({ echo: { delay: 0, n: 2 }, hasJsonrpc: false })
  expect(await slow).toEqual({ echo: { delay: 80, n: 1 }, hasJsonrpc: false })
  // 带类型的 request 走同一条路
  expect(await rpc.request('thread/read', { threadId: 'x', delay: 0 } as never)).toMatchObject({ echo: { threadId: 'x' } })
  const boom = await rpc.call('boom', {}).catch((e: unknown) => e)
  expect(boom).toBeInstanceOf(RpcError)
  expect((boom as RpcError).code).toBe(-32600)
  expect((boom as RpcError).message).toBe('no rollout found')
})

test('服务端请求：返回值回 result、抛 RpcError 回对应 code、抛普通错误回 -32603；字符串与数字 id 原样带回', async () => {
  const { rpc, notes } = open(
    `
    const got = {}
    send({ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'a' } })
    send({ id: '7', method: 'item/tool/requestUserInput', params: { itemId: 'b' } })
    send({ id: 8, method: 'mystery', params: {} })
    function onMsg(m) {
      got[JSON.stringify(m.id)] = m
      if (Object.keys(got).length === 3) send({ method: 'report', params: got })
    }
  `,
    {
      onRequest: async (method, params) => {
        if (method === 'item/fileChange/requestApproval') return { decision: 'accept', item: (params as { itemId: string }).itemId }
        if (method === 'item/tool/requestUserInput') throw new Error('答不了')
        throw new RpcError(-32601, `unknown method ${method}`)
      },
    },
  )
  await until(() => notes.some((n) => n.method === 'report'))
  const report = notes.find((n) => n.method === 'report')!.params as Record<string, unknown>
  expect(report['7']).toEqual({ id: 7, result: { decision: 'accept', item: 'a' } })
  expect(report['"7"']).toEqual({ id: '7', error: { code: -32603, message: '答不了' } })
  expect(report['8']).toEqual({ id: 8, error: { code: -32601, message: 'unknown method mystery' } })
  rpc.kill()
})

test('通知按到达顺序交出，带 params', async () => {
  const { notes } = open(`
    send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } }, emittedAtMs: 1 })
    send({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'i', delta: '你好\\u2028' } })
    send({ method: 'initialized' })
    function onMsg() {}
  `)
  await until(() => notes.length === 3)
  expect(notes.map((n) => n.method)).toEqual(['turn/started', 'item/agentMessage/delta', 'initialized'])
  expect((notes[1]!.params as { delta: string }).delta).toBe('你好 ')
  expect(notes[2]!.params).toBeUndefined()
})

test('超时：等不到应答按超时失败，迟到的应答被丢掉，之后的请求照常', async () => {
  const { rpc } = open(`
    function onMsg(m) {
      if (m.method === 'hang') return setTimeout(() => send({ id: m.id, result: 'late' }), 300)
      send({ id: m.id, result: 'ok' })
    }
  `)
  const err = await rpc.call('hang', {}, 100).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(RpcTimeoutError)
  await new Promise((r) => setTimeout(r, 350))
  expect(await rpc.call('ping', {})).toBe('ok')
})

test('codex 撤回请求（serverRequest/resolved）：处理函数的 signal 置 abort，之后算出来的结果不再发', async () => {
  let aborted = false
  const { notes } = open(
    `
    let responded = false
    send({ id: 5, method: 'item/commandExecution/requestApproval', params: {} })
    setTimeout(() => send({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 5 } }), 100)
    setTimeout(() => send({ method: 'report', params: { responded } }), 600)
    function onMsg(m) { if (m.id === 5) responded = true }
  `,
    {
      onRequest: (_method, _params, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            // 宿主按取消了结时照样会给一个答案：不能发出去
            resolve({ decision: 'cancel' })
          })
        }),
    },
  )
  await until(() => notes.some((n) => n.method === 'report'))
  expect(aborted).toBe(true)
  expect(notes.find((n) => n.method === 'report')!.params).toEqual({ responded: false })
  expect(notes.some((n) => n.method === 'serverRequest/resolved')).toBe(true)
})

test('进程退出：在飞请求带退出说明失败、之后的请求立即失败、在处理的服务端请求被 abort、onExit 报崩溃', async () => {
  let exit: { reason: string; crashed: boolean } | null = null
  let serverAborted = false
  const { rpc } = open(
    `
    send({ id: 1, method: 'item/fileChange/requestApproval', params: {} })
    function onMsg(m) {
      if (m.method === 'die') { process.stderr.write('codex panicked here\\n'); process.exit(3) }
    }
  `,
    {
      onRequest: (_m, _p, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            serverAborted = true
            resolve({ decision: 'cancel' })
          })
        }),
      onExit: (e) => {
        exit = e
      },
    },
  )
  const err = (await rpc.call('die', {}).catch((e: unknown) => e)) as Error
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain('退出码 3')
  expect(err.message).toContain('codex panicked here')
  expect(rpc.alive).toBe(false)
  expect(rpc.exited).toContain('退出码 3')
  const after = (await rpc.call('ping', {}).catch((e: unknown) => e)) as Error
  expect(after.message).toContain('退出码 3')
  expect(serverAborted).toBe(true)
  expect(exit).toMatchObject({ crashed: true })
})

test('主动 kill 不算崩溃；起不来（ENOENT）的请求带「起不来」失败', async () => {
  let exit: { reason: string; crashed: boolean } | null = null
  const { rpc } = open(`function onMsg() {}`, { onExit: (e) => (exit = e) })
  rpc.kill()
  await rpc.done
  expect(exit).toMatchObject({ crashed: false })

  const missing = new CodexRpc({
    id: 'codex',
    command: '/nonexistent/codex-binary',
    args: ['app-server'],
    onRequest: () => null,
    onNotification: () => undefined,
  })
  opened.push(missing)
  const err = (await missing.request('initialize', { clientInfo: { name: 'ramet', title: null, version: '0' }, capabilities: null }).catch((e: unknown) => e)) as Error
  expect(err.message).toContain('起不来')
  expect(err.message).toContain('ENOENT')
})
