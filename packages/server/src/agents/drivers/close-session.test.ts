/* ---------- closeSession 之后 loadSession 一定重新从磁盘读；会话端口的规则与（假）CLI 的落盘布局是同一份 ----------
 * 四家原生驱动各一遍（假 claude / 假 codex / 假 pi / 假 omp）：跑一轮 → 在磁盘上改记录 → closeSession → loadSession → 「报会话」
 * 报的轮数来自磁盘。另外按端口算出的目标位置写记录（模拟从别的机器下发）后能在另一个工作目录接上。不连库。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '../types.js'
import type { DriverBase } from './base.js'
import { ClaudeDriver } from './claude/driver.js'
import { CodexDriver } from './codex/driver.js'
import { ownRollout } from './codex/session-port.js'
import { RpcAgentDriver } from './pi/driver.js'

const fake = (name: string) => fileURLToPath(new URL(`../fake/${name}`, import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'close-session-test-'))
process.env.RAMET_SESSIONS_DIR = join(root, 'ramet-sessions')
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'close-session-cwd-')))
const otherCwd = realpathSync(mkdtempSync(join(tmpdir(), 'close-session-other-')))
afterAll(() => {
  for (const dir of [root, cwd, otherCwd]) rmSync(dir, { recursive: true, force: true })
})

const drivers: DriverBase[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function track<T extends DriverBase>(d: T): { d: T; events: AgentEvent[] } {
  drivers.push(d)
  const events: AgentEvent[] = []
  d.on((ev) => events.push(ev))
  return { d, events }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const said = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'text' && !e.parentId ? [e.delta] : [])).join('')

/** 「报会话」→ 此前已有的轮数 */
async function prior(d: DriverBase, events: AgentEvent[], sessionId: string): Promise<number> {
  events.length = 0
  await d.prompt(sessionId, text('报会话'))
  const m = / prior:(\d+)\n$/.exec(said(events))
  if (!m) throw new Error(`没有报会话：${said(events)}`)
  return Number(m[1])
}

/** 记录（JSONL）最后一行的副本，turns 改成 n，追加回去：模拟磁盘上的记录比进程内存里的新 */
function bumpTurns(file: string, n: number): void {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>
  appendFileSync(file, JSON.stringify({ ...last, turns: n }) + '\n')
}

describe('claude', () => {
  const config = join(root, 'claude-config')
  const make = () => track(new ClaudeDriver({ id: 'claude', label: 'Claude', command: fake('claude.mjs'), driver: 'claude', env: { CLAUDE_CONFIG_DIR: config } }))

  test('端口找到的就是 CLI 写的记录；没 close 时 load 沿用进程里的会话，close 之后 load 从磁盘重读', async () => {
    const { d, events } = make()
    const { sessionId } = await d.newSession(cwd)
    expect(await prior(d, events, sessionId)).toBe(0)
    expect(await prior(d, events, sessionId)).toBe(1)
    const [main] = await d.sessionPort.list(sessionId)
    expect(main?.path).toBe(d.sessionPort.target(sessionId, cwd, 'main.jsonl'))
    bumpTurns(main!.path, 9)
    await d.loadSession(sessionId, cwd)
    expect(await prior(d, events, sessionId)).toBe(2)
    // 上面那一轮又往记录里追加了一行（轮数 3），重新改一次
    bumpTurns(main!.path, 9)
    await d.closeSession(sessionId)
    await d.loadSession(sessionId, cwd)
    expect(await prior(d, events, sessionId)).toBe(9)
  })

  test('按端口写到另一个工作目录的项目目录、删掉旧副本后，在那个目录里接上同一个会话', async () => {
    const { d, events } = make()
    const { sessionId } = await d.newSession(cwd)
    await prior(d, events, sessionId)
    await d.closeSession(sessionId)
    const [main] = await d.sessionPort.list(sessionId)
    const target = d.sessionPort.target(sessionId, otherCwd, 'main.jsonl')!
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(main!.path))
    await d.sessionPort.afterImport!(sessionId, otherCwd)
    expect((await d.sessionPort.list(sessionId)).map((f) => f.path)).toEqual([target])
    await d.loadSession(sessionId, otherCwd)
    expect(await prior(d, events, sessionId)).toBe(1)
    // 旧工作目录里已经没有这份记录：真 CLI 的 --resume 只在当前 cwd 的项目目录里找
    await d.closeSession(sessionId)
    await expect(d.loadSession(sessionId, cwd)).rejects.toThrow(/No conversation found/)
  })
})

