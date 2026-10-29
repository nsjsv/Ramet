// ---------- connector 第二道闸（集成：真 runConnector + 假中心）----------
// 中心哪怕有 bug、被攻破，也过不了 connector 自己这一关：每个驱动机器的帧（new / load / ls / prompt / config / permission）
// 都要带 actor，actor 得是本机钉住的主人或本地授权名单里的人（scope 匹配、未过期），否则 connector 拒绝、回报、不执行。
// 这里不接真中心：测试自己当"中心"，直接给 connector 发帧，包括中心绝不会（也不该）发出的：没带 actor 的、
// 不是主人也不在名单里的、scope 不符的、过期的。cancel 不是驱动帧（只会让机器停下来），不判。
// 驱动帧被拒时：回 err（带 rid；prompt 另带 runId），审批应答没有应答帧只留日志；agent 一个都没被拉起（日志里没有"指令 …"）。
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { CONNECTOR_TOKEN_HEADER, type CenterMsg, type ConnMsg } from '../agents/protocol.js'
import type { MachineScope } from '../agents/machine-access.js'
import { readConnectorConfig, type ConnectorConfig } from './access.js'
import { runConnector } from './index.js'
import { loadNodePty } from './pty.js'

const FAKE_AGENT = fileURLToPath(new URL('../agents/fake-agent.mjs', import.meta.url))
// connector 自己 loadAgents()：显式给一个，免得去自动检测本机装了什么
process.env.RAMET_AGENTS = JSON.stringify([{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] }])

const HOUR = 3_600_000
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()
const grant = (userId: string, scopes: MachineScope[], offsetMs = HOUR): NonNullable<ConnectorConfig['grants']>[number] => ({
  userId,
  scopes,
  expiresAt: iso(offsetMs),
})

type Fixture = {
  dir: string
  file: string
  logs: string[]
  /** 假中心收到的全部 connector 帧 */
  inbox: ConnMsg[]
  /** 下一次 welcome 里告知的机器主人（undefined = 不带这个字段，null = 中心库里没有主人） */
  state: { welcomeOwner: string | null | undefined }
  /** 当前这条连接（connector 重连会换） */
  socket: () => WebSocket
  /** 等 connector 连上并发来 hello（每次连接一次） */
  hello: () => Promise<void>
  send: (msg: CenterMsg | Record<string, unknown>) => void
  /** 发一个带 rid 的驱动帧，等对应的 res / err */
  ask: (msg: Record<string, unknown> & { rid: string }) => Promise<ConnMsg>
  stop: () => Promise<void>
}

let fixtures: Fixture[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.stop()
})

