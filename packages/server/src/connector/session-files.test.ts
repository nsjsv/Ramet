/* ---------- connector 侧的会话文件帧：只认主人、tailHash、分块读、分块写的原子性、blob 跳过、在跑的会话不许动 ----------
 * 适配器用桩（只有会话端口 / running / closeSession），端口用真的 pi / omp 端口指到临时目录。不连库。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'
import type { DriverBase } from '../agents/drivers/base.js'
import { ompSessionPort, piSessionPort } from '../agents/drivers/pi/session-port.js'
import type { SessionPort } from '../agents/drivers/session-port.js'
import type { SessionMsg } from '../agents/protocol.js'
import { SESSION_CHUNK_BYTES, tailHashAt, TAIL_BYTES, type SessionReply } from '../agents/session-types.js'
import { SessionDenied, SessionFiles } from './session-files.js'

const root = mkdtempSync(join(tmpdir(), 'session-files-test-'))
const sessions = join(root, 'sessions')
process.env.RAMET_SESSIONS_DIR = sessions
const blobs = join(root, 'omp-agent')
const cwd = join(root, 'work')
mkdirSync(cwd, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ID = '3f2b1c9e-0000-4000-8000-0000000000aa'
const OWNER = 'owner-1'

type Stub = { sessionPort?: SessionPort; busy: Set<string>; closed: string[] }
let stubs: Map<string, Stub>
let files: SessionFiles

function stub(port: SessionPort | undefined): Stub {
  return { sessionPort: port, busy: new Set(), closed: [] }
}
const asDriver = (s: Stub) =>
  ({
    sessionPort: s.sessionPort,
    running: (id: string) => s.busy.has(id),
    closeSession: async (id: string) => void s.closed.push(id),
  }) as unknown as DriverBase

beforeEach(() => {
  rmSync(sessions, { recursive: true, force: true })
  rmSync(blobs, { recursive: true, force: true })
  stubs = new Map([
    ['pi', stub(piSessionPort())],
    ['omp', stub(ompSessionPort({ OMP_CODING_AGENT_DIR: blobs }))],
    ['acp', stub(undefined)],
  ])
  files = new SessionFiles({
    adapter: (id) => asDriver(stubs.get(id) ?? stub(undefined)),
    existing: (id) => (stubs.has(id) ? asDriver(stubs.get(id)!) : undefined),
    isOwner: (actor) => actor === OWNER,
    log: () => undefined,
    writeIdleMs: 200,
  })
})

const piFile = () => join(sessions, 'pi', `${ID}.jsonl`)
const base = { rid: 'r1', actor: OWNER, sessionId: ID }
/** 按帧类型分别去掉公共字段（Omit 直接作用在联合类型上会丢掉各成员自己的字段） */
type Frame = SessionMsg extends infer M ? (M extends SessionMsg ? Omit<M, 'rid' | 'actor' | 'sessionId'> & { actor?: string; sessionId?: string } : never) : never
const handle = (msg: Frame): Promise<SessionReply> => files.handle({ ...base, ...msg } as SessionMsg)
const tempFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('.ramet-import-')) : [])

function writeFrames(name: string, content: Buffer, agent = 'pi', chunk = SESSION_CHUNK_BYTES) {
  const out: Array<Extract<SessionMsg, { t: 'session-write' }>> = []
  for (let off = 0; off < content.length || off === 0; off += chunk) {
    const part = content.subarray(off, off + chunk)
    out.push({ t: 'session-write', ...base, agent, cwd, name, offset: off, data: part.toString('base64'), last: off + chunk >= content.length, size: content.length })
    if (content.length === 0) break
  }
  return out
}

test('只认机器主人：别人（哪怕有 machine 范围）一律 SessionDenied；会话 id 不合法、agent 没有端口都拒绝', async () => {
  mkdirSync(join(sessions, 'pi'), { recursive: true })
  writeFileSync(piFile(), 'x\n')
  await expect(handle({ t: 'session-stat', agent: 'pi', known: [], actor: 'grantee' })).rejects.toBeInstanceOf(SessionDenied)
  await expect(handle({ t: 'session-close', agent: 'pi', actor: 'grantee' })).rejects.toBeInstanceOf(SessionDenied)
  await expect(handle({ t: 'session-stat', agent: 'pi', known: [], sessionId: '../etc' })).rejects.toThrow(/会话 id/)
  await expect(handle({ t: 'session-stat', agent: 'acp', known: [] })).rejects.toThrow(/不支持搬会话/)
  await expect(handle({ t: 'session-stat', agent: 'pi', known: [], sessionId: 'nope' })).rejects.toThrow(/没有这个会话/)
})

