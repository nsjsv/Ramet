// ---------- connector 的项目面板执行端：文件树 / 读文件 / 文件清单 / git 状态与 diff（只读）+ 写文件（只改已存在的文本文件）----------
// 跑在 agent 所在机器上。帧在 connector/index.ts 已过第二道闸（操作人是主人或本地名单里 machine 范围的人），这里再做两件事：
//   1. 路径约束（project-path.ts）：root 与目标 realpath，必须在 root 之内，符号链接越界 / 不存在 / 绝对路径 / NUL 一律拒绝；
//   2. 体积与并发约束：读文件限大小、含 NUL 当二进制、目录条数封顶；同时在跑的项目请求有上限（被授权的人也不该能把这台机器拖垮）。
// 失败一律抛 PathDenied / Error，message 是人话，由调用方回成 err 帧。

import { createHash, randomBytes } from 'node:crypto'
import { lstat, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProjectMsg } from '../agents/protocol.js'
import {
  FILES_MAX,
  READ_MAX_BYTES,
  TREE_MAX_ENTRIES,
  type FilesReply,
  type GitMark,
  type ProjectReply,
  type ReadReply,
  type TreeEntry,
  type TreeReply,
  type WriteReply,
} from '../agents/project-types.js'
import { gitDiff, gitFiles, gitStatus } from './project-git.js'
import { PathDenied, protectedPaths, resolveInRoot, within } from './project-path.js'

export { PathDenied } from './project-path.js'

/** 写文件时文件已不是用户读到的那一版（baseHash 不符）：回 err { code: 'conflict' }，网页提示重新打开而不是当成普通失败 */
export class WriteConflict extends PathDenied {}

export type ProjectOptions = {
  /** 不对网页开放的路径（connector 自己的配置目录：里面有长期 token 与授权名单） */
  protect: readonly string[]
}

/** 同时在跑的项目请求上限：超出的排队。git status 在大仓库上要几百毫秒，不该让一个人连点把机器拖慢 */
const MAX_CONCURRENT = 4
/** 排队的上限：再多就直接回「正忙」，不让一个人把请求无限堆在这台机器的内存里 */
const MAX_QUEUED = 64
let running = 0
const waiting: Array<() => void> = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new PathDenied('这台机器正忙，请稍后再试')
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** 文件系统错误 → 人话（不把带绝对路径的 errno 原文回给网页） */
function humanize(err: unknown): Error {
  if (err instanceof PathDenied) return err
  const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : ''
  if (code === 'EACCES' || code === 'EPERM') return new PathDenied('没有访问权限')
  if (code === 'ENOENT' || code === 'ENOTDIR') return new PathDenied('路径不存在')
  return err instanceof Error ? err : new Error(String(err))
}

/** 一帧 → 一个回复。路径先过 resolveInRoot，之后只用它返回的 realpath */
export function handleProject(msg: ProjectMsg, opts: ProjectOptions): Promise<ProjectReply> {
  return slot(async () => {
    try {
      switch (msg.t) {
        case 'tree':
          return await projectTree(msg.root, msg.path, opts)
        case 'read':
          return await projectRead(msg.root, msg.path, opts)
        case 'files':
          return await projectFiles(msg.root, opts)
        case 'git-status':
          return await gitStatus((await resolveInRoot(msg.root, '', opts.protect)).root)
        case 'git-diff': {
          const { root, rel } = await resolveInRoot(msg.root, msg.path, opts.protect)
          return { op: 'git-diff', ...(msg.path ? { path: rel } : {}), ...(await gitDiff(root, msg.path ? rel : undefined)) }
        }
        case 'write':
          return await projectWrite(msg.root, msg.path, msg.baseHash, msg.content, opts)
      }
    } catch (err) {
      throw humanize(err)
    }
  })
}

// ---------- 文件树 ----------

/** 改动标记表：文件 → 标记；目录 → 里面有改动（全是未跟踪的给 ?，其余 M）。
 *  展开几个目录 / 刷新时会连着发好几个 tree 帧，每个都要标记：短时间内同一个 root 共用一次 git status（在飞的也共用） */
const MARKS_TTL_MS = 2000
const marksCache = new Map<string, { at: number; marks: Promise<Map<string, GitMark>> }>()

function gitMarks(root: string): Promise<Map<string, GitMark>> {
  const hit = marksCache.get(root)
  if (hit && Date.now() - hit.at < MARKS_TTL_MS) return hit.marks
  const marks = computeMarks(root)
  if (marksCache.size >= 16) marksCache.clear()
  marksCache.set(root, { at: Date.now(), marks })
  return marks
}

