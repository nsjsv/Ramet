// ---------- agent 注册表 ----------
// 配置来源（优先级从高到低）：
//   1. env RAMET_AGENTS，JSON 数组字符串（显式配置，永远优先）
//   2. 进程 cwd 下 agents.json（同格式）
//   3. 自动检测本机已有 CLI（未显式配置时的兜底，装了就能用，不必再抄一遍 JSON）
// 都没有则是空列表（前端控制条自然没有可选项）。
//
// 格式:
// [
//   { "id": "omp",     "label": "omp",    "command": "omp",     "args": ["acp"] },
//   { "id": "claude",  "label": "Claude", "command": "node",    "args": ["<server node_modules>/@agentclientprotocol/claude-agent-acp/dist/index.js"],
//     "env": { "CLAUDE_CODE_EXECUTABLE": "/usr/bin/claude" } },
//   { "id": "gemini",  "label": "Gemini", "command": "npx",     "args": ["-y", "@google/gemini-cli", "--acp"] }
// ]
// env：claude 适配器必须指 CLAUDE_CODE_EXECUTABLE；gemini 需先 OAuth 或给 GEMINI_API_KEY。
// claude 适配器（@agentclientprotocol/claude-agent-acp）是 server 的 dependencies，自动检测直接
// 用 node 跑包内入口，不经 npx（npx 每次要动 npx 缓存，缓存坏掉会永远起不来）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentConfig } from './types.js'

export type AgentsSource = 'env' | 'file' | 'auto' | 'none'
export type LoadedAgents = { agents: AgentConfig[]; source: AgentsSource }

function parse(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) throw new Error('agents 配置必须是数组')
  return raw.map((a) => {
    const { id, label, command, args, env, logo } = a as Record<string, unknown>
    if (typeof id !== 'string' || typeof command !== 'string') {
      throw new Error('agent 配置项缺 id 或 command')
    }
    return {
      id,
      label: typeof label === 'string' ? label : id,
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      env: env && typeof env === 'object' ? (env as Record<string, string>) : undefined,
      logo: typeof logo === 'string' ? logo : undefined,
    }
  })
}

/** PATH 上找可执行文件（Windows 补 .exe/.cmd/.bat；POSIX 要求可执行位） */
export function findBinary(name: string, pathEnv = process.env.PATH ?? '', platform = process.platform): string | null {
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, name + ext)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        if (platform === 'win32' || (st.mode & 0o111) !== 0) return full
      } catch {
        // 不存在/无权限：继续找下一个目录
      }
    }
  }
  return null
}

/** 包内 ACP 适配器（server dependencies）。每个会话 spawn 的入口，不经 npx。 */
const CLAUDE_ACP_PKG = '@agentclientprotocol/claude-agent-acp'
const CODEX_ACP_ENTRY = '@agentclientprotocol/codex-acp/dist/index.js'
const PI_ACP_ENTRY = '@victor-software-house/pi-acp/dist/index.mjs'

function packageEntry(spec: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(spec)
  } catch {
    return null
  }
}

function versionKey(name: string): number[] {
  return name.split(/[^0-9]+/).filter(Boolean).map((part) => Number(part))
}

function compareVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** PATH 上没有 claude 时，用官方安装目录里版本号最高的那个可执行文件 */
function claudeFromHome(home: string, platform: string): string | null {
  let names: string[]
  try {
    names = readdirSync(join(home, '.local', 'share', 'claude', 'versions'))
  } catch {
    return null
  }
  let best: { key: number[]; path: string } | null = null
  for (const name of names) {
    const full = join(home, '.local', 'share', 'claude', 'versions', name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (platform !== 'win32' && (st.mode & 0o111) === 0) continue
    } catch {
      continue
    }
    const key = versionKey(name)
    if (key.length === 0) continue
    if (!best || compareVersion(key, best.key) > 0) best = { key, path: full }
  }
  return best?.path ?? null
}

