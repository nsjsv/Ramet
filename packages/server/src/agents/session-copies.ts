// ---------- 中心存的原生会话记录副本（换机器搬会话用）----------
// 同一个工具从机器 X 换到机器 Y 时，会话记录以中心这份为准：每轮从跑它的机器增量拉过来（session-sync.ts），
// 换机器时从这里写到目标机器（session-move.ts）。一页一个工具只留当前会话这一份。
// 盘上：<UPLOAD_DIR>/agent-sessions/<pageId>/<工具名哈希>/<sessionId>/<文件名哈希>。文件名（name）是 connector 上
// 会话端口定义的不透明相对名，这里只当键，落盘一律用它的哈希：中心不解析 name，也就不可能被它带到别的目录。
// 这不是版本内容，不受「上传文件永不删除」约束：换了会话删旧的，页面物理删除时整页目录一起删。
// 库里一行一个文件（agent_session_files）：size = 已收到的字节数，盘上文件可能更长（追加到一半断了），读写都以行为准。

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { uploadDir } from '../uploads.js'
import { tailHashAt, validSessionId } from './session-types.js'

/** 一个会话文件在中心的记录 */
export type CopyFile = { name: string; size: number; tailHash: string }

const PAGE_ID = /^[A-Za-z0-9-]{1,64}$/
/** name 由 connector 给，只做形状上的兜底：中心只拿它当键与哈希的输入 */
const MAX_NAME = 1024

const SELECT_FILES = `SELECT session_id, name, size, tail_hash FROM agent_session_files WHERE page_id = $1 AND tool = $2`
const UPSERT_FILE = `INSERT INTO agent_session_files (page_id, tool, session_id, name, size, tail_hash)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (page_id, tool, name) DO UPDATE SET session_id = EXCLUDED.session_id, size = EXCLUDED.size,
    tail_hash = EXCLUDED.tail_hash, updated_at = now()::text`
const DELETE_FILE = `DELETE FROM agent_session_files WHERE page_id = $1 AND tool = $2 AND name = $3`
const DELETE_OTHER_SESSIONS = `DELETE FROM agent_session_files WHERE page_id = $1 AND tool = $2 AND session_id <> $3
  RETURNING session_id`

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

export function validCopyName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME && !name.includes('\0')
}

function copiesRoot(): string {
  return join(uploadDir(), 'agent-sessions')
}

function pageDir(pageId: string): string {
  if (!PAGE_ID.test(pageId)) throw new Error('页面 id 不合法')
  return join(copiesRoot(), pageId)
}

function sessionDir(pageId: string, tool: string, sessionId: string): string {
  if (!validSessionId(sessionId)) throw new Error('会话 id 不合法')
  return join(pageDir(pageId), sha(tool).slice(0, 32), sessionId)
}

/** 这个文件在中心盘上的位置 */
export function copyPath(pageId: string, tool: string, sessionId: string, name: string): string {
  if (!validCopyName(name)) throw new Error('会话文件名不合法')
  return join(sessionDir(pageId, tool, sessionId), sha(name))
}

/** 中心手里这一页这个工具的会话副本（只认 sessionId 这个会话、且盘上真有那么多字节的文件）。
 *  盘上缺了 / 短了的行（中心盘被清过、删页时事务回滚了）当作没有，顺手删掉：下一次同步整份重拉 */
export async function copyFiles(pool: Pool, pageId: string, tool: string, sessionId: string): Promise<CopyFile[]> {
  const { rows } = await pool.query<{ session_id: string; name: string; size: string; tail_hash: string }>(SELECT_FILES, [pageId, tool])
  const out: CopyFile[] = []
  for (const r of rows) {
    if (r.session_id !== sessionId) continue
    const size = Number(r.size)
    const st = await stat(copyPath(pageId, tool, sessionId, r.name)).catch(() => null)
    if (st?.isFile() && st.size >= size) out.push({ name: r.name, size, tailHash: r.tail_hash })
    else await pool.query(DELETE_FILE, [pageId, tool, r.name])
  }
  return out
}

/** 记下（或改写）一个文件收到了多少 */
export async function saveCopyFile(pool: Pool, pageId: string, tool: string, sessionId: string, file: CopyFile): Promise<void> {
  await pool.query(UPSERT_FILE, [pageId, tool, sessionId, file.name, file.size, file.tailHash])
}

/** 机器上已经没有这个文件了：行与盘上的文件一起删 */
export async function dropCopyFile(pool: Pool, pageId: string, tool: string, sessionId: string, name: string): Promise<void> {
  await pool.query(DELETE_FILE, [pageId, tool, name])
  await rm(copyPath(pageId, tool, sessionId, name), { force: true })
}

/** 这一页这个工具换成了别的会话：旧会话的行与目录都删（一页一个工具只留当前会话） */
export async function dropOtherSessions(pool: Pool, pageId: string, tool: string, keep: string): Promise<void> {
  const { rows } = await pool.query<{ session_id: string }>(DELETE_OTHER_SESSIONS, [pageId, tool, keep])
  for (const sessionId of new Set(rows.map((r) => r.session_id))) {
    if (!validSessionId(sessionId)) continue
    await rm(sessionDir(pageId, tool, sessionId), { recursive: true, force: true })
  }
}

/** 页面物理删除：整页的会话副本目录一起删（库里的行随页面外键级联）。只记日志不抛：删不掉不能挡住删页 */
export async function dropPageCopies(pageIds: readonly string[]): Promise<void> {
  for (const id of pageIds) {
    if (!PAGE_ID.test(id)) continue
    await rm(pageDir(id), { recursive: true, force: true }).catch((err: unknown) =>
      console.error(`[session-copies] 删除页面 ${id} 的会话副本失败`, err),
    )
  }
}

/** 往中心写一个文件。from = 0：整份重写，先写同目录临时文件，commit 时换进去；
 *  from > 0：接着已收到的部分追加（先截到 from：上次追加到一半断了的尾巴不要）。
 *  commit 返回新的长度与尾巴哈希，调用方据此改库里的行（行改了才算数） */
export class CopyWriter {
  private written: number

  private constructor(
    private readonly fh: FileHandle,
    private readonly path: string,
    private readonly tmp: string | null,
    from: number,
  ) {
    this.written = from
  }

  static async open(path: string, from: number): Promise<CopyWriter> {
    const dir = join(path, '..')
    await mkdir(dir, { recursive: true })
    if (from === 0) {
      const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
      return new CopyWriter(await open(tmp, 'wx', 0o600), path, tmp, 0)
    }
    const fh = await open(path, 'r+')
    await fh.truncate(from)
    return new CopyWriter(fh, path, null, from)
  }

  get size(): number {
    return this.written
  }

  async write(buf: Buffer): Promise<void> {
    let off = 0
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.written + off)
      off += bytesWritten
    }
    this.written += buf.length
  }

  async commit(): Promise<{ size: number; tailHash: string }> {
    await this.fh.sync()
    await this.fh.close()
    if (this.tmp) await rename(this.tmp, this.path)
    return { size: this.written, tailHash: await tailHashAt(this.path, this.written) }
  }

  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined)
    if (this.tmp) await unlink(this.tmp).catch(() => undefined)
  }
}

/** 从中心的副本读 [offset, offset + length)（读下发用的块）。短了就报错：行说有这么多字节 */
export async function readCopy(path: string, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const fh = await open(path, 'r')
  try {
    let got = 0
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got)
      if (bytesRead === 0) throw new Error('中心的会话副本比记录的短')
      got += bytesRead
    }
  } finally {
    await fh.close()
  }
  return buf
}
