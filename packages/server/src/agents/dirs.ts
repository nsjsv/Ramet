// ---------- 执行端目录列举（工作区选择器） ----------
// 跑在 agent 所在机器那一侧：本机 agent = 中心进程；connector agent = connector 进程。
// 只回目录（工作区必须是目录），路径一律由执行端 realpath 成绝对路径并算好 parent：
// connector 可能跑在 Windows，分隔符与路径语义只有执行端权威，前端不拼路径。

import { readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 单个目录最多回多少条：目录可能上万条，WSS 中继与浏览器都不该吃这个带宽（超出标记 truncated） */
export const MAX_DIRS = 200

export type DirEntry = { name: string; path: string }

export type DirListing = {
  /** 解析后的绝对路径（选择器显示的位置） */
  path: string
  /** 上级目录；根目录为 null（选择器据此不显示"上级"） */
  parent: string | null
  dirs: DirEntry[]
  /** 超出 MAX_DIRS 被截断 */
  truncated: boolean
}

/** 可读失败原因：选择器要把它显示给人看，不能只甩 ENOENT 这种码 */
function fail(err: unknown, path: string): never {
  const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : ''
  const reason =
    code === 'ENOENT' ? '不存在'
    : code === 'ENOTDIR' ? '不是目录'
    : code === 'EACCES' || code === 'EPERM' ? '没有访问权限'
    : '无法访问'
  throw new Error(`目录${reason}：${path}`)
}

async function resolveDir(input: string): Promise<string> {
  try {
    return await realpath(resolve(input))
  } catch (err) {
    fail(err, input || resolve(input))
  }
}

async function readEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (err) {
    fail(err, path)
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function listDirs(input: string): Promise<DirListing> {
  const path = await resolveDir(input)
  const entries = await readEntries(path)
  const dirs: DirEntry[] = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    // 只认目录；symlink 跟着解析一次（软链到目录的工作区很常见，软链到文件的不是工作区）
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDir(child)))) continue
    dirs.push({ name: entry.name, path: child })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(path)
  return {
    path,
    parent: parent === path ? null : parent,
    dirs: dirs.slice(0, MAX_DIRS),
    truncated: dirs.length > MAX_DIRS,
  }
}
