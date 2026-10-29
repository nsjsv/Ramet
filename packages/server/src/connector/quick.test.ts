/* ---------- 随手 AI 本地通道：connector 侧的受限会话（QuickRunner + 真 AcpAgent + 假 agent）----------
 * 红线：随手 AI 在别人（或自己）的机器上跑 agent，只做一次文本改写，不许借它读文件 / 写文件 / 跑命令 / 免审批执行。
 * 假 agent 的触发词会真的向客户端发 ACP 请求（fs/read_text_file、fs/write_text_file、terminal/create、session/request_permission）：
 *   - 受限会话里这些请求一律被拒绝（断言：回显 *-denied、文件没被读到 / 没被写出、没有命令被起）；
 *   - 同样的请求在普通会话里是通的（对照组：证明陷阱是活的，不是假 agent 根本没发）。 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { AcpAgent } from '../agents/acp.js'
import type { ConnMsg } from '../agents/protocol.js'
import { QUICK_MAX_TOTAL, QuickRunner } from './quick.js'

const FAKE_AGENT = fileURLToPath(new URL('../agents/fake-agent.mjs', import.meta.url))

type Fixture = {
  root: string
  agent: AcpAgent
  frames: ConnMsg[]
  logs: string[]
  runner: QuickRunner
  /** 发一个 quick 帧，等它的 res / err；返回增量文本拼接与终结帧 */
  ask: (prompt: string, opts?: { rid?: string; actor?: string }) => Promise<{ text: string; end: ConnMsg }>
  wait: (rid: string) => Promise<ConnMsg>
  start: (prompt: string, rid: string, actor: string) => void
}

const fixtures: Array<() => void> = []
afterEach(() => {
  for (const stop of fixtures.splice(0)) stop()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function setup(opts: { id?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ramet-quick-test-'))
  const agent = new AcpAgent({ id: opts.id ?? 'claude', label: 'Claude', command: process.execPath, args: [FAKE_AGENT], ...(opts.env ? { env: opts.env } : {}) }, root)
  const frames: ConnMsg[] = []
  const logs: string[] = []
  const runner = new QuickRunner({
    adapter: () => agent,
    send: (m) => frames.push(m),
    log: (l) => logs.push(l),
    tmpRoot: root,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })
  let n = 0
  const wait = async (rid: string): Promise<ConnMsg> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const hit = frames.find((m) => (m.t === 'res' || m.t === 'err') && m.rid === rid)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`没等到 ${rid} 的终结帧`)
      await sleep(20)
    }
  }
  const start = (prompt: string, rid: string, actor: string): void =>
    runner.start({ t: 'quick', rid, actor, agent: opts.id ?? 'claude', prompt })
  const fixture: Fixture = {
    root,
    agent,
    frames,
    logs,
    runner,
    wait,
    start,
    ask: async (prompt, o = {}) => {
      const rid = o.rid ?? `q${++n}`
      start(prompt, rid, o.actor ?? 'u1')
      const end = await wait(rid)
      const text = frames.filter((m): m is Extract<ConnMsg, { t: 'quick-delta' }> => m.t === 'quick-delta' && m.rid === rid).map((m) => m.text).join('')
      return { text, end }
    },
  }
  fixtures.push(() => {
    runner.dispose()
    agent.kill()
    rmSync(root, { recursive: true, force: true })
  })
  return fixture
}

/** 受限会话收尾后，tmpRoot 里不该剩下东西（临时 cwd 已删） */
const leftovers = (f: Fixture): string[] => readdirSync(f.root)

