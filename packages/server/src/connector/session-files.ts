// ---------- connector 侧的会话文件帧：列出 / 分块读 / 分块写 / 关闭 ----------
// 换机器搬会话时中心对这台机器做的四件事（session-stat / session-read / session-write / session-close，protocol.ts）。
// 中心给的只有 agent / sessionId / cwd / 不透明文件名，真实路径一律经这个 agent 的驱动的会话端口算（drivers/<家>/session-port.ts）：
// 读只能读端口列出来的文件，写只能写到端口按 name 算出的位置，name 不认就拒绝。
// 只认机器主人：会话记录里有工具结果、读过的文件内容，只在接入人自己的机器之间搬（被授权的人即使有 machine 范围也不行）。
// 写入：offset 0 开同目录临时文件，之后每块必须接着上一块写，最后一块核对总长后 fsync + rename 原子换入；
// 任一步失败、或太久没有下一块，删掉临时文件，不留半截。会话正在跑一轮时拒绝关闭与写入（不在 agent 写着的文件上动手）。

import { createHash, type Hash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DriverBase } from '../agents/drivers/base.js'
import { importTempName, realCwd, type SessionFile, type SessionPort } from '../agents/drivers/session-port.js'
import type { SessionMsg } from '../agents/protocol.js'
import {
  SESSION_CHUNK_BYTES,
  SESSION_FILE_MAX_BYTES,
  tailHashAt,
  validSessionId,
  type SessionFileStat,
  type SessionReply,
} from '../agents/session-types.js'

/** 写到一半太久没有下一块：中心那头断了 / 放弃了，临时文件删掉 */
const WRITE_IDLE_MS = 60_000
/** 读取时用的文件清单缓存：omp 列一次要扫整个会话目录与记录里的 blob 引用，分块读不能每块都重扫 */
const LIST_CACHE_MS = 30_000
const MAX_KNOWN = 10_000

/** 被拒绝（不是主人）：中心据 code 'forbidden' 回 403 */
export class SessionDenied extends Error {}

export type SessionFilesDeps = {
  /** 取（必要时建）这个 agent 的适配器：只读它的会话端口，不起进程 */
  adapter: (agentId: string) => DriverBase
  /** 已有的适配器（关闭 / 判断在跑只看已有的：没建过 = 内存里没有这个会话） */
  existing: (agentId: string) => DriverBase | undefined
  isOwner: (actor: string) => boolean
  log: (line: string) => void
  /** 测试注入：写到一半的闲置上限 */
  writeIdleMs?: number
}

