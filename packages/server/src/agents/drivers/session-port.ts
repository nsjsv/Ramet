// ---------- 会话端口：一个原生驱动的会话记录在本机的哪些文件、搬到本机时写到哪 ----------
// 换机器时会话记录以中心那份为准，中心只认端口定义的不透明文件名（name），真实路径只在 connector 这台机器上由驱动按工具规则算，
// 不收中心给的路径。每家的规则在 drivers/<家>/session-port.ts，文件头写着依据；这里是共用的形状与校验。

import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** path 只留在 connector 进程里，不发给中心 */
export type SessionFile = { name: string; size: number; path: string }

export interface SessionPort {
  /** 这个会话在本机的全部文件。本机没有这个会话 = 空数组 */
  list(sessionId: string): Promise<SessionFile[]>
  /** 下发到本机时这个 name 写到哪（按目标 cwd 算）；null = 不认这个 name。
   *  cwd 由调用方先换成真实路径（realCwd）：CLI 进程里看到的是解开符号链接之后的 cwd，项目目录名 / 记录里的工作目录都按它算 */
  target(sessionId: string, cwd: string, name: string): string | null
  /** 内容寻址的文件（omp 的 blob）：name 对应的 sha256。目标已存在且哈希一致就不用写；写完必须核对。其余文件 null */
  contentHash?(name: string): string | null
  /** 每写完一个文件调一次（必须可重复调用）：删掉本机其它位置的同 id 旧副本、把记录里的工作目录改成目标 cwd 之类。cwd 同 target */
  afterImport?(sessionId: string, cwd: string): Promise<void>
}

/** Ramet 自己存 agent 会话记录的根目录（每家一个子目录）。RAMET_SESSIONS_DIR 只给测试与特殊部署换位置用 */
export function sessionsRoot(): string {
  return process.env.RAMET_SESSIONS_DIR || join(homedir(), '.ramet', 'sessions')
}

/** 驱动起 CLI 时用的环境（cfg.env 叠在本进程环境上）：会话目录的根由 CLI 自己的环境变量决定，端口要看同一份 */
export function cliEnv(env: Record<string, string> | undefined, key: string): string | undefined {
  const v = env?.[key] ?? process.env[key]
  return v ? v : undefined
}

/** 正在写入的临时文件的前缀：列会话文件时跳过它们（导入到一半的东西不是会话的一部分） */
export const IMPORT_TEMP_PREFIX = '.ramet-import-'

export function importTempName(dir: string): string {
  return join(dir, `${IMPORT_TEMP_PREFIX}${randomBytes(6).toString('hex')}.tmp`)
}

/** `<prefix><相对路径>` 形状的 name → 路径段。拒绝：不是字符串、过长、含 NUL / 反斜杠、空段、`.` / `..`、以 / 开头（绝对路径）。
 *  路径段之后只会经 join 拼在端口自己算出的目录下面，所以拒绝了这些就出不了那个目录 */
export function relSegments(name: unknown, prefix: string): string[] | null {
  if (typeof name !== 'string' || name.length > 1024 || !name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  if (!rest || rest.includes('\0') || rest.includes('\\')) return null
  const segs = rest.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith(IMPORT_TEMP_PREFIX))) return null
  return segs
}

type Walked = { rel: string; path: string; size: number; mtimeMs: number }

const WALK_MAX_FILES = 10_000
const WALK_MAX_DEPTH = 8

/** 列一个目录下的全部普通文件（rel 用 / 分隔）。不跟符号链接、跳过导入临时文件；目录不存在 = 空 */
export async function walkFiles(root: string, depth = 0, prefix = '', out: Walked[] = []): Promise<Walked[]> {
  if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_FILES) return out
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(IMPORT_TEMP_PREFIX) || out.length >= WALK_MAX_FILES) continue
    const path = join(root, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) await walkFiles(path, depth + 1, rel, out)
    else if (e.isFile()) {
      const st = await lstat(path).catch(() => null)
      if (st?.isFile()) out.push({ rel, path, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** 普通文件（不是符号链接）的 stat；不存在 / 不是普通文件 = null */
export async function regularFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  const st = await lstat(path).catch(() => null)
  return st?.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
}

/** 目标 cwd 的真实路径：CLI 进程里看到的 cwd 是解开符号链接之后的（getcwd），记录里的工作目录与项目目录名都按它算 */
export async function realCwd(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => cwd)
}

/** 记录首行是 `{"type":"session", …, "cwd": …}` 的会话文件（pi / omp）：把 cwd 改成目标机器的工作目录。
 *  两家打开记录时用它：pi 拿它当运行时的工作目录（目录不存在直接退出），omp 与进程 cwd 不同就不接这份记录。
 *  首行之后原样拷贝；先写同目录临时文件再 rename，失败不动原文件。首行不是这个形状 / 已经对了就不动 */
export async function rewriteHeaderCwd(file: string, cwd: string): Promise<void> {
  const head = Buffer.alloc(64 * 1024)
  const fh = await open(file, 'r')
  let n: number
  try {
    n = (await fh.read(head, 0, head.length, 0)).bytesRead
  } finally {
    await fh.close()
  }
  const nl = head.subarray(0, n).indexOf(0x0a)
  if (nl < 0) return
  let header: Record<string, unknown>
  try {
    header = JSON.parse(head.subarray(0, nl).toString('utf8')) as Record<string, unknown>
  } catch {
    return
  }
  if (header.type !== 'session' || typeof header.cwd !== 'string' || header.cwd === cwd) return
  const tmp = importTempName(dirname(file))
  try {
    const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 })
    out.write(JSON.stringify({ ...header, cwd }))
    await pipeline(createReadStream(file, { start: nl }), out)
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}