describe('一次正常的调用', () => {
  test('文本增量 + res；cwd 是临时空目录；结束后临时目录与会话记录都清掉，中心看不到这个会话', async () => {
    const f = setup()
    const ids: string[] = []
    const original = f.agent.newRestrictedSession.bind(f.agent)
    f.agent.newRestrictedSession = async (cwd) => {
      const created = await original(cwd)
      ids.push(created.sessionId)
      return created
    }
    const { text, end } = await f.ask('把这句话改好 报目录')
    expect(end).toMatchObject({ t: 'res', quick: { stopReason: 'end_turn' } })
    expect(text).toContain('turn:full')
    const cwd = /cwd:(\S+)/.exec(text)?.[1] ?? ''
    expect(cwd.startsWith(join(f.root, 'ramet-quick-'))).toBe(true) // 工作区是临时目录，不是机器的任何真实目录
    expect(existsSync(cwd)).toBe(false) // 用完即删
    expect(leftovers(f)).toEqual([])
    expect(f.agent.knownSessions()).toEqual([])
    expect(ids).toHaveLength(1)
    expect(f.agent.isRestricted(ids[0]!)).toBe(false) // 会话记录也清了（受限标记、配置、命令、工作区）
    expect(f.agent.sessionState(ids[0]!)).toEqual({ commands: [], configs: [], approvals: [] })
    expect(f.agent.busy).toBe(false)
    expect(f.runner.active).toBe(0)
  })

  test('受限会话不对中心露面：knownSessions 不含它，isRestricted 为真（用后才被丢掉）', async () => {
    const f = setup()
    const session = await f.agent.newRestrictedSession(f.root)
    expect(f.agent.isRestricted(session.sessionId)).toBe(true)
    expect(f.agent.knownSessions()).toEqual([]) // sessionConfigs 里有它，但不会出现在给中心的快照里
    f.agent.discardSession(session.sessionId)
    expect(f.agent.isRestricted(session.sessionId)).toBe(false)
  })
})

describe('受限会话：读文件 / 写文件 / 终端 / 审批全部被拒绝', () => {
  test('读文件：被拒，机器上的文件内容不会出现在输出里；对照组（普通会话）读得到', async () => {
    const f = setup()
    const secret = join(f.root, 'secret.txt')
    writeFileSync(secret, 'TOP-SECRET-CONTENT')
    const { text } = await f.ask(`随手读文件:${secret}`)
    expect(text).toContain('read-denied:')
    expect(text).not.toContain('TOP-SECRET-CONTENT')

    // 对照：同一个触发词在普通会话里读得到（证明陷阱是活的）
    const normal = await f.agent.newSession(f.root)
    let seen = ''
    const off = f.agent.on((ev) => {
      if (ev.type === 'text' && ev.sessionId === normal.sessionId) seen += ev.delta
    })
    await f.agent.prompt(normal.sessionId, [{ type: 'text', text: `随手读文件:${secret}` }])
    off()
    expect(seen).toContain('read-ok:TOP-SECRET-CONTENT')
  })

  test('写文件：被拒，文件没有被写出', async () => {
    const f = setup()
    const target = join(f.root, 'planted.txt')
    const { text } = await f.ask(`随手写文件:${target}`)
    expect(text).toContain('write-denied:')
    expect(existsSync(target)).toBe(false)
  })

  test('终端：被拒（terminal/create 回错误，没有命令被起）；对照组（普通会话）起得来', async () => {
    const f = setup()
    const { text } = await f.ask('随手终端')
    expect(text).toContain('term-denied:')
    expect(text).not.toContain('term-ok')

    const normal = await f.agent.newSession(f.root)
    let seen = ''
    const off = f.agent.on((ev) => {
      if (ev.type === 'text' && ev.sessionId === normal.sessionId) seen += ev.delta
    })
    await f.agent.prompt(normal.sessionId, [{ type: 'text', text: '随手终端' }])
    off()
    expect(seen).toContain('term-ok')
  })

  test('审批：自动拒绝（agent 收到的是「拒绝」选项），不进待批、不发会话级事件，适配器不会因此一直忙', async () => {
    const f = setup()
    const events: string[] = []
    const off = f.agent.on((ev) => events.push(ev.type))
    const { text } = await f.ask('随手审批')
    off()
    expect(text).toContain('perm:reject_once')
    expect(events).not.toContain('permission')
    expect(events).not.toContain('permission_resolved')
    expect(f.agent.busy).toBe(false)
  })

  test('agent 一调用工具就中止本次：不会等它把工具跑完', async () => {
    const f = setup()
    const started = Date.now()
    const { text, end } = await f.ask('随手工具')
    expect(end).toMatchObject({ t: 'err', message: expect.stringContaining('调用工具') })
    expect(text).not.toContain('tool-ran')
    expect(Date.now() - started).toBeLessThan(2500) // 假 agent 的工具要 3 秒；中止了就不用等
    expect(leftovers(f)).toEqual([])
  })
})

