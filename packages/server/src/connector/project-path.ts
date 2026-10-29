// ---------- 项目面板的路径约束（connector 侧执行，不信中心）----------
// 帧带 root（绝对路径）+ path（相对 root）。即使操作人是机器主人 / 被授权人，能碰的也只有 root 之内的东西：
//   1. root 先 realpath（root 本身是指向别处的符号链接时，以链接目标为准）；
//   2. 目标 = realpath(root + path)，符号链接全部解开后必须等于 root 或在 root 之下，
//      按路径分隔符比较前缀（`/a/bc` 不在 `/a/b` 之下）；链接指向 root 外或目标不存在都拒绝；
//   3. path 是绝对路径 / 含 NUL / 含 `..` 段 / 不是字符串都拒绝（`..` 单靠第 2 步也拦得住，这里再挡一层让报错更直接）；
//   4. protect 是这台机器上不该对网页开放的路径（connector 自己的配置目录，里面有长期 token 与授权名单），目标落在其中也拒绝。
// 之后的读 / 列目录一律用 realpath 过的绝对路径，不再用原始输入拼，缩小「检查之后、使用之前」被换成链接的窗口。
// 已知局限：检查与使用之间仍有极小的竞争窗口；能在工作区里建链接的人是机器主人自己 / 他的 agent，不是被授权的网页访客。

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

/** 路径被拒绝或不可用；message 是人话，原样给用户看 */
export class PathDenied extends Error {}

/** child 是 parent 本身，或在 parent 之下（按分隔符比较；两边都应已 realpath） */
export function within(parent: string, child: string): boolean {
  if (child === parent) return true
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/** 工作区根：必须是存在的绝对路径目录；返回 realpath。root 由中心给，但仍然校验形状（不信中心） */
export async function realRoot(root: unknown): Promise<string> {
  if (typeof root !== 'string' || !root || root.includes('\0') || !isAbsolute(root)) {
    throw new PathDenied('工作区路径无效')
  }
  let real: string
  try {
    real = await realpath(root)
    if (!(await stat(real)).isDirectory()) throw new Error('not a dir')
  } catch {
    throw new PathDenied('工作区目录不存在或不可访问')
  }
  return real
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** protect 里的路径展开成 realpath 集（不存在的就用 resolve 后的原样：它还没建出来也要挡） */
export async function protectedPaths(protect: readonly string[]): Promise<string[]> {
  return Promise.all(protect.map(realOrSelf))
}

/** 相对路径 → 规范化的 `/` 分隔段数组；非法输入直接 PathDenied。'' / '.' = root 本身（空数组） */
function segmentsOf(rel: unknown): string[] {
  if (rel === undefined || rel === null || rel === '') return []
  if (typeof rel !== 'string') throw new PathDenied('路径无效')
  if (rel.includes('\0')) throw new PathDenied('路径无效')
  const drive = process.platform === 'win32' && /^[A-Za-z]:/.test(rel)
  if (isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\') || drive) {
    throw new PathDenied('只能访问工作区之内的相对路径')
  }
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new PathDenied('路径不能含 ..')
  return parts
}

export type Resolved = {
  /** root 的 realpath */
  root: string
  /** 目标的 realpath（已确认在 root 之内、不在 protect 里）：后续读写一律用它 */
  abs: string
  /** 目标相对 root 的 `/` 分隔路径（'' = root 本身；符号链接已解开，所以可能与输入不同） */
  rel: string
}

/** 把 (root, path) 解析成 root 之内的真实路径；任何一步不满足就抛 PathDenied */
export async function resolveInRoot(root: unknown, rel: unknown, protect: readonly string[] = []): Promise<Resolved> {
  const real = await realRoot(root)
  const parts = segmentsOf(rel)
  let abs = real
  if (parts.length > 0) {
    let target: string
    try {
      target = await realpath(resolve(real, ...parts))
    } catch {
      throw new PathDenied('路径不存在')
    }
    if (!within(real, target)) throw new PathDenied('路径在工作区之外（符号链接指向了工作区外）')
    abs = target
  }
  for (const p of await protectedPaths(protect)) {
    if (within(p, abs)) throw new PathDenied('这是 connector 自己的配置目录，不对网页开放')
  }
  const relative = abs === real ? '' : abs.slice((real.endsWith(sep) ? real : real + sep).length).split(sep).join('/')
  return { root: real, abs, rel: relative }
}
