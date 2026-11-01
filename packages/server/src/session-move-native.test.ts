/* ---------- 换机器搬会话的端到端：四家原生驱动（假 CLI）跨两台子进程 connector ----------
 * 两台机器各是一个真 connector 子进程，家目录、Ramet 会话目录、默认工作目录都分开（像两台电脑）。
 * 每家一页：在 X 上跑一轮 → 关掉 X（SIGKILL）→ 换到 Y 问「报会话」：Y 用的是同一个会话 id、从记录里恢复（prior = X 跑过的轮数）
 * → 重启 X 再换回来：X 先关掉旧会话再写入，接着的是包含 Y 那一轮的最新记录。
 * 中心侧的判定与退回在 session-move.test.ts（脚本化机器）。
 */
import { machineAgents } from './session-move-native-env.js'
import { afterEach, expect, test } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  addPage,
  agentSession,
  agentsList,
  base,
  connectDoc,
  continuePage,
  docText,
  pageOwnership,
  pool,
  settled,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'
import { provisionConnector } from './test-helpers.js'

process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'ramet-move-native-uploads-'))
// 中心给 connector 上的 agent 签读页凭证时要知道自己的对外地址（connector 没有回环回落）
process.env.RAMET_PUBLIC_URL = base

const CONNECTOR_CLI = fileURLToPath(new URL('./connector/cli.ts', import.meta.url))
const TOOLS = ['claude', 'codex', 'pi', 'omp'] as const

const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
})

type Box = { id: string; name: string; dir: string; tokenFile: string; child: ChildProcess | null }

/** 起（或重启）一台机器：connector 子进程，自己的 agent 家目录与会话目录 */
async function boot(box: Box, cookie: string): Promise<void> {
  const logs: string[] = []
  const work = join(box.dir, 'work')
  mkdirSync(work, { recursive: true })
  // 进程 cwd 留在仓库里：`--import tsx` 按 cwd 解析包，放到临时目录就找不到 tsx；agent 的工作区由 --cwd 指定
  const child = spawn(process.execPath, ['--import', 'tsx', CONNECTOR_CLI, '--cloud', base, '--name', box.name, '--token-file', box.tokenFile, '--cwd', work], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAMET_AGENTS: JSON.stringify(machineAgents(join(box.dir, 'home'))),
      RAMET_SESSIONS_DIR: join(box.dir, 'sessions'),
      RAMET_PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (b: Buffer) => logs.push(b.toString()))
  child.stderr?.on('data', (b: Buffer) => logs.push(b.toString()))
  children.push(child)
  box.child = child
  try {
    await waitFor(async () => {
      const ids = new Set((await agentsList(cookie)).map((a) => a.id))
      return TOOLS.every((t) => ids.has(`c:${box.id}:${t}`))
    }, 40_000)
  } catch (err) {
    throw new Error(`${box.name} 没连上：${String(err)}\n${logs.join('')}`)
  }
}

async function machine(spaceId: string, ownerId: string, name: string, cookie: string): Promise<Box> {
  const dir = mkdtempSync(join(tmpdir(), `ramet-move-${name}-`))
  const tokenFile = join(dir, 'connector.json')
  const { connectorId } = await provisionConnector(pool, { spaceId, ownerId, name, cloud: base, tokenFile })
  const box: Box = { id: connectorId, name, dir, tokenFile, child: null }
  await boot(box, cookie)
  return box
}

async function stopBox(box: Box, cookie: string): Promise<void> {
  box.child?.kill('SIGKILL')
  box.child = null
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id.startsWith(`c:${box.id}:`)), 20_000)
}

type Lane = { tool: (typeof TOOLS)[number]; pageId: string; a: HocuspocusProvider; sse: SSECollector; turns: number }

async function send(lane: Lane, cookie: string, box: Box, text: string): Promise<void> {
  userMessage(lane.a.document, text)
  expect(await continuePage(lane.pageId, cookie, { agent: `c:${box.id}:${lane.tool}` })).toBe(202)
  lane.turns += 1
  await settled(lane.sse, lane.turns)
  // 这一轮失败时把原因带出来，否则后面的断言只看得到一块空回复
  const failure = lane.sse.events.filter((e) => e.type === 'error').at(-1)
  if (failure && failure.type === 'error') throw new Error(`${lane.tool} 在 ${box.name} 上这一轮失败：${failure.message}`)
}

/** 中心手里有这一页这个会话的副本了（X 的那一轮收尾后同步完） */
async function copied(pageId: string, sessionId: string): Promise<void> {
  await waitFor(async () => {
    const { rows } = await pool.query('SELECT 1 FROM agent_session_files WHERE page_id = $1 AND session_id = $2', [pageId, sessionId])
    return rows.length > 0
  }, 20_000)
}

test('claude / codex / pi / omp：X 上跑一轮，关掉 X 换到 Y 接着同一个会话；重启 X 再换回来接着包含 Y 那一轮的记录', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const x = await machine(spaceId, ownerId, 'xbox', cookie)
  const y = await machine(spaceId, ownerId, 'ybox', cookie)

  const lanes: Lane[] = []
  for (const tool of TOOLS) {
    const id = lanes.length === 0 ? pageId : await addPage(pageId, cookie)
    const a = await connectDoc(id, cookie)
    const sse = new SSECollector()
    await sse.start(id, cookie)
    lanes.push({ tool, pageId: id, a, sse, turns: 0 })
  }

  const sessions = new Map<string, string>()
  for (const lane of lanes) {
    await send(lane, cookie, x, '你好')
    const sid = (await agentSession(lane.pageId))?.[`c:${x.id}:${lane.tool}`]?.sessionId
    expect(sid, `${lane.tool} 在 X 上没有留下会话记录：\n${docText(lane.a)}`).toBeTruthy()
    sessions.set(lane.tool, sid!)
    await copied(lane.pageId, sid!)
  }

  await stopBox(x, cookie)
  for (const lane of lanes) {
    const sid = sessions.get(lane.tool)!
    await send(lane, cookie, y, '报会话')
    // 从下发的记录里恢复（不是新建）：X 上跑过的一轮还在上下文里
    await waitFor(() => / resumed:(?!no)\S+ prior:1/.test(docText(lane.a)), 20_000).catch(() => {
      throw new Error(`${lane.tool} 在 Y 上没有接上会话：\n${docText(lane.a)}`)
    })
    expect((await agentSession(lane.pageId))?.[`c:${y.id}:${lane.tool}`]?.sessionId, lane.tool).toBe(sid)
  }

  // 重启 X 再换回来：X 上还躺着旧的那份（只有一轮），换回来的必须是 Y 跑过之后的最新记录
  await boot(x, cookie)
  for (const lane of lanes) {
    const sid = sessions.get(lane.tool)!
    await send(lane, cookie, x, '报会话')
    expect((await agentSession(lane.pageId))?.[`c:${x.id}:${lane.tool}`]?.sessionId, lane.tool).toBe(sid)
    await waitFor(() => / resumed:(?!no)\S+ prior:2/.test(docText(lane.a)), 20_000).catch(() => {
      throw new Error(`${lane.tool} 换回 X 没有接上最新的会话：\n${docText(lane.a)}`)
    })
  }
  for (const lane of lanes) {
    lane.sse.stop()
    lane.a.destroy()
  }
}, 240_000)