async function start(config: ConnectorConfig, opts: { welcomeOwner?: string | null } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'ramet-gate-'))
  const file = join(dir, 'connector.json')
  writeFileSync(file, JSON.stringify(config))
  const logs: string[] = []
  const inbox: ConnMsg[] = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as { port: number }).port
  const state: Fixture['state'] = { welcomeOwner: opts.welcomeOwner }
  let current: WebSocket | null = null
  let helloCount = 0
  let heard = 0
  wss.on('connection', (ws, req) => {
    expect(req.headers[CONNECTOR_TOKEN_HEADER]).toBe(config.token)
    current = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ConnMsg
      inbox.push(msg)
      if (msg.t === 'hello') {
        helloCount += 1
        ws.send(JSON.stringify({
          t: 'welcome',
          connectorId: 'c-gate',
          ...(state.welcomeOwner !== undefined ? { ownerId: state.welcomeOwner } : {}),
          resume: [],
          drop: [],
        }))
      }
    })
  })
  const controller = new AbortController()
  const done = runConnector({
    cloud: `http://127.0.0.1:${port}`,
    name: 'gate',
    cwd: dir,
    tokenFile: file,
    signal: controller.signal,
    log: (line) => logs.push(line),
  })
  const fixture: Fixture = {
    dir,
    file,
    logs,
    inbox,
    state,
    socket: () => current!,
    hello: async () => {
      heard += 1
      const deadline = Date.now() + 15_000
      while (helloCount < heard) {
        if (Date.now() > deadline) throw new Error('connector 没有连上假中心')
        await new Promise((r) => setTimeout(r, 20))
      }
      // welcome 已发出；等 connector 日志里出现"已连上中心"（它处理完 welcome，包括钉主人）
      while (logs.filter((l) => l.startsWith('已连上中心')).length < heard) {
        if (Date.now() > deadline) throw new Error('connector 没有处理 welcome')
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    send: (msg) => current!.send(JSON.stringify(msg)),
    ask: async (msg) => {
      const before = inbox.length
      current!.send(JSON.stringify(msg))
      const deadline = Date.now() + 10_000
      for (;;) {
        const hit = inbox.slice(before).find((m) => (m.t === 'res' || m.t === 'err') && m.rid === msg.rid)
        if (hit) return hit
        if (Date.now() > deadline) throw new Error(`没收到 ${msg.rid} 的应答`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    stop: async () => {
      controller.abort()
      await done.catch(() => undefined)
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
  fixtures.push(fixture)
  await fixture.hello()
  return fixture
}

const ls = (rid: string, actor: unknown, path: string): Record<string, unknown> & { rid: string } => ({
  t: 'ls',
  rid,
  ...(actor === undefined ? {} : { actor }),
  path,
})

/** 日志里 agent 被调用的痕迹：指令 new / load / prompt / config、审批应答。被拒的指令不会留下这些 */
const invoked = (f: Fixture): string[] => f.logs.filter((l) => /^(指令 |审批应答)/.test(l))

test('ls（agent 范围）：主人与名单里的人通过；没带 actor / 陌生人 / scope 不符 / 过期都回 err，且带原因', async () => {
  const f = await start({
    token: 'tok-gate',
    cloud: '',
    ownerId: 'owner',
    grants: [
      grant('ally', ['agent']),
      grant('terminal-only', ['machine']),
      grant('late', ['agent', 'machine'], -HOUR),
    ],
  })

  for (const actor of ['owner', 'ally']) {
    const res = await f.ask(ls(`ok-${actor}`, actor, f.dir))
    expect(res, actor).toMatchObject({ t: 'res', rid: `ok-${actor}`, dirs: { path: expect.any(String) } })
  }

  const cases: Array<[string, unknown, string]> = [
    ['no-actor', undefined, '没有带操作人'],
    ['empty', '', '没有带操作人'],
    ['number', 42, '没有带操作人'],
    ['stranger', 'stranger', '不允许你使用'],
    ['scope', 'terminal-only', '不允许你使用'], // 只授权终端 / 文件：agent 帧不行
    ['expired', 'late', '不允许你使用'],
  ]
  for (const [rid, actor, reason] of cases) {
    const res = await f.ask(ls(rid, actor, f.dir))
    expect(res, rid).toMatchObject({ t: 'err', rid, message: expect.stringContaining(reason) })
  }
  expect(f.logs.filter((l) => l.startsWith('拒绝 ls')).length).toBe(cases.length)
})

test('每一种驱动帧都过闸：陌生人的 new / load / prompt / config 回 err，agent 一个都没被拉起；审批应答静默丢弃只留日志', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent'])] })
  const stranger = 'stranger'

  const frames: Array<Record<string, unknown> & { rid: string }> = [
    { t: 'new', rid: 'n1', actor: stranger, agent: 'fake', cwd: f.dir },
    { t: 'new', rid: 'n2', agent: 'fake', cwd: f.dir }, // 没带 actor
    { t: 'load', rid: 'l1', actor: stranger, agent: 'fake', sessionId: 'S1', cwd: f.dir },
    { t: 'config', rid: 'c1', actor: stranger, agent: 'fake', sessionId: 'S1', configId: 'model', value: 'm2' },
    { t: 'prompt', rid: 'p1', actor: stranger, runId: 'run-1', agent: 'fake', sessionId: 'S1', blocks: [{ type: 'text', text: '你好' }] },
  ]
  for (const frame of frames) {
    const res = await f.ask(frame)
    expect(res, String(frame.t)).toMatchObject({ t: 'err', rid: frame.rid, message: expect.stringMatching(/没有带操作人|不允许你使用/) })
  }
  // prompt 的失败带 runId：中心据此把那一轮收掉（不留悬空的在飞回合）
  const promptErr = f.inbox.find((m) => m.t === 'err' && m.rid === 'p1')
  expect(promptErr).toMatchObject({ runId: 'run-1' })

  // 审批应答：没有应答帧，只能看日志；"允许"没有被转给 agent
  f.send({ t: 'permission', actor: stranger, agent: 'fake', requestId: 'perm-0', optionId: 'allow' })
  f.send({ t: 'permission', agent: 'fake', requestId: 'perm-1', optionId: 'allow' })
  const probe = await f.ask(ls('after-perm', 'owner', f.dir)) // 帧按序处理：它回来时前面两条都处理完了
  expect(probe.t).toBe('res')
  expect(f.logs.filter((l) => l.startsWith('拒绝 permission'))).toHaveLength(2)

  expect(invoked(f)).toEqual([]) // agent 没有被调用过
  expect(f.logs.some((l) => l.includes('本机 agent'))).toBe(true) // 日志是活的：证明上面的"没有"不是因为没记日志
})

test('cancel 不是驱动帧：不带 actor 也照常处理（只会让机器停下来），不被闸拦', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner' })
  f.send({ t: 'cancel', agent: 'fake', sessionId: 'S-none' })
  const probe = await f.ask(ls('after-cancel', 'owner', f.dir))
  expect(probe.t).toBe('res')
  expect(f.logs.some((l) => l.startsWith('拒绝 cancel'))).toBe(false)
})

test('名单现读不缓存：运行中改本地配置，收回的人立刻被拒，新授权的人立刻通过', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent'])] })
  expect((await f.ask(ls('a1', 'ally', f.dir))).t).toBe('res')
  expect((await f.ask(ls('b1', 'newbie', f.dir))).t).toBe('err')

  // 本机确认命令会改这份文件，这里直接改
  const config = readConnectorConfig(f.file)!
  writeFileSync(f.file, JSON.stringify({ ...config, grants: [grant('newbie', ['agent'])] }))
  expect((await f.ask(ls('a2', 'ally', f.dir))).t).toBe('err') // 收回：立即
  expect((await f.ask(ls('b2', 'newbie', f.dir))).t).toBe('res') // 新授权：立即
  expect((await f.ask(ls('o1', 'owner', f.dir))).t).toBe('res') // 主人不受名单影响

  // 配置文件被删 / 弄坏：什么人都不放行，连主人也不
  writeFileSync(f.file, '{ 坏了')
  expect(await f.ask(ls('o2', 'owner', f.dir))).toMatchObject({ t: 'err', message: expect.stringContaining('读不到') })
  expect(await f.ask(ls('b3', 'newbie', f.dir))).toMatchObject({ t: 'err' })
})

test('主人没钉住的老配置：钉住之前拒绝一切人；welcome 告知主人后钉住，之后只认它；换主人的 welcome 不接受改写', async () => {
  const f = await start({ token: 'tok-gate', cloud: '' }, { welcomeOwner: 'owner' }) // 配置里没有 ownerId
  // start 已经走完 hello → welcome：中心告知了 owner，connector 钉进了文件
  expect(readConnectorConfig(f.file)?.ownerId).toBe('owner')
  expect(f.logs).toContain('已记录这台机器的主人')
  expect((await f.ask(ls('o1', 'owner', f.dir))).t).toBe('res')
  expect(await f.ask(ls('s1', 'stranger', f.dir))).toMatchObject({ t: 'err', message: expect.stringContaining('不允许你使用') })

  // 钉住之后，中心换一个"主人"重连：不接受，仍以本机记录为准，并留下警告
  const raw = readFileSync(f.file, 'utf8')
  f.state.welcomeOwner = 'attacker'
  f.socket().close()
  await f.hello()
  expect(readFileSync(f.file, 'utf8')).toBe(raw)
  expect(f.logs.some((l) => l.startsWith('警告：中心告知的机器主人与本机记录的不一致'))).toBe(true)
  expect(await f.ask(ls('s2', 'attacker', f.dir))).toMatchObject({ t: 'err', message: expect.stringContaining('不允许你使用') })
  expect((await f.ask(ls('o2', 'owner', f.dir))).t).toBe('res')
})

test('没钉住主人、中心也没告知（库里没主人的老 connector）：谁都不放行，包括主人名字', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', grants: [grant('ally', ['agent'])] }, { welcomeOwner: null })
  expect(readConnectorConfig(f.file)?.ownerId).toBeUndefined()
  for (const actor of ['owner', 'ally', 'stranger']) {
    expect(await f.ask(ls(`x-${actor}`, actor, f.dir)), actor).toMatchObject({ t: 'err', message: expect.stringContaining('主人') })
  }
  expect(invoked(f)).toEqual([])
})

// ---------- grant-revoked：中心通知「此人的授权没了」----------
// 非驱动帧，只会减少权限：本地名单删掉此人 + 取消 actor 是此人的在飞 prompt。只读 userId，中心永远没法借它往名单里加人

/** 等 connector 发来满足条件的帧（假中心收件箱） */
async function inboxHas(f: Fixture, pred: (m: ConnMsg) => boolean, timeoutMs = 10_000): Promise<ConnMsg> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = f.inbox.find(pred)
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`等待 connector 帧超时：${JSON.stringify(f.inbox.slice(-5))}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function until(pred: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 30))
  }
}

test('grant-revoked 只删不加：删掉此人（立刻被拒），别人不动；带上授权内容的伪造帧也加不进名单；对机器主人的收回无效', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent']), grant('pal', ['agent'])] })
  expect((await f.ask(ls('a1', 'ally', f.dir))).t).toBe('res')

  f.send({ t: 'grant-revoked', userId: 'ally' })
  expect((await f.ask(ls('a2', 'ally', f.dir))).t).toBe('err') // 收回：立即
  expect((await f.ask(ls('p1', 'pal', f.dir))).t).toBe('res') // 别人不动
  expect(readConnectorConfig(f.file)?.grants?.map((g) => g.userId)).toEqual(['pal'])
  expect(f.logs.some((l) => l.startsWith('授权已收回 userId=ally'))).toBe(true)

  // 伪造：带着授权内容的 grant-revoked、以及不存在的"加人"帧，名单一个字都不会多
  f.send({ t: 'grant-revoked', userId: 'newbie', scopes: ['agent', 'machine'], expiresAt: iso(HOUR), grants: [grant('newbie', ['agent'])] } as never)
  f.send({ t: 'grant-added', userId: 'newbie', scopes: ['agent'], expiresAt: iso(HOUR) } as never)
  f.send({ t: 'grant-revoked' } as never) // 缺 userId
  f.send({ t: 'grant-revoked', userId: 42 } as never)
  expect((await f.ask(ls('n1', 'newbie', f.dir))).t).toBe('err')
  expect(readConnectorConfig(f.file)?.grants?.map((g) => g.userId)).toEqual(['pal'])

  // 对主人的收回：忽略（主人不靠名单；中心敲错 / 被攻破也不能借此把主人的在飞轮次断掉）
  f.send({ t: 'grant-revoked', userId: 'owner' })
  expect((await f.ask(ls('o1', 'owner', f.dir))).t).toBe('res')
  expect(f.logs.some((l) => l.startsWith('忽略对机器主人的收回'))).toBe(true)
})

test('grant-revoked 取消此人在飞的 prompt（机器上的第二道闸，不依赖中心的 cancel）；别人的在飞 prompt 不受影响', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent'])] })
  const begin = async (actor: string, runId: string): Promise<string> => {
    const created = await f.ask({ t: 'new', rid: `n-${runId}`, actor, agent: 'fake', cwd: f.dir })
    if (created.t !== 'res' || !created.sessionId) throw new Error('new 失败')
    f.send({ t: 'prompt', rid: `p-${runId}`, actor, runId, agent: 'fake', sessionId: created.sessionId, blocks: [{ type: 'text', text: '断线续' }] })
    await inboxHas(f, (m) => m.t === 'ev' && m.runId === runId) // 假 agent 先吐 before，然后睡 8 秒
    return created.sessionId
  }
  await begin('ally', 'run-ally')
  const ownerSession = await begin('owner', 'run-owner')

  f.send({ t: 'grant-revoked', userId: 'ally' })
  const ended = await inboxHas(f, (m) => m.t === 'end' && m.runId === 'run-ally')
  expect(ended).toMatchObject({ stopReason: 'cancelled' })
  // 主人的那一轮还在睡眠里（假 agent 8 秒），没有被一起取消
  await new Promise((r) => setTimeout(r, 400))
  expect(f.inbox.some((m) => (m.t === 'end' || m.t === 'err') && m.runId === 'run-owner')).toBe(false)
  f.send({ t: 'cancel', agent: 'fake', sessionId: ownerSession })
  await inboxHas(f, (m) => m.t === 'end' && m.runId === 'run-owner')
})

// ---------- 随手 AI 本地通道的 quick 帧（agent 范围）也过同一道闸 ----------
// quick = 驱动这台机器上的 agent 跑一次。主人与本地名单里有 agent 范围的人通过；没带 actor、陌生人、只授权 machine 的、过期的
// 都回 err(code: forbidden)，agent 一个都没被拉起（日志里没有 quick 的痕迹，也没有任何 quick-delta）。

const quickFrame = (rid: string, actor: unknown, prompt = '把这句话改好'): Record<string, unknown> & { rid: string } => ({
  t: 'quick',
  rid,
  ...(actor === undefined ? {} : { actor }),
  agent: 'fake',
  prompt,
})

test('quick 帧：没带 actor / 陌生人 / 只授权 machine / 过期 全部 forbidden，agent 没被拉起；主人与 agent 授权的人通过', async () => {
  const f = await start({
    token: 'tok-gate',
    cloud: '',
    ownerId: 'owner',
    grants: [grant('ally', ['agent']), grant('terminal-only', ['machine']), grant('late', ['agent', 'machine'], -HOUR)],
  })
  const cases: Array<[string, unknown]> = [
    ['no-actor', undefined],
    ['empty', ''],
    ['stranger', 'stranger'],
    ['machine-only', 'terminal-only'], // 只授权终端 / 文件：随手 AI 本地通道用的是 agent，不行
    ['expired', 'late'],
  ]
  for (const [rid, actor] of cases) {
    const res = await f.ask(quickFrame(rid, actor))
    expect(res, rid).toMatchObject({ t: 'err', rid, code: 'forbidden' })
  }
  expect(f.logs.filter((l) => l.startsWith('拒绝 quick'))).toHaveLength(cases.length)
  expect(f.logs.filter((l) => l.startsWith('quick '))).toEqual([]) // quick 一次都没跑起来
  expect(f.inbox.filter((m) => m.t === 'quick-delta')).toEqual([])

  for (const actor of ['owner', 'ally']) {
    const res = await f.ask(quickFrame(`ok-${actor}`, actor))
    expect(res, actor).toMatchObject({ t: 'res', rid: `ok-${actor}`, quick: { stopReason: 'end_turn' } })
    expect(f.inbox.some((m) => m.t === 'quick-delta' && m.rid === `ok-${actor}`)).toBe(true)
  }
})

test('quick：grant-revoked 当场中止此人在飞的 quick（机器上的第二道闸，不依赖中心）；别人的不受影响；quick-cancel 不是驱动帧，不判 actor', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent'])] })
  f.send(quickFrame('q-ally', 'ally', '随手慢'))
  f.send(quickFrame('q-owner', 'owner', '随手慢'))
  await inboxHas(f, (m) => m.t === 'quick-delta' && m.rid === 'q-ally')
  await inboxHas(f, (m) => m.t === 'quick-delta' && m.rid === 'q-owner')

  f.send({ t: 'grant-revoked', userId: 'ally' })
  expect(await inboxHas(f, (m) => m.t === 'err' && m.rid === 'q-ally')).toMatchObject({ message: expect.stringContaining('授权已收回') })
  await new Promise((r) => setTimeout(r, 300))
  expect(f.inbox.some((m) => (m.t === 'err' || m.t === 'res') && m.rid === 'q-owner')).toBe(false)

  // 不带 actor 的 quick-cancel 照常处理（只让机器停下来），不被闸拦
  f.send({ t: 'quick-cancel', rid: 'q-owner' })
  expect(await inboxHas(f, (m) => m.t === 'err' && m.rid === 'q-owner')).toMatchObject({ message: '已取消' })
  expect(f.logs.some((l) => l.startsWith('拒绝 quick-cancel'))).toBe(false)
})

// ---------- 项目面板的帧（machine 范围）也过同一道闸 ----------
// tree / read / files / git-status / git-diff 是 machine 范围的驱动帧：别人的机器上的文件不是公开的，读也算。
// 主人与本地名单里有 machine 范围的人通过；没带 actor、陌生人、只有 agent 范围的、过期的都回 err(code: forbidden) 且读不到任何内容。

const projectFrames = (rid: string, actor: unknown, root: string): Array<Record<string, unknown> & { rid: string }> => {
  const who = actor === undefined ? {} : { actor }
  return [
    { t: 'tree', rid: `${rid}-tree`, ...who, root, path: '' },
    { t: 'read', rid: `${rid}-read`, ...who, root, path: 'a.txt' },
    { t: 'files', rid: `${rid}-files`, ...who, root },
    { t: 'git-status', rid: `${rid}-status`, ...who, root },
    { t: 'git-diff', rid: `${rid}-diff`, ...who, root, path: 'a.txt' },
  ]
}

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'ramet-gate-ws-'))
  writeFileSync(join(ws, 'a.txt'), 'HELLO-FROM-WORKSPACE')
  return ws
}

test('项目面板的帧：主人与 machine 授权的人通过；没 actor / 陌生人 / 只授权 agent / 过期都被拒，且读不到任何内容', async () => {
  const f = await start({
    token: 'tok-gate',
    cloud: '',
    ownerId: 'owner',
    grants: [grant('viewer-of-files', ['machine']), grant('agent-only', ['agent']), grant('late', ['agent', 'machine'], -HOUR)],
  })
  // hello 声明了 project 能力：中心据此决定发不发这些帧
  expect(f.inbox.find((m) => m.t === 'hello')).toMatchObject({ caps: expect.arrayContaining(['project']) })
  const ws = workspace()

  for (const actor of ['owner', 'viewer-of-files']) {
    for (const frame of projectFrames(`ok-${actor}`, actor, ws)) {
      const res = await f.ask(frame)
      expect(res, `${actor} ${String(frame.t)}`).toMatchObject({ t: 'res', rid: frame.rid, project: { op: frame.t } })
    }
  }
  const read = await f.ask({ t: 'read', rid: 'content', actor: 'owner', root: ws, path: 'a.txt' })
  expect(read).toMatchObject({ t: 'res', project: { text: 'HELLO-FROM-WORKSPACE' } })

  const denied: Array<[string, unknown]> = [
    ['no-actor', undefined],
    ['empty', ''],
    ['stranger', 'stranger'],
    ['agent-only', 'agent-only'], // 只授权了 agent：终端 / 文件不行
    ['late', 'late'],
  ]
  for (const [label, actor] of denied) {
    for (const frame of projectFrames(`no-${label}`, actor, ws)) {
      const res = await f.ask(frame)
      expect(res, `${label} ${String(frame.t)}`).toMatchObject({ t: 'err', rid: frame.rid, code: 'forbidden' })
      expect(JSON.stringify(res)).not.toContain('HELLO-FROM-WORKSPACE')
    }
  }
  expect(f.logs.filter((l) => /^拒绝 (tree|read|files|git-status|git-diff)/.test(l)).length).toBe(denied.length * 5)
})

test('write 帧（machine 范围，唯一会改磁盘的项目帧）：主人与 machine 授权的人通过；没 actor / 陌生人 / 只授权 agent / 过期都被拒，文件一个字节都没动', async () => {
  const f = await start({
    token: 'tok-gate',
    cloud: '',
    ownerId: 'owner',
    grants: [grant('files-writer', ['machine']), grant('agent-only', ['agent']), grant('late', ['agent', 'machine'], -HOUR)],
  })
  expect(f.inbox.find((m) => m.t === 'hello')).toMatchObject({ caps: expect.arrayContaining(['write']) })
  const ws = workspace()
  const file = join(ws, 'a.txt')
  const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

  // 放行的人：写成功，内容真的变了
  let current = 'HELLO-FROM-WORKSPACE'
  for (const actor of ['owner', 'files-writer']) {
    const next = `written by ${actor}`
    const res = await f.ask({ t: 'write', rid: `w-${actor}`, actor, root: ws, path: 'a.txt', baseHash: hashOf(current), content: next })
    expect(res, actor).toMatchObject({ t: 'res', rid: `w-${actor}`, project: { op: 'write', path: 'a.txt', hash: hashOf(next) } })
    expect(readFileSync(file, 'utf8')).toBe(next)
    current = next
  }

  // 被拒的人：用着一份正确的 baseHash 也不行；文件原样，日志里有"拒绝 write"
  const denied: Array<[string, unknown]> = [
    ['no-actor', undefined],
    ['empty', ''],
    ['stranger', 'stranger'],
    ['agent-only', 'agent-only'], // 只授权了 agent：改不了文件
    ['late', 'late'],
  ]
  for (const [label, actor] of denied) {
    const res = await f.ask({
      t: 'write',
      rid: `no-${label}`,
      ...(actor === undefined ? {} : { actor }),
      root: ws,
      path: 'a.txt',
      baseHash: hashOf(current),
      content: `PWNED by ${label}`,
    })
    expect(res, label).toMatchObject({ t: 'err', rid: `no-${label}`, code: 'forbidden' })
    expect(readFileSync(file, 'utf8'), label).toBe(current)
  }
  expect(f.logs.filter((l) => l.startsWith('拒绝 write')).length).toBe(denied.length)
})

// ---------- 终端的帧（machine 范围，同一道闸 + pty 归属）----------
// 真 node-pty 起真 shell；装不上的环境跳过（那种环境 connector 本来就不声明 terminal 能力，见 project-pty-api.test.ts）。
const hasPty = Boolean(await loadNodePty()) && process.platform !== 'win32'

const ptyFrame = (rid: string, actor: unknown, t: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { rid: string } => ({
  t,
  rid,
  ...(actor === undefined ? {} : { actor }),
  ...extra,
})

describe.skipIf(!hasPty)('终端的帧', () => {
  test('主人与 machine 授权的人能开；没 actor / 陌生人 / 只授权 agent / 过期都被拒（code: forbidden），且一个终端也没开出来', async () => {
    const f = await start({
      token: 'tok-gate',
      cloud: '',
      ownerId: 'owner',
      grants: [grant('guest', ['machine']), grant('agent-only', ['agent']), grant('late', ['agent', 'machine'], -HOUR)],
    })
    const ws = workspace()
    for (const actor of ['owner', 'guest']) {
      const res = await f.ask(ptyFrame(`open-${actor}`, actor, 'pty-open', { root: ws, cols: 80, rows: 24 }))
      expect(res, actor).toMatchObject({ t: 'res', project: { op: 'pty-open', pty: { actor, root: realpathSync(ws) } } })
    }
    const denied: Array<[string, unknown]> = [['no-actor', undefined], ['empty', ''], ['stranger', 'stranger'], ['agent-only', 'agent-only'], ['late', 'late']]
    for (const [label, actor] of denied) {
      for (const t of ['pty-open', 'pty-list', 'pty-input', 'pty-resize', 'pty-close', 'pty-attach', 'pty-detach']) {
        const res = await f.ask(ptyFrame(`no-${label}-${t}`, actor, t, { root: ws, cols: 80, rows: 24, ptyId: 'whatever', data: 'x', after: -1 }))
        expect(res, `${label} ${t}`).toMatchObject({ t: 'err', code: 'forbidden' })
      }
    }
    // 被拒的人没有开出任何终端：主人的列表里只有 owner 和 guest 各一个
    const list = await f.ask(ptyFrame('list', 'owner', 'pty-list'))
    expect(list).toMatchObject({ t: 'res', project: { op: 'pty-list' } })
    const ptys = (list as { project: { ptys: Array<{ actor: string }> } }).project.ptys
    expect(ptys.map((p) => p.actor).sort()).toEqual(['guest', 'owner'])
  })

  test('别人的终端：有 machine 授权的第二个人和机器主人都输入 / 订阅 / 改尺寸不了（forbidden），主人能关；收回 / 收窄的帧当场关掉此人的终端', async () => {
    const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('guest', ['machine']), grant('guest2', ['machine'])] })
    const ws = workspace()
    const opened = await f.ask(ptyFrame('o1', 'guest', 'pty-open', { root: ws, cols: 80, rows: 24 }))
    const ptyId = (opened as { project: { pty: { ptyId: string } } }).project.pty.ptyId
    for (const who of ['guest2', 'owner']) {
      for (const [t, extra] of [['pty-input', { data: 'echo PWNED\n' }], ['pty-resize', { cols: 10, rows: 10 }], ['pty-attach', { after: -1 }], ['pty-detach', {}]] as const) {
        const res = await f.ask(ptyFrame(`x-${who}-${t}`, who, t, { ptyId, ...extra }))
        expect(res, `${who} ${t}`).toMatchObject({ t: 'err', code: 'forbidden' })
      }
    }
    expect(await f.ask(ptyFrame('c-guest2', 'guest2', 'pty-close', { ptyId }))).toMatchObject({ t: 'err', code: 'forbidden' })
    // 主人能关别人的
    const other = await f.ask(ptyFrame('o2', 'guest', 'pty-open', { root: ws, cols: 80, rows: 24 }))
    const otherId = (other as { project: { pty: { ptyId: string } } }).project.pty.ptyId
    expect(await f.ask(ptyFrame('c-owner', 'owner', 'pty-close', { ptyId: otherId }))).toMatchObject({ t: 'res', project: { op: 'pty-close' } })
    // 授权收窄 / 收回：非驱动帧，只会让终端消失
    f.send({ t: 'access-reduced', userId: 'guest', scope: 'machine' })
    await until(async () => ((await f.ask(ptyFrame(`l-${Date.now()}`, 'owner', 'pty-list'))) as { project: { ptys: unknown[] } }).project.ptys.length === 0)
    const again = await f.ask(ptyFrame('o3', 'guest2', 'pty-open', { root: ws, cols: 80, rows: 24 }))
    expect(again).toMatchObject({ t: 'res' })
    f.send({ t: 'grant-revoked', userId: 'guest2' })
    await until(async () => ((await f.ask(ptyFrame(`l2-${Date.now()}`, 'owner', 'pty-list'))) as { project: { ptys: unknown[] } }).project.ptys.length === 0)
    // 对机器主人的收窄无效
    const mine = await f.ask(ptyFrame('o4', 'owner', 'pty-open', { root: ws, cols: 80, rows: 24 }))
    expect(mine).toMatchObject({ t: 'res' })
    f.send({ t: 'access-reduced', userId: 'owner', scope: 'machine' })
    await new Promise((r) => setTimeout(r, 200))
    expect(((await f.ask(ptyFrame('l3', 'owner', 'pty-list'))) as { project: { ptys: unknown[] } }).project.ptys).toHaveLength(1)
  })

  test('终端的起始目录不能是 connector 的配置目录（token + 授权名单），主人也一样', async () => {
    const f = await start({ token: 'tok-secret-123', cloud: '', ownerId: 'owner' })
    const res = await f.ask(ptyFrame('cfg', 'owner', 'pty-open', { root: f.dir, cols: 80, rows: 24 }))
    expect(res).toMatchObject({ t: 'err' })
    expect(JSON.stringify(res)).not.toContain('tok-secret-123')
  })
})

test('项目面板：只授权 machine 的人用不了 agent 帧（两个 scope 互不蕴含）', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner', grants: [grant('files-only', ['machine'])] })
  expect(await f.ask(ls('x', 'files-only', f.dir))).toMatchObject({ t: 'err', code: 'forbidden' })
  expect(invoked(f)).toEqual([])
})

test('项目面板：connector 自己的配置目录（token + 授权名单）不对网页开放，主人也一样', async () => {
  const f = await start({ token: 'tok-secret-123', cloud: '', ownerId: 'owner' })
  // 工作区恰好把配置目录圈了进去（或者中心发来的 root 就是它）
  const direct = await f.ask({ t: 'read', rid: 'cfg-read', actor: 'owner', root: f.dir, path: 'connector.json' })
  expect(direct).toMatchObject({ t: 'err', rid: 'cfg-read' })
  const listing = await f.ask({ t: 'tree', rid: 'cfg-tree', actor: 'owner', root: f.dir, path: '' })
  expect(listing).toMatchObject({ t: 'err', rid: 'cfg-tree' })
  const up = await f.ask({ t: 'read', rid: 'cfg-up', actor: 'owner', root: join(f.dir, '..'), path: `${f.dir.split('/').pop()}/connector.json` })
  expect(up).toMatchObject({ t: 'err', rid: 'cfg-up' })
  for (const res of [direct, listing, up]) expect(JSON.stringify(res)).not.toContain('tok-secret-123')
})

test('项目面板：路径越界在 connector 侧被拒（不信中心发来的 path），主人也一样', async () => {
  const f = await start({ token: 'tok-gate', cloud: '', ownerId: 'owner' })
  const ws = workspace()
  for (const path of ['../' + ws.split('/').pop(), '/etc/passwd', 'a.txt\0x', '../../etc/passwd']) {
    const res = await f.ask({ t: 'read', rid: `p-${path.length}`, actor: 'owner', root: ws, path })
    expect(res, JSON.stringify(path)).toMatchObject({ t: 'err' })
  }
})
