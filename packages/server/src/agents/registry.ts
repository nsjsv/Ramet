// ---------- agent 注册表 ----------
// 配置来源（优先级从高到低）：
//   1. env RAMET_AGENTS，JSON 数组字符串（显式配置，永远优先）
//   2. 进程 cwd 下 agents.json（同格式）
//   3. 自动检测本机已有 CLI（未显式配置时的兜底，装了就能用，不必再抄一遍 JSON）
// 都没有则是空列表（前端控制条自然没有可选项）。
//
// 格式（每项必须写 driver，只能是四家之一）:
// [
//   { "id": "omp",    "label": "omp",    "command": "/usr/bin/omp",    "driver": "omp" },
//   { "id": "claude", "label": "Claude", "command": "/usr/bin/claude", "driver": "claude" }
// ]
// driver（drivers/create.ts 分派）：claude = command 是本机的 claude 可执行文件（经 Claude Agent SDK 驱动）；
// codex = command 是本机的 codex 可执行文件（驱动自己起 `codex app-server`）；
// pi / omp = command 是本机的 pi / omp 可执行文件（驱动自己起 `pi --mode rpc` / `omp --mode rpc-ui`）。
// cli：探版本用的可执行文件，可选，缺省就是 command（command 是包装脚本时才要写）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENT_DRIVERS, type AgentConfig, type AgentDriver } from './types.js'

/** 留给中心自己的 agent 的 id 前缀（Genet = `ramet:assistant`，见 assistant-agent.ts）：配置里的 agent 不许用，免得撞名。
 *  connector 上的 agent 在中心有 `c:<connectorId>:` 前缀，本来就撞不上 */
export const RESERVED_AGENT_PREFIX = 'ramet:'

export type AgentsSource = 'env' | 'file' | 'auto' | 'none'
export type LoadedAgents = { agents: AgentConfig[]; source: AgentsSource }

function parse(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) throw new Error('agents 配置必须是数组')
  return raw.map((a) => {
    const { id, label, command, args, env, logo, driver, cli } = a as Record<string, unknown>
    if (typeof id !== 'string' || typeof command !== 'string') {
      throw new Error('agent 配置项缺 id 或 command')
    }
    if (id.startsWith(RESERVED_AGENT_PREFIX)) throw new Error(`agent ${id}：以 ${RESERVED_AGENT_PREFIX} 开头的 id 留给 Ramet 自己，换一个`)
    // 没写 / 写错（含已不支持的 acp）当场报出来：猜一个驱动去跟进程说话，只会握手超时、错得莫名其妙
    if (typeof driver !== 'string' || !AGENT_DRIVERS.includes(driver as AgentDriver)) {
      const got = driver === undefined ? '没写 driver' : `driver 写的是 ${JSON.stringify(driver)}`
      throw new Error(`agent ${id} ${got}：driver 必须是 ${AGENT_DRIVERS.join(' / ')} 之一（ACP agent 已不再支持）`)
    }
    return {
      id,
      label: typeof label === 'string' ? label : id,
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      env: env && typeof env === 'object' ? (env as Record<string, string>) : undefined,
      logo: typeof logo === 'string' ? logo : undefined,
      driver: driver as AgentDriver,
      ...(typeof cli === 'string' && cli ? { cli } : {}),
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

/** 本机已装、能驱动的 CLI：claude、codex、pi、omp（只要本机有这个 CLI；omp 自己的入口要 bun，起不来时失败原因里有 stderr）。
 * 只在能真正起来时才报：缺少它要调用的 CLI 就不报。CLI 版本太旧的不在这里判
 * （要起进程问版本），由目录上的不可用原因（cli-version.ts 的 unavailableAgents）与驱动的 ready() 拦。 */
export function detectInstalledAgents(pathEnv?: string, platform = process.platform, home = homedir()): AgentConfig[] {
  const path = pathEnv ?? process.env.PATH ?? ''
  const find = (name: string): string | null => findBinary(name, path, platform)
  const found: Record<string, string | null> = {}
  const has = (name: string): boolean => {
    if (!(name in found)) found[name] = find(name)
    return found[name] !== null
  }

  const out: AgentConfig[] = []
  if (has('omp')) out.push({ id: 'omp', label: 'omp', command: found.omp!, driver: 'omp' })
  const claudeBin = (has('claude') ? found.claude : null) ?? claudeFromHome(home, platform)
  if (claudeBin) out.push({ id: 'claude', label: 'Claude', command: claudeBin, driver: 'claude' })
  if (has('codex')) out.push({ id: 'codex', label: 'Codex', command: found.codex!, driver: 'codex' })
  if (has('pi')) out.push({ id: 'pi', label: 'Pi', command: found.pi!, driver: 'pi' })
  return out
}

/** 显式配置（env / cwd 下 agents.json）；都没有返回 null。文件在但写错了照样报错，不悄悄落回自动检测 */
function configured(cwd: string): { agents: AgentConfig[]; source: AgentsSource } | null {
  const envRaw = process.env.RAMET_AGENTS
  if (envRaw) return { agents: parse(JSON.parse(envRaw)), source: 'env' }
  let raw: string
  try {
    raw = readFileSync(join(cwd, 'agents.json'), 'utf8')
  } catch {
    return null
  }
  try {
    return { agents: parse(JSON.parse(raw)), source: 'file' }
  } catch (err) {
    throw new Error(`agents.json：${err instanceof Error ? err.message : String(err)}`)
  }
}

export function loadAgents(cwd = process.cwd()): LoadedAgents {
  const explicit = configured(cwd)
  if (explicit) return explicit
  const auto = detectInstalledAgents()
  return auto.length ? { agents: auto, source: 'auto' } : { agents: [], source: 'none' }
}