describe('「跳过全部确认」档', () => {
  test('会话此刻在免确认档（claude 的 bypassPermissions）→ 先切到 default 再跑', async () => {
    const f = setup({ env: { FAKE_MODE: 'bypassPermissions' } })
    // 对照：普通新会话确实在免确认档（证明环境变量生效、不是默认值）
    const normal = await f.agent.newSession(f.root)
    expect(normal.configOptions.find((o) => o.category === 'mode')?.currentValue).toBe('bypassPermissions')

    const { text, end } = await f.ask('把这句话改好')
    expect(end.t).toBe('res')
    expect(text).toContain('mode=default')
    expect(text).not.toContain('bypassPermissions')
  })

  test('切不走（agent 忽略了切换）→ 拒绝运行：prompt 根本没发，没有任何输出', async () => {
    const f = setup({ env: { FAKE_MODE: 'bypassPermissions', FAKE_MODE_LOCKED: '1' } })
    const { text, end } = await f.ask('把这句话改好')
    expect(end).toMatchObject({ t: 'err', message: expect.stringContaining('拒绝运行') })
    expect(text).toBe('')
    expect(f.agent.busy).toBe(false)
    expect(leftovers(f)).toEqual([])
  })

  test('表外 agent（posture 表里没有）不猜：mode 不动。这是已知余量（见 posture.ts），审批和 fs / 终端仍被拒', async () => {
    const f = setup({ id: 'mystery', env: { FAKE_MODE: 'bypassPermissions' } })
    const { text, end } = await f.ask('把这句话改好')
    expect(end.t).toBe('res')
    expect(text).toContain('mode=bypassPermissions')
    const denied = await f.ask('随手终端')
    expect(denied.text).toContain('term-denied:')
  })
})

describe('名额与超时', () => {
  test('超时：中止、报错、清理；之后可以再来', async () => {
    const f = setup({ timeoutMs: 400 })
    const { end } = await f.ask('随手慢')
    expect(end).toMatchObject({ t: 'err', message: expect.stringContaining('超时') })
    expect(leftovers(f)).toEqual([])
    expect(f.runner.active).toBe(0)
    const again = await f.ask('再来一次')
    expect(again.end.t).toBe('res')
  })

  test('每人同时一个；整台机器同时最多 QUICK_MAX_TOTAL 个；cancelActor 当场停掉他的；cancel(rid) 停指定的', async () => {
    const f = setup()
    f.start('随手慢', 'a1', 'alice')
    await sleep(300)
    expect(f.runner.active).toBe(1)
    // 同一个人再来一个：直接被拒（不影响第一个）
    f.start('随手慢', 'a2', 'alice')
    expect(await f.wait('a2')).toMatchObject({ t: 'err', message: expect.stringContaining('已经有一次') })
    expect(f.runner.active).toBe(1)

    // 别人可以，直到整台机器的名额用完
    const others = ['bob', 'carol', 'dave']
    others.forEach((who, i) => f.start('随手慢', `o${i}`, who))
    await sleep(500)
    expect(f.runner.active).toBe(QUICK_MAX_TOTAL)
    f.start('随手慢', 'extra', 'erin')
    expect(await f.wait('extra')).toMatchObject({ t: 'err', message: expect.stringContaining('太忙') })

    // 收回 alice 的授权：她的当场停（原因写清）
    f.runner.cancelActor('alice')
    expect(await f.wait('a1')).toMatchObject({ t: 'err', message: expect.stringContaining('授权已收回') })
    // 别人的不受影响，按 rid 停
    expect(f.frames.some((m) => m.t === 'err' && m.rid === 'o0')).toBe(false)
    f.runner.cancel('o0')
    expect(await f.wait('o0')).toMatchObject({ t: 'err', message: '已取消' })
    f.runner.dispose()
    for (const rid of ['o1', 'o2']) expect(await f.wait(rid)).toMatchObject({ t: 'err' })
    expect(leftovers(f)).toEqual([])
  })

  test('请求内容不合法：空 prompt / 超长 / 缺 agent 直接 err，不起会话', async () => {
    const f = setup()
    expect((await f.ask('   ')).end).toMatchObject({ t: 'err' })
    expect((await f.ask('x'.repeat(100_001))).end).toMatchObject({ t: 'err' })
    f.runner.start({ t: 'quick', rid: 'noagent', actor: 'u1', agent: '', prompt: 'hi' })
    expect(await f.wait('noagent')).toMatchObject({ t: 'err' })
    expect(f.agent.knownSessions()).toEqual([])
    expect(f.agent.alive).toBe(false) // 连 agent 进程都没起
  })
})