type PendingWrite = {
  fh: FileHandle
  tmp: string
  target: string
  written: number
  size: number
  hash: Hash
  expect: string | null
  timer: ReturnType<typeof setTimeout>
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export class SessionFiles {
  private readonly writes = new Map<string, PendingWrite>()
  /** 同一个文件的写入一块接一块（中心本来就等应答再发下一块，这里再兜一层，不让两块交错写） */
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly lists = new Map<string, { files: SessionFile[]; at: number }>()

  constructor(private readonly deps: SessionFilesDeps) {}

  async handle(msg: SessionMsg): Promise<SessionReply> {
    if (!this.deps.isOwner(msg.actor)) throw new SessionDenied('只有机器主人能搬会话')
    if (typeof msg.agent !== 'string' || !validSessionId(msg.sessionId)) throw new Error('会话 id 不合法')
    switch (msg.t) {
      case 'session-stat':
        return this.stat(msg)
      case 'session-read':
        return this.read(msg)
      case 'session-write':
        return this.serial(`${msg.agent}\0${msg.sessionId}\0${String(msg.name)}`, () => this.write(msg))
      case 'session-close':
        return this.close(msg)
    }
  }

  private port(agentId: string): SessionPort {
    const port = this.deps.adapter(agentId).sessionPort
    if (!port) throw new Error(`${agentId} 不支持搬会话`)
    return port
  }

  private async list(agentId: string, sessionId: string, fresh: boolean): Promise<SessionFile[]> {
    const key = `${agentId}\0${sessionId}`
    const cached = this.lists.get(key)
    if (!fresh && cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.files
    const files = await this.port(agentId).list(sessionId)
    this.lists.set(key, { files, at: Date.now() })
    return files
  }

  private async stat(msg: Extract<SessionMsg, { t: 'session-stat' }>): Promise<SessionReply> {
    const known = new Map<string, number>()
    if (!Array.isArray(msg.known) || msg.known.length > MAX_KNOWN) throw new Error('known 不合法')
    for (const k of msg.known) {
      if (!k || typeof k.name !== 'string' || !isCount(k.size)) throw new Error('known 不合法')
      known.set(k.name, k.size)
    }
    const files = await this.list(msg.agent, msg.sessionId, true)
    if (files.length === 0) throw new Error('本机没有这个会话的记录')
    const out: SessionFileStat[] = []
    for (const f of files) {
      const k = known.get(f.name)
      out.push({ name: f.name, size: f.size, tailHash: k !== undefined && f.size >= k ? await tailHashAt(f.path, k) : null })
    }
    return { op: 'session-stat', files: out }
  }

  private async read(msg: Extract<SessionMsg, { t: 'session-read' }>): Promise<SessionReply> {
    if (typeof msg.name !== 'string' || !isCount(msg.offset)) throw new Error('参数不合法')
    // 只读端口列出来的文件：name 先在清单里找，找不到再刷新一次（清单可能是旧的）
    let file = (await this.list(msg.agent, msg.sessionId, false)).find((f) => f.name === msg.name)
    file ??= (await this.list(msg.agent, msg.sessionId, true)).find((f) => f.name === msg.name)
    if (!file) throw new Error('本机没有这个会话文件')
    // O_NOFOLLOW：清单之后末级被换成了符号链接也读不到别处去
    const fh = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new Error('不是普通文件')
      if (msg.offset > st.size) throw new Error('offset 超出文件长度')
      const buf = Buffer.alloc(Math.min(SESSION_CHUNK_BYTES, st.size - msg.offset))
      let got = 0
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, msg.offset + got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      return { op: 'session-read', data: buf.subarray(0, got).toString('base64'), size: st.size, eof: msg.offset + got >= st.size }
    } finally {
      await fh.close()
    }
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.catch(() => undefined)
    this.chains.set(key, settled)
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    return next
  }

  /** 在跑一轮的会话：agent 正往它的记录里写，不能关也不能覆盖 */
  private assertIdle(agentId: string, sessionId: string): void {
    if (this.deps.existing(agentId)?.running(sessionId)) throw new Error('这个会话正在运行，不能改动它的记录')
  }

  private async write(msg: Extract<SessionMsg, { t: 'session-write' }>): Promise<SessionReply> {
    const key = `${msg.agent}\0${msg.sessionId}\0${msg.name}`
    try {
      return await this.writeChunk(key, msg)
    } catch (err) {
      await this.drop(key)
      throw err
    }
  }

  private async writeChunk(key: string, msg: Extract<SessionMsg, { t: 'session-write' }>): Promise<SessionReply> {
    if (typeof msg.name !== 'string' || typeof msg.data !== 'string' || typeof msg.last !== 'boolean') throw new Error('参数不合法')
    if (!isCount(msg.offset) || !isCount(msg.size) || msg.size > SESSION_FILE_MAX_BYTES) throw new Error('长度不合法')
    if (typeof msg.cwd !== 'string' || !msg.cwd || msg.cwd.includes('\0')) throw new Error('工作目录不合法')
    this.assertIdle(msg.agent, msg.sessionId)
    const port = this.port(msg.agent)
    const cwd = await realCwd(msg.cwd)
    const target = port.target(msg.sessionId, cwd, msg.name)
    if (!target) throw new Error(`不认识的会话文件名：${msg.name}`)
    const data = Buffer.from(msg.data, 'base64')
    if (data.length > SESSION_CHUNK_BYTES) throw new Error('单块太大')

    let w = this.writes.get(key)
    if (msg.offset === 0) {
      if (w) await this.drop(key)
      const expect = port.contentHash?.(msg.name) ?? null
      // 内容寻址的文件已经在了、内容一致：不用再写（omp 的 blob 库是全局共享的）
      if (expect && (await sha256Of(target)) === expect) return { op: 'session-write', skipped: true }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const tmp = importTempName(dirname(target))
      const fh = await open(tmp, 'wx', 0o600)
      w = { fh, tmp, target, written: 0, size: msg.size, hash: createHash('sha256'), expect, timer: this.idleTimer(key) }
      this.writes.set(key, w)
    } else {
      if (!w || w.written !== msg.offset || w.target !== target || w.size !== msg.size) throw new Error('写入顺序不对：先从 offset 0 开始，每块接着上一块')
      clearTimeout(w.timer)
      w.timer = this.idleTimer(key)
    }
    if (w.written + data.length > w.size) throw new Error('写入超出声明的长度')
    let off = 0
    while (off < data.length) {
      const { bytesWritten } = await w.fh.write(data, off, data.length - off, w.written + off)
      off += bytesWritten
    }
    w.written += data.length
    w.hash.update(data)
    if (!msg.last) return { op: 'session-write' }

    if (w.written !== w.size) throw new Error(`长度不符：收到 ${w.written} 字节，应为 ${w.size}`)
    if (w.expect && w.hash.digest('hex') !== w.expect) throw new Error('内容与哈希不符')
    // 换入之前再看一眼：写的这段时间里会话不能被跑起来
    this.assertIdle(msg.agent, msg.sessionId)
    clearTimeout(w.timer)
    await w.fh.sync()
    await w.fh.close()
    this.writes.delete(key)
    try {
      await rename(w.tmp, w.target)
    } catch (err) {
      await unlink(w.tmp).catch(() => undefined)
      throw err
    }
    this.lists.delete(`${msg.agent}\0${msg.sessionId}`)
    await port.afterImport?.(msg.sessionId, cwd)
    this.deps.log(`会话文件已写入 agent=${msg.agent} session=${msg.sessionId} ${msg.name}（${w.size} 字节）`)
    return { op: 'session-write' }
  }

  private idleTimer(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.drop(key), this.deps.writeIdleMs ?? WRITE_IDLE_MS)
    timer.unref?.()
    return timer
  }

  /** 丢掉一个写到一半的文件：关句柄、删临时文件 */
  private async drop(key: string): Promise<void> {
    const w = this.writes.get(key)
    if (!w) return
    this.writes.delete(key)
    clearTimeout(w.timer)
    await w.fh.close().catch(() => undefined)
    await unlink(w.tmp).catch(() => undefined)
  }

  private async close(msg: Extract<SessionMsg, { t: 'session-close' }>): Promise<SessionReply> {
    this.assertIdle(msg.agent, msg.sessionId)
    // 没建过适配器 = 这个进程里本来就没有这个会话
    await this.deps.existing(msg.agent)?.closeSession(msg.sessionId)
    this.lists.delete(`${msg.agent}\0${msg.sessionId}`)
    return { op: 'session-close' }
  }

  /** connector 收尾：写到一半的全部丢掉 */
  async dispose(): Promise<void> {
    await Promise.all([...this.writes.keys()].map((k) => this.drop(k)))
  }
}

/** 普通文件的 sha256；不存在 / 不是普通文件 = null */
async function sha256Of(path: string): Promise<string | null> {
  try {
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!(await fh.stat()).isFile()) return null
    } finally {
      await fh.close()
    }
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}