test('stat：tailHash 按中心已有的长度算（只追加 → 与中心那份一致）；中心没有 / 机器上的更短 = null', async () => {
  const before = Buffer.from('h'.repeat(TAIL_BYTES + 100) + '\n')
  mkdirSync(join(sessions, 'pi'), { recursive: true })
  writeFileSync(piFile(), before)
  const centerCopy = join(root, 'center-copy')
  writeFileSync(centerCopy, before)
  writeFileSync(piFile(), Buffer.concat([before, Buffer.from('more\n')]))
  const r = await handle({ t: 'session-stat', agent: 'pi', known: [{ name: 'main.jsonl', size: before.length }] })
  expect(r).toEqual({ op: 'session-stat', files: [{ name: 'main.jsonl', size: before.length + 5, tailHash: await tailHashAt(centerCopy, before.length) }] })
  // 被整个重写过（比中心的短）
  const shorter = await handle({ t: 'session-stat', agent: 'pi', known: [{ name: 'main.jsonl', size: before.length + 1000 }] })
  expect(shorter).toMatchObject({ files: [{ tailHash: null }] })
  const unknown = await handle({ t: 'session-stat', agent: 'pi', known: [] })
  expect(unknown).toMatchObject({ files: [{ tailHash: null }] })
  // 小于 TAIL_BYTES 的前缀：整段的哈希
  writeFileSync(centerCopy, before.subarray(0, 10))
  const small = await handle({ t: 'session-stat', agent: 'pi', known: [{ name: 'main.jsonl', size: 10 }] })
  expect(small).toMatchObject({ files: [{ tailHash: createHash('sha256').update(before.subarray(0, 10)).digest('hex') }] })
  await expect(handle({ t: 'session-stat', agent: 'pi', known: [{ name: 'main.jsonl', size: -1 }] })).rejects.toThrow(/known/)
})

test('read：超过 1MB 的文件分块读回来拼起来一致；只读端口列出来的文件', async () => {
  const content = Buffer.alloc(SESSION_CHUNK_BYTES * 2 + 123, 'x')
  content.write('\nEND', content.length - 4)
  mkdirSync(join(sessions, 'pi'), { recursive: true })
  writeFileSync(piFile(), content)
  const parts: Buffer[] = []
  for (let offset = 0; ; ) {
    const r = await handle({ t: 'session-read', agent: 'pi', name: 'main.jsonl', offset })
    if (r.op !== 'session-read') throw new Error('bad op')
    const part = Buffer.from(r.data, 'base64')
    expect(part.length).toBeLessThanOrEqual(SESSION_CHUNK_BYTES)
    parts.push(part)
    offset += part.length
    if (r.eof) break
  }
  expect(Buffer.concat(parts).equals(content)).toBe(true)
  for (const name of ['../pi/x', '/etc/passwd', 'dir/x', `../../${ID}.jsonl`]) {
    await expect(handle({ t: 'session-read', agent: 'pi', name, offset: 0 })).rejects.toThrow(/没有这个会话文件/)
  }
  await expect(handle({ t: 'session-read', agent: 'pi', name: 'main.jsonl', offset: content.length + 1 })).rejects.toThrow(/offset/)
})

test('write：分块写，写完之前目标不变、只有临时文件；最后一块核对长度后原子换入并改好首行 cwd', async () => {
  mkdirSync(join(sessions, 'pi'), { recursive: true })
  writeFileSync(piFile(), 'old\n')
  const header = JSON.stringify({ type: 'session', version: 3, id: ID, cwd: '/machine-x' }) + '\n'
  const content = Buffer.concat([Buffer.from(header), Buffer.alloc(SESSION_CHUNK_BYTES + 10, 'y'), Buffer.from('\n')])
  const frames = writeFrames('main.jsonl', content)
  expect(frames.length).toBe(2)
  expect(await files.handle(frames[0]!)).toEqual({ op: 'session-write' })
  expect(readFileSync(piFile(), 'utf8')).toBe('old\n')
  expect(tempFiles(join(sessions, 'pi')).length).toBe(1)
  expect(await files.handle(frames[1]!)).toEqual({ op: 'session-write' })
  expect(tempFiles(join(sessions, 'pi'))).toEqual([])
  const written = readFileSync(piFile())
  const nl = written.indexOf(0x0a)
  expect(JSON.parse(written.subarray(0, nl).toString())).toMatchObject({ cwd })
  expect(written.subarray(nl).equals(content.subarray(header.length - 1))).toBe(true)
})

