/* ---------- 中心拉会话记录的增量判定（不连库：假库 + 假 hub）----------
 * 假库只认 session-copies.ts / machine-access.ts 用到的几条语句，行放在内存里；假 hub 照真 connector 的形状应答 session-stat / session-read。
 * 测：首次整份、追加后只拉新增、被重写后整份重拉、机器上删掉的文件、换会话删旧副本、>1MB 分块、读到一半文件变短不收、
 * 不能同步的机器（不是主人 / 老 connector / 不支持的工具）一个帧都不发。带库的全流程在 session-move.test.ts。
 */
import { afterAll, beforeEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { Conn, ConnectorHub } from './hub.js'
import type { CenterMsg, ConnMsg } from './protocol.js'
import { copyPath } from './session-copies.js'
import { SessionSync, type SyncTarget } from './session-sync.js'
import { SESSION_CAP, SESSION_CHUNK_BYTES, TAIL_BYTES } from './session-types.js'

const uploads = mkdtempSync(join(tmpdir(), 'session-sync-'))
process.env.UPLOAD_DIR = uploads
afterAll(() => rmSync(uploads, { recursive: true, force: true }))

type Row = { page_id: string; tool: string; session_id: string; name: string; size: string; tail_hash: string }

/** 只认这几条语句的假库 */
function fakePool(rows: Row[]): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    const p = params.map(String)
    if (sql.includes('FROM connectors c WHERE c.id = $3')) return { rows: [{}], rowCount: 1 } // 可用（主人）
    if (sql.startsWith('SELECT session_id, name, size, tail_hash FROM agent_session_files')) {
      return { rows: rows.filter((r) => r.page_id === p[0] && r.tool === p[1]), rowCount: 0 }
    }
    if (sql.startsWith('INSERT INTO agent_session_files')) {
      const i = rows.findIndex((r) => r.page_id === p[0] && r.tool === p[1] && r.name === p[3])
      const row = { page_id: p[0]!, tool: p[1]!, session_id: p[2]!, name: p[3]!, size: p[4]!, tail_hash: p[5]! }
      if (i >= 0) rows[i] = row
      else rows.push(row)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('session_id <> $3')) {
      const gone = rows.filter((r) => r.page_id === p[0] && r.tool === p[1] && r.session_id !== p[2])
      for (const g of gone) rows.splice(rows.indexOf(g), 1)
      return { rows: gone.map((g) => ({ session_id: g.session_id })), rowCount: gone.length }
    }
    if (sql.startsWith('DELETE FROM agent_session_files WHERE page_id = $1 AND tool = $2 AND name = $3')) {
      const i = rows.findIndex((r) => r.page_id === p[0] && r.tool === p[1] && r.name === p[2])
      if (i >= 0) rows.splice(i, 1)
      return { rows: [], rowCount: i >= 0 ? 1 : 0 }
    }
    throw new Error(`假库不认这条语句：${sql}`)
  }
  return { query } as unknown as Pool
}

/** 假 hub：一台机器，会话文件在内存里；frames 记下全部下行帧 */
function fakeHub(conn: Partial<Conn>, files: Map<string, Map<string, Buffer>>, frames: CenterMsg[]): ConnectorHub {
  const full: Conn = { id: 'X', name: 'xbox', ownerId: 'alice', caps: [SESSION_CAP], agents: [{ id: 'claude', label: 'Claude', driver: 'claude' }], ...conn } as Conn
  const answer = (msg: CenterMsg): ConnMsg => {
    if (msg.t === 'session-stat') {
      const map = files.get(msg.sessionId)
      if (!map) return { t: 'err', rid: msg.rid, message: '本机没有这个会话的记录' }
      const known = new Map(msg.known.map((k) => [k.name, k.size]))
      const list = [...map].map(([name, buf]) => {
        const k = known.get(name)
        return { name, size: buf.length, tailHash: k !== undefined && buf.length >= k ? createHash('sha256').update(buf.subarray(Math.max(0, k - TAIL_BYTES), k)).digest('hex') : null }
      })
      return { t: 'res', rid: msg.rid, session: { op: 'session-stat', files: list } }
    }
    if (msg.t === 'session-read') {
      const buf = files.get(msg.sessionId)?.get(msg.name) ?? Buffer.alloc(0)
      const chunk = buf.subarray(msg.offset, msg.offset + SESSION_CHUNK_BYTES)
      return { t: 'res', rid: msg.rid, session: { op: 'session-read', data: chunk.toString('base64'), size: buf.length, eof: msg.offset + chunk.length >= buf.length } }
    }
    throw new Error(`假 hub 不认 ${msg.t}`)
  }
  let n = 0
  return {
    get: (id: string) => (id === full.id ? full : undefined),
    request: async (pass: { userId: string }, build: (rid: string, actor: string) => CenterMsg) => {
      const msg = build(`r${++n}`, pass.userId)
      frames.push(msg)
      return answer(msg)
    },
  } as unknown as ConnectorHub
}

let rows: Row[]
let files: Map<string, Map<string, Buffer>>
let frames: CenterMsg[]
const T: SyncTarget = { pageId: 'page-1', connectorId: 'X', agentId: 'claude', sessionId: 'S1', userId: 'alice' }
const center = (sessionId = 'S1', name = 'main.jsonl') => readFile(copyPath('page-1', 'claude', sessionId, name))
const readOffsets = () => frames.filter((f) => f.t === 'session-read').map((f) => (f.t === 'session-read' ? f.offset : -1))
const setFile = (sessionId: string, name: string, buf: Buffer) => {
  let map = files.get(sessionId)
  if (!map) files.set(sessionId, (map = new Map()))
  map.set(name, buf)
}

