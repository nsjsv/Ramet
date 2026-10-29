import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeVerdict, INPUT_CHUNK_MAX, TermSession, type SessionHandlers, type TermWire } from './terminal-session'

const INFO = { ptyId: 'P', root: '/w', cols: 80, rows: 24, alive: true, exitCode: null, createdAt: 0, mine: true, owner: 'me' }

/** 假的 WebSocket：记下发出去的消息，测试里手动推服务端消息 / 关闭 */
class FakeSocket {
  readyState = 1
  sent: Array<Record<string, unknown>> = []
  closedWith: number | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000): void {
    this.closedWith = code
    this.readyState = 3
  }
  /** 服务端推一条消息 */
  push(msg: TermWire): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** 服务端（或网络）把连接关了 */
  drop(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
  of(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.t === t)
  }
}

function setup() {
  const log: string[] = []
  const latencies: Array<[number, number | null]> = []
  const h: SessionHandlers = {
    ready: (_i, lost, snapshot) => log.push(`ready${lost ? ':lost' : ''}${snapshot ? `:snap@${snapshot.seq}` : ''}`),
    data: (t) => log.push(`data:${t}`),
    exit: (code, reason) => log.push(`exit:${code}:${reason}`),
    failed: (m, code) => log.push(`failed:${code}:${m}`),
    status: (s) => log.push(`status:${s}`),
    inputError: (m) => log.push(`inputError:${m}`),
    latency: (rtt, relay) => latencies.push([rtt, relay]),
  }
  const sockets: FakeSocket[] = []
  let now = 0
  const session = new TermSession({ pageId: 'pg', agent: 'c:1:x', ptyId: 'P' }, h, {
    socket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    now: () => now,
  })
  const last = (): FakeSocket => sockets.at(-1)!
  return { session, log, latencies, sockets, last, advance: (ms: number) => (now += ms) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('location', { protocol: 'https:', host: 'ramet.test' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('closeVerdict：退出 = done；没登录 / 没授权 / 不存在 / 不支持 = 永久；机器离线 = 慢慢等；太慢（4408）与网络问题 = 重连', () => {
  expect(closeVerdict(1000, '')).toBe('done')
  for (const code of [4401, 4403, 4404, 4400]) expect(closeVerdict(code, 'x')).toBe('permanent')
  expect(closeVerdict(4409, 'terminal unsupported')).toBe('permanent')
  expect(closeVerdict(4409, 'connector outdated')).toBe('permanent')
  expect(closeVerdict(4409, 'machine offline')).toBe('offline')
  expect(closeVerdict(4408, 'slow')).toBe('retry')
  expect(closeVerdict(1006, '')).toBe('retry')
  expect(closeVerdict(1001, '')).toBe('retry')
})

test('连接地址：同源的 wss，带页面 / agent / 终端，全新打开 after = -1', () => {
  const { session, last } = setup()
  session.start()
  const url = new URL(last().url)
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('wss://ramet.test/term')
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: 'pg', agent: 'c:1:x', pty: 'P', after: '-1' })
})

test('快照：ready 带快照时交给 TermPane 还原；之后只写 seq 更大的输出（快照里已有的不重复写）', () => {
  const { session, log, last } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false, snapshot: { data: 'SNAP', seq: 7, cols: 100, rows: 30 } })
  last().push({ t: 'data', seq: 7, data: 'old' })
  last().push({ t: 'data', seq: 8, data: 'new' })
  expect(log).toEqual(['status:connecting', 'status:live', 'ready:snap@7', 'data:new'])
})

test('回放（老 connector）：按 seq 写；重复的不写；退出后收尾，不再重连', () => {
  const { session, log, last, sockets } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  last().push({ t: 'data', seq: 0, data: '$ ' })
  last().push({ t: 'data', seq: 0, data: 'dup' })
  last().push({ t: 'data', seq: 1, data: 'ls' })
  last().push({ t: 'exit', code: 0, reason: 'exited' })
  last().drop(1000)
  vi.advanceTimersByTime(60_000)
  expect(log).toEqual(['status:connecting', 'status:live', 'ready', 'data:$ ', 'data:ls', 'exit:0:exited', 'status:ended'])
  expect(sockets.length).toBe(1)
})

test('网络断了：自动重连并带 after = 已写入的最大 seq；重连后的旧 seq 不重复写', () => {
  const { session, log, last, sockets } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  last().push({ t: 'data', seq: 3, data: 'A' })
  last().drop(1006)
  expect(log.at(-1)).toBe('status:reconnecting')
  vi.advanceTimersByTime(500)
  expect(sockets.length).toBe(2)
  expect(new URL(last().url).searchParams.get('after')).toBe('3')
  last().push({ t: 'ready', pty: INFO, lost: false })
  last().push({ t: 'data', seq: 3, data: 'A-again' })
  last().push({ t: 'data', seq: 4, data: 'B' })
  expect(log.filter((l) => l.startsWith('data:'))).toEqual(['data:A', 'data:B'])
})