describe('codex', () => {
  const home = join(root, 'codex-home')
  const make = () => track(new CodexDriver({ id: 'codex', label: 'Codex', command: fake('codex.mjs'), driver: 'codex', env: { CODEX_HOME: home } }))

  test('端口在 codex 自己的日期目录里找到 rollout；自管目录里有下发的那份时 load 按文件恢复，之后的回合追加在它上面', async () => {
    const { d, events } = make()
    const { sessionId } = await d.newSession(cwd)
    expect(await prior(d, events, sessionId)).toBe(0)
    const [native] = await d.sessionPort.list(sessionId)
    expect(native?.path).toMatch(new RegExp(`/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]+-${sessionId}\\.jsonl$`))
    const nativeBefore = readFileSync(native!.path, 'utf8')

    // 模拟从别的机器下发：比本机多两轮的记录写到自管目录
    const own = d.sessionPort.target(sessionId, cwd, 'main.jsonl')!
    expect(own).toBe(ownRollout(sessionId))
    mkdirSync(dirname(own), { recursive: true })
    writeFileSync(own, nativeBefore)
    bumpTurns(own, 3)
    await d.closeSession(sessionId)
    await d.loadSession(sessionId, cwd)
    expect(await prior(d, events, sessionId)).toBe(3)
    expect(readFileSync(own, 'utf8').split('\n').filter(Boolean).length).toBe(nativeBefore.split('\n').filter(Boolean).length + 2)
    expect(readFileSync(native!.path, 'utf8')).toBe(nativeBefore)
    expect((await d.sessionPort.list(sessionId)).map((f) => f.path)).toEqual([own])
  })

  test('close 之后换一个进程也能按自管目录里的文件恢复', async () => {
    const a = make()
    const { sessionId } = await a.d.newSession(cwd)
    await prior(a.d, a.events, sessionId)
    const [native] = await a.d.sessionPort.list(sessionId)
    const own = ownRollout(sessionId)
    mkdirSync(dirname(own), { recursive: true })
    writeFileSync(own, readFileSync(native!.path))
    bumpTurns(own, 5)
    a.d.kill()
    const b = make()
    await b.d.loadSession(sessionId, otherCwd)
    expect(await prior(b.d, b.events, sessionId)).toBe(5)
  })
})

describe.each(['pi', 'omp'] as const)('%s', (dialect) => {
  const make = () =>
    track(
      new RpcAgentDriver(
        { id: dialect, label: dialect, command: fake('pi-rpc.mjs'), driver: dialect, env: { FAKE_PI_HOME: join(root, 'pi-home'), ...(dialect === 'omp' ? { FAKE_PI_DIALECT: 'omp' } : {}) } },
        dialect,
      ),
    )
  /** 端口列出来的记录（pi = 唯一的文件，omp = 会话目录顶层的 .jsonl） */
  const record = async (d: RpcAgentDriver, sessionId: string): Promise<string> => {
    const files = await d.sessionPort.list(sessionId)
    const f = files.find((x) => x.name === 'main.jsonl' || /^dir\/[^/]+\.jsonl$/.test(x.name))
    if (!f) throw new Error('没有记录')
    return f.path
  }

  test('端口找到的就是驱动交给 CLI 的记录位置；close 之后 load 从磁盘重读', async () => {
    const { d, events } = make()
    const { sessionId } = await d.newSession(cwd)
    expect(await prior(d, events, sessionId)).toBe(0)
    const file = await record(d, sessionId)
    expect(file.startsWith(d.sessionLocation(sessionId)!)).toBe(true)
    bumpTurns(file, 6)
    await d.closeSession(sessionId)
    expect(d.sessionLocation(sessionId)).toBeUndefined()
    await d.loadSession(sessionId, cwd)
    expect(await prior(d, events, sessionId)).toBe(6)
  })

  test('记录首行的工作目录是别的机器的：afterImport 改成目标工作目录后才能在这里接上', async () => {
    const { d, events } = make()
    const { sessionId } = await d.newSession(cwd)
    await prior(d, events, sessionId)
    await d.closeSession(sessionId)
    const file = await record(d, sessionId)
    // 别的机器上的路径（这台机器上不存在）
    const lines = readFileSync(file, 'utf8').split('\n')
    writeFileSync(file, [JSON.stringify({ ...JSON.parse(lines[0]!), cwd: '/no/such/machine-x/dir' }), ...lines.slice(1)].join('\n'))
    await expect(d.loadSession(sessionId, otherCwd)).rejects.toThrow()
    await d.closeSession(sessionId)
    await d.sessionPort.afterImport!(sessionId, otherCwd)
    await d.loadSession(sessionId, otherCwd)
    expect(await prior(d, events, sessionId)).toBe(1)
    events.length = 0
    await d.prompt(sessionId, text('报目录'))
    expect(said(events)).toContain(`cwd:${otherCwd}`)
  })
})