/** 本机已装且能被 ACP 适配层驱动的 CLI。
 * omp、opencode 原生 `acp`；claude / codex / pi 用包内适配器 + 本机 CLI；
 * gemini 走 npx（它的 ACP 入口不在本仓库依赖里）。
 * 只在能真正起来时才报：适配器包解析不到、或缺少它要调用的 CLI，就不报。 */
export function detectInstalledAgents(pathEnv?: string, platform = process.platform, home = homedir()): AgentConfig[] {
  const path = pathEnv ?? process.env.PATH ?? ''
  const find = (name: string): string | null => findBinary(name, path, platform)
  const found: Record<string, string | null> = {}
  const has = (name: string): boolean => {
    if (!(name in found)) found[name] = find(name)
    return found[name] !== null
  }

  const out: AgentConfig[] = []
  if (has('omp')) {
    out.push({ id: 'omp', label: 'omp', command: found.omp!, args: ['acp'] })
  }
  const claudeBin = (has('claude') ? found.claude : null) ?? claudeFromHome(home, platform)
  if (claudeBin) {
    // 子进程必须能定位真实 claude 二进制（适配器经 CLAUDE_CODE_EXECUTABLE 起 CLI）。
    // 适配器入口优先包内解析，解析不到才回落 npx。每个会话都要 spawn 一次，走 npx 会去动
    // npx 缓存，缓存被写坏时子进程永远不回 initialize。
    let launcher: { command: string; args: string[] } | null = null
    const entry = has('node') ? packageEntry(`${CLAUDE_ACP_PKG}/dist/index.js`) : null
    if (entry && found.node) launcher = { command: found.node, args: [entry] }
    if (!launcher && has('npx')) launcher = { command: found.npx!, args: ['-y', CLAUDE_ACP_PKG] }
    if (launcher) {
      out.push({
        id: 'claude',
        label: 'Claude',
        command: launcher.command,
        args: launcher.args,
        env: { CLAUDE_CODE_EXECUTABLE: claudeBin },
      })
    }
  }
  const codexEntry = has('node') ? packageEntry(CODEX_ACP_ENTRY) : null
  if (has('codex') && codexEntry && found.node) {
    out.push({
      id: 'codex',
      label: 'Codex',
      command: found.node,
      args: [codexEntry],
      env: { CODEX_PATH: found.codex!, NO_BROWSER: '1' },
    })
  }
  if (has('opencode')) {
    out.push({ id: 'opencode', label: 'OpenCode', command: found.opencode!, args: ['acp'] })
  }
  // pi-acp 的客户端会再拉起 `进程自己 --daemon`。daemon 入口 import 'bun'，
  // 用 node 起客户端时 process.execPath 也是 node，daemon 立刻崩，3 秒后客户端退出码 1。
  const piEntry = has('bun') ? packageEntry(PI_ACP_ENTRY) : null
  if (has('pi') && piEntry && found.bun) {
    out.push({
      id: 'pi',
      label: 'Pi',
      command: found.bun,
      args: [piEntry],
    })
  }
  if (has('npx') && has('gemini')) {
    out.push({
      id: 'gemini',
      label: 'Gemini',
      command: found.npx!,
      args: ['-y', '@google/gemini-cli', '--acp'],
    })
  }
  return out
}

/** 显式配置（env / cwd 下 agents.json）；都没有返回 null */
function configured(cwd: string): { agents: AgentConfig[]; source: AgentsSource } | null {
  const envRaw = process.env.RAMET_AGENTS
  if (envRaw) return { agents: parse(JSON.parse(envRaw)), source: 'env' }
  try {
    return { agents: parse(JSON.parse(readFileSync(join(cwd, 'agents.json'), 'utf8'))), source: 'file' }
  } catch {
    return null
  }
}

export function loadAgents(cwd = process.cwd()): LoadedAgents {
  const explicit = configured(cwd)
  if (explicit) return explicit
  const auto = detectInstalledAgents()
  return auto.length ? { agents: auto, source: 'auto' } : { agents: [], source: 'none' }
}