async function computeMarks(root: string): Promise<Map<string, GitMark>> {
  const marks = new Map<string, GitMark>()
  let status
  try {
    status = await gitStatus(root)
  } catch {
    return marks // 没有 git / 超时：树照常画，只是没有标记
  }
  for (const f of status.files) {
    marks.set(f.path, f.mark)
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const prev = marks.get(dir)
      marks.set(dir, prev === 'M' || f.mark !== '?' ? 'M' : '?')
    }
  }
  return marks
}

const byKindThenName = (a: TreeEntry, b: TreeEntry): number => {
  const ad = a.type === 'dir' ? 0 : 1
  const bd = b.type === 'dir' ? 0 : 1
  return ad - bd || a.name.localeCompare(b.name)
}

async function entryOf(name: string, abs: string, root: string, protect: string[], dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Promise<TreeEntry | null> {
  if (dirent.isDirectory()) return { name, type: 'dir' }
  if (dirent.isFile()) {
    const st = await lstat(abs).catch(() => null)
    return { name, type: 'file', ...(st ? { size: st.size } : {}) }
  }
  if (!dirent.isSymbolicLink()) return null // 管道 / 套接字 / 设备：不是用户要看的东西
  try {
    const target = await realpath(abs)
    if (!within(root, target) || protect.some((p) => within(p, target))) return { name, type: 'link' }
    const st = await stat(target)
    if (st.isDirectory()) return { name, type: 'dir', link: true }
    if (st.isFile()) return { name, type: 'file', size: st.size, link: true }
  } catch {
    // 悬空链接
  }
  return { name, type: 'link' }
}

async function projectTree(rootIn: string, pathIn: string, opts: ProjectOptions): Promise<TreeReply> {
  const { root, abs, rel } = await resolveInRoot(rootIn, pathIn, opts.protect)
  if (!(await stat(abs)).isDirectory()) throw new PathDenied('不是目录')
  const protect = await protectedPaths(opts.protect)
  const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => d.name !== '.git')
  const marks = await gitMarks(root)
  const entries: TreeEntry[] = []
  for (const d of dirents) {
    const entry = await entryOf(d.name, join(abs, d.name), root, protect, d)
    if (!entry) continue
    const mark = marks.get(rel ? `${rel}/${d.name}` : d.name)
    entries.push(mark ? { ...entry, git: mark } : entry)
  }
  entries.sort(byKindThenName)
  return {
    op: 'tree',
    path: rel,
    entries: entries.slice(0, TREE_MAX_ENTRIES),
    truncated: entries.length > TREE_MAX_ENTRIES,
  }
}

// ---------- 读文件 ----------

/** 截断点可能落在一个多字节字符中间：去掉末尾不完整的那一截，免得显示一个乱码字符 */
function trimIncompleteUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1
  let back = 0
  while (i >= 0 && back < 4 && (buf[i]! & 0xc0) === 0x80) {
    i--
    back++
  }
  if (i < 0) return buf
  const lead = buf[i]!
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return need > 1 && back + 1 < need ? buf.subarray(0, i) : buf
}

async function projectRead(rootIn: string, pathIn: string, opts: ProjectOptions): Promise<ReadReply> {
  const { abs, rel } = await resolveInRoot(rootIn, pathIn, opts.protect)
  // O_NONBLOCK：万一路径被换成了管道，open 不会阻塞整个请求；打开之后再看它是不是普通文件
  const fh = await open(abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => {
    throw new PathDenied('无法打开这个文件')
  })
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new PathDenied('不是普通文件')
    const want = Math.min(st.size, READ_MAX_BYTES)
    const buf = Buffer.allocUnsafe(want)
    let got = 0
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    const data = buf.subarray(0, got)
    if (data.includes(0)) return { op: 'read', path: rel, size: st.size, binary: true, text: '', truncated: false }
    const truncated = st.size > READ_MAX_BYTES
    const text = new TextDecoder('utf-8').decode(truncated ? trimIncompleteUtf8(data) : data)
    // hash 只给读全了的文件：截断过的文件不允许改（改回去会丢掉没读到的后半截）
    return { op: 'read', path: rel, size: st.size, binary: false, text, truncated, ...(truncated ? {} : { hash: sha256(data) }) }
  } finally {
    await fh.close()
  }
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

// ---------- 写文件（随手 AI 在代码查看器里收下改写）----------
// 写是这个模块里唯一会改磁盘的操作（中心已按 machine 范围 + 页面可写判过，connector 又按 actor 判过），所以尽量窄：
// 只改已存在的普通 UTF-8 文本文件，不建新文件、不删、不改 .git 里面的东西，读写都带 1MB 上限；
// 基于用户读到的那一版（baseHash），读到之后被别人（或 agent）改过就拒绝，宁可让用户重新打开也不覆盖别人的改动。

/** 临时文件放在目标同目录（同一文件系统，rename 才是原子的）；名字带随机串，O_EXCL 创建，成败都不留 */
const tempNameFor = (abs: string): string => join(dirname(abs), `.ramet-write-${randomBytes(6).toString('hex')}.tmp`)