test('永久性失败（没授权 / 不存在 / connector 不支持）：回报服务端的人话，不重连', () => {
  for (const [code, error] of [[4403, 'forbidden'], [4404, 'not found'], [4409, 'terminal unsupported'], [4401, 'unauthorized']] as const) {
    const { session, log, last, sockets } = setup()
    session.start()
    last().push({ t: 'end', error, message: `人话-${error}` })
    last().drop(code)
    vi.advanceTimersByTime(60_000)
    expect(log.at(-1), error).toBe(`failed:${code}:人话-${error}`)
    expect(sockets.length, error).toBe(1)
  }
})

test('机器离线（4409 machine offline）：一直等，3 秒一试，回来了自动接上', () => {
  const { session, log, last, sockets } = setup()
  session.start()
  last().push({ t: 'end', error: 'machine offline', message: '这台机器不在线' })
  last().drop(4409)
  vi.advanceTimersByTime(2999)
  expect(sockets.length).toBe(1)
  vi.advanceTimersByTime(1)
  expect(sockets.length).toBe(2)
  last().push({ t: 'ready', pty: INFO, lost: false })
  expect(log.at(-1)).toBe('ready')
})

test('收得太慢被断开（4408）：立即重连，按快照接上', () => {
  const { session, last, sockets } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  last().drop(4408)
  vi.advanceTimersByTime(0)
  expect(sockets.length).toBe(2)
})

test('输入：连着就立刻发、不等确认；没连上时先攒着，连上后先发尺寸再按顺序补发；攒太多就丢并提示', () => {
  const { session, log, last } = setup()
  session.start()
  session.send('ab') // 还没 ready
  session.resize(100, 30)
  vi.advanceTimersByTime(100)
  expect(last().sent).toEqual([])
  last().push({ t: 'ready', pty: INFO, lost: false })
  expect(last().sent.filter((m) => m.t !== 'ping')).toEqual([{ t: 'size', cols: 100, rows: 30 }, { t: 'in', data: 'ab' }])
  session.send('c')
  session.send('d')
  expect(last().of('in').map((m) => m.data)).toEqual(['ab', 'c', 'd'])
  // 断线期间攒太多
  last().drop(1006)
  session.send('x'.repeat(5000))
  expect(log.at(-1)).toMatch(/^inputError:/)
})

test('粘贴大段文本按块发，每块不超过上限，拼起来不丢不乱', () => {
  const { session, last } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  const text = 'abcdefghij'.repeat(10_000)
  session.send(text)
  const parts = last().of('in').map((m) => String(m.data))
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every((p) => p.length <= INPUT_CHUNK_MAX)).toBe(true)
  expect(parts.join('')).toBe(text)
})

test('尺寸：去抖、同样的不重复发；重连后重发当前尺寸', () => {
  const { session, last } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  session.resize(90, 20)
  session.resize(91, 20)
  vi.advanceTimersByTime(100)
  session.resize(91, 20)
  vi.advanceTimersByTime(100)
  expect(last().of('size')).toEqual([{ t: 'size', cols: 91, rows: 20 }])
  last().drop(1006)
  vi.advanceTimersByTime(500)
  last().push({ t: 'ready', pty: INFO, lost: false })
  expect(last().of('size')).toEqual([{ t: 'size', cols: 91, rows: 20 }])
})

test('测往返：连上就 ping 一次、之后每 5 秒一次；pong 回来报 浏览器 ↔ 中心 的往返与 relayMs', () => {
  const { session, last, latencies, advance } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  const first = last().of('ping')[0]!
  advance(42)
  last().push({ t: 'pong', id: Number(first.id), relayMs: 30 })
  expect(latencies).toEqual([[42, 30]])
  vi.advanceTimersByTime(5000)
  expect(last().of('ping').length).toBe(2)
})

test('dispose：关掉连接，之后什么都不发、不重连', () => {
  const { session, last, sockets } = setup()
  session.start()
  last().push({ t: 'ready', pty: INFO, lost: false })
  session.dispose()
  expect(last().closedWith).toBe(1000)
  session.send('x')
  session.resize(10, 10)
  vi.advanceTimersByTime(60_000)
  expect(last().of('in')).toEqual([])
  expect(sockets.length).toBe(1)
})
