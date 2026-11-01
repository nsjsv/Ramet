// ---------- agent CLI 版本探测（connector 在 hello 里上报） ----------
// 中心据此知道每台机器上的 CLI 是哪一版（原生驱动按版本兼容）。取不到就不报：
// 版本只是信息，探测失败不能影响 agent 本身能不能用。

import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AgentConfig, AgentDriver } from '../types.js'

/** `--version` 可能要冷启动一个运行时（bun / node），给足但不能无限等：connector 连中心之前要等它 */
const VERSION_TIMEOUT_MS = 5_000
const VERSION_MAX = 64

/** 要探测的可执行文件：显式的 cli；没写就是驱动直接起的 command（就是 CLI 本身） */
export function cliOf(cfg: AgentConfig): string {
  return cfg.cli || cfg.command
}

/** `--version` 输出里的第一个版本号（如 `2.1.312 (Claude Code)` → `2.1.312`、`codex-cli 0.50.0` → `0.50.0`） */
export function parseVersion(output: string): string | undefined {
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(output)
  return m ? m[0].slice(0, VERSION_MAX) : undefined
}

/** 原生驱动要求的最低 CLI 版本（低于它在目录里标成不可用，不让选）。
 *  claude：server 锁定的 @anthropic-ai/claude-agent-sdk 0.3.286 随包 manifest.json 配套的 CLI 是 2.1.286，
 *  它的 sdkCompat.testedWrapperVersions 从 0.3.246 起；SDK 与 CLI 同步发版（0.3.N ↔ 2.1.N），所以这份 SDK 的控制协议
 *  （stop_task、task_* 事件、apply_flag_settings 的 effortLevel、initialize 应答里的 models）验证过的 CLI 下限取 2.1.246。
 *  升级 SDK 时按新包的 manifest 重新核对 */
export const CLAUDE_MIN_VERSION = '2.1.246'
/** codex：驱动用到的实验字段（thread/resume 的 path、
 *  item/tool/requestUserInput、initialize 的 experimentalApi）与按线程的 config 覆盖在 0.159 的 app-server schema 里都已存在。
 *  升级时用 `codex app-server generate-ts --experimental` 重新导出，对照 drivers/codex/protocol.ts */
export const CODEX_MIN_VERSION = '0.159.0'
/** pi：RPC 的 set_model / set_thinking_level 不再写用户默认值在 0.84.3，内置 MCP 与扩展的 registerMcpServer 在 0.99.0，
 *  exposure 直接进工具表在 0.99.2，--no-mcp 在 1.0.4，agent_settled 带 aborted 在 1.1.0（pi 的 CHANGELOG）；行为以 1.4.0 实测为准 */
export const PI_MIN_VERSION = '1.1.0'
/** omp：set_ask_dialog / cancel_subagent 从 18.5.0 起有，open_session / session_settled 从 18.4.0，negotiate_protocol 从 18.0.0，
 *  set_host_tools / set_subagent_subscription / prompt_result / rpc-ui 在 17.0.0 已有（逐版查发布包的 dist/cli.js）；行为以 18.14.1 实测为准 */
export const OMP_MIN_VERSION = '18.5.0'
const MIN_VERSIONS: Record<AgentDriver, string> = { claude: CLAUDE_MIN_VERSION, codex: CODEX_MIN_VERSION, pi: PI_MIN_VERSION, omp: OMP_MIN_VERSION }

/** 按数字段比较两个版本号（`2.1.9` < `2.1.47`；预发布后缀忽略） */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((p) => Number(p) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 这个驱动配这一版 CLI 能不能用：不能就返回人话原因。版本取不到不拦（只是信息，真起不来时驱动自己会报） */
export function cliUnavailable(driver: AgentDriver | undefined, version: string | undefined): string | undefined {
  const min = driver ? MIN_VERSIONS[driver] : undefined
  if (!min || !version || compareVersions(version, min) >= 0) return undefined
  return `本机 CLI 版本 ${version} 太旧，至少要 ${min}，升级后才能用`
}

/** agent id → 不可用原因（只列不可用的）。中心本机 agent 与 connector 共用 */
export function unavailableAgents(configs: AgentConfig[], versions: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const cfg of configs) {
    const why = cliUnavailable(cfg.driver, versions.get(cfg.id))
    if (why) out.set(cfg.id, why)
  }
  return out
}

export function probeVersion(bin: string, env?: Record<string, string>): Promise<string | undefined> {
  // 脚本（测试用的假 CLI、npm 装的 .js 入口）不一定有执行位：同 SDK 的做法，用当前 node 跑
  const script = /\.[cm]?js$/.test(bin)
  return new Promise((resolve) => {
    try {
      execFile(
        script ? process.execPath : bin,
        script ? [bin, '--version'] : ['--version'],
        // windowsHide：后台服务没有控制台，不藏会闪一个黑窗
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 },
        (err, stdout, stderr) => resolve(err ? undefined : parseVersion(`${stdout}\n${stderr}`)),
      )
    } catch {
      // 同步抛错（路径非法、Windows 上直接 exec .cmd 被拒）也只是取不到
      resolve(undefined)
    }
  })
}

/** agent id → CLI 版本（取不到的不在表里）。并行探测，不会 reject */
export async function agentVersions(configs: AgentConfig[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    configs.map(async (cfg) => {
      const bin = cliOf(cfg)
      if (!bin) return
      const version = await probeVersion(bin, cfg.env)
      if (version) out.set(cfg.id, version)
    }),
  )
  return out
}

/** 能不能 exec：带路径的直接查；脚本（.js / .mjs / .cjs，用 node 起）只要可读；裸命令名在 PATH 里找 */
export async function runnable(bin: string): Promise<boolean> {
  const script = /\.[cm]?js$/.test(bin)
  const mode = script || process.platform === 'win32' ? constants.R_OK : constants.X_OK
  const ok = (p: string) => access(p, mode).then(() => true, () => false)
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return ok(bin)
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (await ok(join(dir, bin + ext))) return true
  }
  return false
}