async function projectWrite(rootIn: string, pathIn: string, baseHash: unknown, content: unknown, opts: ProjectOptions): Promise<WriteReply> {
  if (typeof content !== 'string') throw new PathDenied('内容无效')
  if (typeof baseHash !== 'string' || !/^[0-9a-f]{64}$/.test(baseHash)) throw new PathDenied('缺少文件版本信息，请重新打开文件')
  if (typeof pathIn !== 'string' || pathIn === '') throw new PathDenied('路径无效')
  if (content.includes('\0')) throw new PathDenied('内容含 NUL，不能写入')
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > READ_MAX_BYTES) throw new PathDenied('内容超过 1MB，不能就地修改')

  const { root, abs, rel } = await resolveInRoot(rootIn, pathIn, opts.protect)
  // .git 里面是仓库自己的簿记（hooks / config 改了会在主人下次提交时执行东西）：网页不碰。
  // 不分大小写：大小写不敏感的文件系统（macOS 默认）上 .GIT 也是它
  if (rel.split('/').some((seg) => seg.toLowerCase() === '.git')) throw new PathDenied('不能修改 .git 里面的文件')
  if (abs === root) throw new PathDenied('不是普通文件')

  // O_NOFOLLOW：resolveInRoot 返回的是 realpath；万一检查之后末级被换成了符号链接，这里直接打不开，不会顺着链接写到别处
  const fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => {
    throw new PathDenied('无法打开这个文件')
  })
  let original: Buffer
  let mode: number
  let owner: { uid: number; gid: number }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new PathDenied('不是普通文件')
    if (st.size > READ_MAX_BYTES) throw new PathDenied('文件超过 1MB，不能就地修改')
    original = Buffer.allocUnsafe(st.size)
    let got = 0
    while (got < st.size) {
      const { bytesRead } = await fh.read(original, got, st.size - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    original = original.subarray(0, got)
    mode = st.mode & 0o7777
    // 主人把它设成只读的（0444 之类）就是不想被改；rename 能绕过文件本身的权限位，所以这里自己守
    if (process.platform !== 'win32' && (mode & 0o200) === 0) throw new PathDenied('这个文件是只读的')
    owner = { uid: st.uid, gid: st.gid }
  } finally {
    await fh.close()
  }
  if (sha256(original) !== baseHash) throw new WriteConflict('文件已被改动，请重新打开')
  if (original.includes(0)) throw new PathDenied('二进制文件不能修改')
  let hadBom = false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(original)
    hadBom = original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf
  } catch {
    throw new PathDenied('文件不是 UTF-8 文本，不能就地修改')
  }
  // 读取时 TextDecoder 会去掉开头的 BOM，网页上看不到它：写回时补上，别悄悄改了文件的编码标记
  const out = hadBom && !(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes

  const tmp = tempNameFor(abs)
  try {
    const outFh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await outFh.writeFile(out)
      await outFh.chmod(mode) // 保留原权限位（open 的 mode 受 umask 影响）
      await outFh.chown(owner.uid, owner.gid).catch(() => undefined) // 尽力保留属主；不是同一个人跑的就算了
      await outFh.sync()
    } finally {
      await outFh.close()
    }
    await rename(tmp, abs)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
  return { op: 'write', path: rel, hash: sha256(out) }
}

// ---------- 文件清单（⌘P）----------

/** 非 git 目录的遍历跳过这些目录（体积大、没人想在 ⌘P 里搜到它们的内容） */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', '.DS_Store'])
const MAX_DEPTH = 24

async function walkFiles(root: string, protect: string[]): Promise<FilesReply> {
  const files: string[] = []
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }]
  let truncated = false
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()!
    let dirents
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true })
    } catch {
      continue // 没权限的子目录跳过，不让整个清单失败
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      if (SKIP_DIRS.has(d.name)) continue
      const abs = join(dir.abs, d.name)
      const rel = dir.rel ? `${dir.rel}/${d.name}` : d.name
      // 符号链接一律不进清单、不跟进（环 + 越界），要打开它们走文件树
      if (d.isDirectory()) {
        if (dir.depth < MAX_DEPTH && !protect.some((p) => within(p, abs))) queue.push({ abs, rel, depth: dir.depth + 1 })
      } else if (d.isFile()) {
        if (files.length >= FILES_MAX) {
          truncated = true
          break
        }
        files.push(rel)
      }
    }
  }
  return { op: 'files', files, truncated }
}

async function projectFiles(rootIn: string, opts: ProjectOptions): Promise<FilesReply> {
  const { root } = await resolveInRoot(rootIn, '', opts.protect)
  const git = await gitFiles(root).catch(() => null)
  if (git) return { op: 'files', ...git }
  return walkFiles(root, await protectedPaths(opts.protect))
}
