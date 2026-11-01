// ---------- Claude Code 的会话端口 ----------
// 依据：本仓 @anthropic-ai/claude-agent-sdk 0.3.286（core.mjs / core-*.mjs，与 CLI 2.1.N 同步发版）里会话记录的位置：
//   配置目录 = (CLAUDE_CONFIG_DIR ?? ~/.claude).normalize('NFC')，记录 = <配置目录>/projects/<项目目录名>/<会话 id>.jsonl；
//   项目目录名 = cwd 把非字母数字换成 -，超过 200 个字符时截到 200 再接 `-<cwd 的 32 位字符串哈希的绝对值，36 进制>`；
//   设了 CLAUDE_CONFIG_DIR 时 CLAUDE_CODE_PROJECT_DIR_NAME（合法的话）直接当项目目录名。
//   子代理的记录在与主记录同名的子目录里（<会话 id>/…）。
// CLI 的 --resume 只在当前 cwd 的项目目录里找记录，所以下发时按目标 cwd 算项目目录、写进去，再删掉本机其它项目目录里同 id 的旧副本
// （否则以后在旧目录里续的是过期的那份）。
// name：main.jsonl = 主记录；sub/<相对路径> = 子目录里的文件。

import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validSessionId } from '../../session-types.js'
import { cliEnv, regularFile, relSegments, walkFiles, type SessionFile, type SessionPort } from '../session-port.js'

const MAIN = 'main.jsonl'
const SUB_PREFIX = 'sub/'
/** SDK 里项目目录名的长度上限（超出截断 + 哈希） */
const MAX_DIR_NAME = 200
const PROJECT_DIR_OVERRIDE = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

export function claudeConfigDir(env: Record<string, string> | undefined): string {
  return (cliEnv(env, 'CLAUDE_CONFIG_DIR') ?? join(homedir(), '.claude')).normalize('NFC')
}

/** SDK 的 32 位字符串哈希（`h = (h << 5) - h + c | 0`） */
function stringHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

/** cwd → 项目目录名（与 SDK 同一规则） */
export function projectDirName(cwd: string, env: Record<string, string> | undefined): string {
  const override = cliEnv(env, 'CLAUDE_CONFIG_DIR') ? cliEnv(env, 'CLAUDE_CODE_PROJECT_DIR_NAME') : undefined
  if (override && PROJECT_DIR_OVERRIDE.test(override) && !RESERVED.test(override)) return override
  const flat = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return flat.length <= MAX_DIR_NAME ? flat : `${flat.slice(0, MAX_DIR_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`
}

async function projectDirs(projects: string): Promise<string[]> {
  const entries = await readdir(projects, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

export function claudeSessionPort(env: Record<string, string> | undefined): SessionPort {
  const projects = (): string => join(claudeConfigDir(env), 'projects')
  return {
    async list(sessionId) {
      if (!validSessionId(sessionId)) return []
      // 同一个 id 可能留在多个项目目录里（以前在别的工作区续过）：取最近写过的那份
      let best: { dir: string; size: number; mtimeMs: number } | null = null
      for (const name of await projectDirs(projects())) {
        const dir = join(projects(), name)
        const st = await regularFile(join(dir, `${sessionId}.jsonl`))
        if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { dir, ...st }
      }
      if (!best) return []
      const out: SessionFile[] = [{ name: MAIN, size: best.size, path: join(best.dir, `${sessionId}.jsonl`) }]
      for (const f of await walkFiles(join(best.dir, sessionId))) out.push({ name: SUB_PREFIX + f.rel, size: f.size, path: f.path })
      return out
    },
    target(sessionId, cwd, name) {
      if (!validSessionId(sessionId)) return null
      const dir = join(projects(), projectDirName(cwd, env))
      if (name === MAIN) return join(dir, `${sessionId}.jsonl`)
      const segs = relSegments(name, SUB_PREFIX)
      return segs ? join(dir, sessionId, ...segs) : null
    },
    async afterImport(sessionId, cwd) {
      if (!validSessionId(sessionId)) return
      const keep = projectDirName(cwd, env)
      for (const name of await projectDirs(projects())) {
        if (name === keep) continue
        const dir = join(projects(), name)
        // 只删同一个会话 id 的记录与子目录，别的会话一概不碰
        await rm(join(dir, `${sessionId}.jsonl`), { force: true })
        await rm(join(dir, sessionId), { recursive: true, force: true })
      }
    },
  }
}