test('write 中途失败不留半截：顺序不对 / 长度不符 / 超出声明长度都删掉临时文件，目标不变', async () => {
  mkdirSync(join(sessions, 'pi'), { recursive: true })
  writeFileSync(piFile(), 'old\n')
  const content = Buffer.alloc(SESSION_CHUNK_BYTES + 10, 'z')
  const [first, second] = writeFrames('main.jsonl', content)
  // 跳块
  await files.handle(first!)
  await expect(files.handle({ ...second!, offset: second!.offset + 1 })).rejects.toThrow(/顺序/)
  expect(tempFiles(join(sessions, 'pi'))).toEqual([])
  // 没从 0 开始
  await expect(files.handle(second!)).rejects.toThrow(/顺序/)
  // 最后一块长度对不上
  await expect(files.handle({ ...writeFrames('main.jsonl', Buffer.from('abc'))[0]!, size: 4 })).rejects.toThrow(/长度不符/)
  // 超出声明长度
  await expect(files.handle({ ...writeFrames('main.jsonl', Buffer.from('abcdef'))[0]!, size: 3 })).rejects.toThrow(/超出/)
  expect(tempFiles(join(sessions, 'pi'))).toEqual([])
  expect(readFileSync(piFile(), 'utf8')).toBe('old\n')
})

test('write：太久没有下一块，临时文件被删掉', async () => {
  const [first] = writeFrames('main.jsonl', Buffer.alloc(SESSION_CHUNK_BYTES + 10, 'q'))
  await files.handle(first!)
  expect(tempFiles(join(sessions, 'pi')).length).toBe(1)
  await new Promise((r) => setTimeout(r, 400))
  expect(tempFiles(join(sessions, 'pi'))).toEqual([])
  expect(existsSync(piFile())).toBe(false)
})

test('write：不认的 name / 穿越一律拒绝，会话目录外不会多出文件', async () => {
  for (const name of ['../evil.jsonl', '/tmp/evil', 'dir/x', `../../../${ID}`, 'main.jsonl/../x']) {
    await expect(files.handle(writeFrames(name, Buffer.from('evil'))[0]!)).rejects.toThrow(/不认识/)
  }
  for (const name of ['dir/../../evil', 'dir/', 'blobs/../../evil', 'blobs/zz']) {
    await expect(files.handle(writeFrames(name, Buffer.from('evil'), 'omp')[0]!)).rejects.toThrow(/不认识/)
  }
  expect(existsSync(join(sessions, 'evil.jsonl'))).toBe(false)
  expect(existsSync(join(root, 'evil'))).toBe(false)
  await expect(files.handle({ ...writeFrames('main.jsonl', Buffer.from('x'))[0]!, cwd: '' })).rejects.toThrow(/工作目录/)
})

test('omp 的 blob：目标机器已有且哈希一致就跳过；写进来的内容与哈希不符拒绝', async () => {
  const blob = Buffer.from('image-bytes')
  const hash = createHash('sha256').update(blob).digest('hex')
  expect(await files.handle(writeFrames(`blobs/${hash}`, blob, 'omp')[0]!)).toEqual({ op: 'session-write' })
  expect(readFileSync(join(blobs, 'blobs', hash)).equals(blob)).toBe(true)
  expect(await files.handle(writeFrames(`blobs/${hash}`, blob, 'omp')[0]!)).toEqual({ op: 'session-write', skipped: true })
  const wrong = 'e'.repeat(64)
  await expect(files.handle(writeFrames(`blobs/${wrong}`, blob, 'omp')[0]!)).rejects.toThrow(/哈希/)
  expect(existsSync(join(blobs, 'blobs', wrong))).toBe(false)
  expect(tempFiles(join(blobs, 'blobs'))).toEqual([])
})

test('在跑一轮的会话不许关、不许写；close 交给驱动的 closeSession，没建过适配器 = 无事可做', async () => {
  const pi = stubs.get('pi')!
  pi.busy.add(ID)
  await expect(handle({ t: 'session-close', agent: 'pi' })).rejects.toThrow(/正在运行/)
  await expect(files.handle(writeFrames('main.jsonl', Buffer.from('x'))[0]!)).rejects.toThrow(/正在运行/)
  expect(existsSync(piFile())).toBe(false)
  pi.busy.delete(ID)
  expect(await handle({ t: 'session-close', agent: 'pi' })).toEqual({ op: 'session-close' })
  expect(pi.closed).toEqual([ID])
  expect(await handle({ t: 'session-close', agent: 'never-built' })).toEqual({ op: 'session-close' })
})