beforeEach(() => {
  rows = []
  files = new Map()
  frames = []
})

function sync(conn: Partial<Conn> = {}): SessionSync {
  return new SessionSync(fakePool(rows), fakeHub(conn, files, frames))
}

test('首次整份；追加后只拉新增；重写后整份重拉', async () => {
  const s = sync()
  setFile('S1', 'main.jsonl', Buffer.from('line-1\n'))
  expect(await s.pull(T)).toBe(true)
  expect((await center()).toString()).toBe('line-1\n')
  expect(readOffsets()).toEqual([0])

  setFile('S1', 'main.jsonl', Buffer.from('line-1\nline-2\n'))
  frames.length = 0
  await s.pull(T)
  expect(readOffsets()).toEqual([7])
  expect((await center()).toString()).toBe('line-1\nline-2\n')
  expect(rows[0]).toMatchObject({ session_id: 'S1', size: '14' })

  // 一样长、没变：不读
  frames.length = 0
  await s.pull(T)
  expect(readOffsets()).toEqual([])

  // 前缀变了（整个重写）：从 0 重拉
  setFile('S1', 'main.jsonl', Buffer.from('LINE-1\nline-2\nline-3\n'))
  frames.length = 0
  await s.pull(T)
  expect(readOffsets()).toEqual([0])
  expect((await center()).toString()).toBe('LINE-1\nline-2\nline-3\n')
})

test('追加到一半断了的尾巴不算数：下一次从行里记的长度接着拉', async () => {
  const s = sync()
  setFile('S1', 'main.jsonl', Buffer.from('a\n'))
  await s.pull(T)
  // 盘上被多写了一截（上次追加没走到改行那一步）
  const { appendFile } = await import('node:fs/promises')
  await appendFile(copyPath('page-1', 'claude', 'S1', 'main.jsonl'), 'garbage')
  setFile('S1', 'main.jsonl', Buffer.from('a\nb\n'))
  await s.pull(T)
  expect((await center()).toString()).toBe('a\nb\n')
})

test('机器上没了的文件删掉；换了会话删旧会话的行与目录', async () => {
  const s = sync()
  setFile('S1', 'main.jsonl', Buffer.from('x\n'))
  setFile('S1', 'sub/agent-1.jsonl', Buffer.from('sub\n'))
  await s.pull(T)
  expect(rows.map((r) => r.name).sort()).toEqual(['main.jsonl', 'sub/agent-1.jsonl'])
  files.get('S1')!.delete('sub/agent-1.jsonl')
  await s.pull(T)
  expect(rows.map((r) => r.name)).toEqual(['main.jsonl'])
  expect(await stat(copyPath('page-1', 'claude', 'S1', 'sub/agent-1.jsonl')).catch(() => null)).toBeNull()

  setFile('S2', 'main.jsonl', Buffer.from('new\n'))
  await s.pull({ ...T, sessionId: 'S2' })
  expect(rows.map((r) => r.session_id)).toEqual(['S2'])
  expect(await stat(join(copyPath('page-1', 'claude', 'S1', 'main.jsonl'), '..')).catch(() => null)).toBeNull()
  expect((await center('S2')).toString()).toBe('new\n')
})

test('超过 1MB 分块读，中心拼回原样', async () => {
  const s = sync()
  const big = Buffer.alloc(SESSION_CHUNK_BYTES * 2 + 123, 0x62)
  setFile('S1', 'main.jsonl', big)
  await s.pull(T)
  expect(readOffsets()).toEqual([0, SESSION_CHUNK_BYTES, SESSION_CHUNK_BYTES * 2])
  expect((await center()).equals(big)).toBe(true)
})

test('读到一半文件变短：这次不收，原来那份不动', async () => {
  const s = sync()
  setFile('S1', 'main.jsonl', Buffer.from('keep\n'))
  await s.pull(T)
  const hub = fakeHub({}, files, frames)
  // stat 报的长度比真读得到的长（读的过程中被截短了）
  const lying = {
    ...hub,
    get: hub.get,
    request: async (pass: { userId: string }, build: (rid: string, actor: string) => CenterMsg) => {
      const res = (await hub.request(pass as never, build as never)) as ConnMsg
      if (res.t === 'res' && res.session?.op === 'session-stat') res.session.files = res.session.files.map((f) => ({ ...f, size: f.size + 100, tailHash: null }))
      return res
    },
  } as unknown as ConnectorHub
  const s2 = new SessionSync(fakePool(rows), lying)
  await expect(s2.pull(T)).rejects.toThrow(/读到/)
  expect((await center()).toString()).toBe('keep\n')
  expect(rows[0]?.size).toBe('5')
  void s
})

test('不能同步的机器一个帧都不发：不是主人 / 老 connector / 不支持的工具', async () => {
  setFile('S1', 'main.jsonl', Buffer.from('x\n'))
  expect(await sync({ ownerId: 'bob' }).pull(T)).toBe(false)
  expect(await sync({ caps: ['project'] }).pull(T)).toBe(false)
  expect(await sync({ agents: [{ id: 'claude', label: 'Claude', driver: 'acp' }] }).pull(T)).toBe(false)
  expect(frames).toEqual([])
  expect(sync({ caps: ['project'] }).movable('X', 'claude', 'alice')).toEqual({ reason: 'xbox 上的 connector 版本太旧' })
})

test('同一页的同步串行：后一个等前一个做完', async () => {
  const s = sync()
  const order: string[] = []
  const slow = s.enqueue('page-1', async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push('a')
  })
  const drained = s.drain('page-1').then(() => order.push('drain'))
  await Promise.all([slow, drained])
  expect(order).toEqual(['a', 'drain'])
})
