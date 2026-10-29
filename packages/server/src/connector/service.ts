// ---------- connector 后台服务：开机 / 登录自启 + 崩溃自动拉起（三端各用原生机制，不要管理员权限） ----------
//   Linux   systemd --user（Restart=on-failure；尽量开 linger，注销 / 没登录也跑）
//   macOS   launchd LaunchAgent（RunAtLoad + KeepAlive.SuccessfulExit=false）
//   Windows 「启动」文件夹里的隐藏窗口 .vbs，自带守护进程 supervise（supervise.ts，崩了重拉）
//   都不行（WSL1 / 容器 / 没有 user bus）：只起守护进程，不自启
// 三端都只在异常退出时拉起：退出码 0（被中心撤销 / 拒绝（4403）、没配对、收到停止信号）拉起来只会被反复拒绝。
// 服务进程的 cwd 一律是 ~/.ramet（agents.json 放这里）；日志一律追加到 ~/.ramet/connector.log。
//
// 服务拉起的进程拿不到终端里的 PATH（nvm、npm -g 装的 claude / codex 都靠它），所以 start 时把当前终端环境快照到
// ~/.ramet/connector.env.json（0600），服务里的 `run --service` 启动时先读回来。

import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const UNIT = 'ramet-connector.service'
const LABEL = 'com.ramet.connector'
const LOG_MAX_BYTES = 10 * 1024 * 1024

/** 服务要执行的程序：node [--import tsx] <入口>（源码运行时入口是 cli.ts，要带 tsx 加载器） */
export type Launch = { node: string; prefix: string[]; script: string }
export type ServiceKind = 'systemd' | 'launchd' | 'windows' | 'plain'

export const KIND_TEXT: Record<ServiceKind, string> = {
  systemd: 'systemd 用户服务',
  launchd: 'launchd 登录项',
  windows: 'Windows 启动项',
  plain: '后台进程（不会开机自启）',
}

export function rametDir(): string {
  return join(homedir(), '.ramet')
}
export function logFile(): string {
  return join(rametDir(), 'connector.log')
}
function envFile(): string {
  return join(rametDir(), 'connector.env.json')
}
export function pidFile(): string {
  return join(rametDir(), 'connector.pid')
}

/** 只属于这一个终端会话的变量：带进服务没意义，有的（SSH_AUTH_SOCK）还会指向早已不在的东西 */
const SESSION_VARS = new Set([
  'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'COLORTERM',
  'COLUMNS', 'LINES', 'SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY', 'SSH_AUTH_SOCK', 'TMUX', 'TMUX_PANE', 'STY',
  'WINDOWID', 'INIT_CWD', 'WT_SESSION', 'WT_PROFILE_ID', 'PS1', 'PROMPT',
])
const SESSION_PREFIXES = ['NPM_', 'VSCODE_', 'ITERM_', 'KITTY_', 'KONSOLE_', 'GHOSTTY_', 'WEZTERM_', 'ALACRITTY_']

export function snapshotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (value === undefined || SESSION_VARS.has(upper) || SESSION_PREFIXES.some((p) => upper.startsWith(p))) continue
    out[key] = value
  }
  return out
}

export function saveEnvSnapshot(): void {
  mkdirSync(rametDir(), { recursive: true })
  writeFileSync(envFile(), `${JSON.stringify(snapshotEnv(), null, 2)}\n`, { mode: 0o600 })
}

/** 服务进程启动时调：把 start 时的终端环境铺回 process.env；返回铺了几个 */
export function loadEnvSnapshot(): number {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(envFile(), 'utf8'))
  } catch {
    return 0
  }
  if (typeof raw !== 'object' || raw === null) return 0
  let n = 0
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    process.env[key] = value
    n++
  }
  return n
}

/** 日志超过 10MB：留一份 .1，原文件清零（写端都是追加模式，清零后接着从头写） */
export function rotateLog(): void {
  const file = logFile()
  try {
    if (statSync(file).size <= LOG_MAX_BYTES) return
    copyFileSync(file, `${file}.1`)
    truncateSync(file, 0)
  } catch {
    // 没有日志 / 被占用：下次再说
  }
}

function exec(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, out: String(e.stderr || e.message || err).trim() }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function serviceKind(): ServiceKind {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux' && exec('systemctl', ['--user', 'show-environment']).ok) return 'systemd'
  return 'plain'
}

// ---------- 各平台的服务定义（纯函数，便于核对） ----------

/** systemd 的 ExecStart 参数：双引号包起来，\ 与 " 转义，% 是说明符、$ 是变量展开，都要双写 */
function systemdQuote(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
}

export function systemdUnit(launch: Launch, args: string[], dir: string, log: string): string {
  const execStart = [launch.node, ...launch.prefix, launch.script, ...args].map(systemdQuote).join(' ')
  const path = (p: string) => p.replace(/%/g, '%%')
  return [
    '[Unit]',
    'Description=Ramet connector',
    '',
    '[Service]',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${path(dir)}`,
    'Restart=on-failure',
    'RestartSec=5',
    `StandardOutput=append:${path(log)}`,
    `StandardError=append:${path(log)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function launchdPlist(launch: Launch, args: string[], dir: string, log: string): string {
  const argv = [launch.node, ...launch.prefix, launch.script, ...args].map((a) => `    <string>${xml(a)}</string>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

/** Windows 命令行的一个参数（CommandLineToArgvW 规则：引号前的反斜杠、结尾的反斜杠都要双写） */
export function winQuote(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/** 「启动」文件夹里的 .vbs：隐藏窗口（Run 的第二个参数 0）拉起守护进程，不等它结束 */
export function windowsStartupVbs(launch: Launch, args: string[], dir: string): string {
  const cmdline = [launch.node, ...launch.prefix, launch.script, ...args].map(winQuote).join(' ')
  const lit = (s: string) => `"${s.replace(/"/g, '""')}"`
  return [
    "' Ramet connector：登录后在后台启动（隐藏窗口）。取消自启：ramet-connector stop，或删掉本文件",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${lit(dir)}`,
    `sh.Run ${lit(cmdline)}, 0, False`,
    '',
  ].join('\r\n')
}

function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT)
}
function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}
function startupPath(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ramet-connector.vbs')
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** pid 文件里的进程还活着、而且看着是自己的守护进程（防 pid 被系统复用后误杀别人） */
function supervisorAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const r =
    process.platform === 'win32'
      ? exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : exec('ps', ['-p', String(pid), '-o', 'command='])
  if (!r.ok) return true // 查不了就信 pid 文件
  return process.platform === 'win32' ? /node/i.test(r.out) : r.out.includes('supervise')
}

function runningSupervisor(): number | null {
  const pid = readPid()
  return pid !== null && supervisorAlive(pid) ? pid : null
}

/** 连同 connector 与它拉起的 agent 一起停（Windows 杀进程树；unix 守护进程是 detached 的进程组组长） */
function stopSupervisor(): void {
  const pid = runningSupervisor()
  if (pid !== null) {
    if (process.platform === 'win32') exec('taskkill', ['/PID', String(pid), '/T', '/F'])
    else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // 已经没了
        }
      }
    }
  }
  rmSync(pidFile(), { force: true })
}

function spawnSupervisor(launch: Launch, args: string[]): void {
  stopSupervisor()
  const child = spawn(launch.node, [...launch.prefix, launch.script, 'supervise', ...args], {
    cwd: rametDir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export type InstallResult = { kind: ServiceKind; notes: string[] }

/** 注册自启并（重新）启动：已在跑的会被重启，以便加载新的 token / 环境 / 程序版本。args 是 `run` 之后的参数 */
export function installService(launch: Launch, args: string[]): InstallResult {
  const dir = rametDir()
  mkdirSync(dir, { recursive: true })
  const kind = serviceKind()
  const notes: string[] = []
  const runArgv = ['run', ...args]
  if (kind === 'systemd') {
    stopSupervisor() // 以前在没有 systemd 的时候起过守护进程
    const file = unitPath()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, systemdUnit(launch, runArgv, dir, logFile()))
    for (const step of [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]) {
      const r = exec('systemctl', ['--user', ...step])
      if (!r.ok) throw new Error(`systemctl --user ${step.join(' ')} 失败：${r.out}`)
    }
    const user = userInfo().username
    const linger = exec('loginctl', ['show-user', user, '-p', 'Linger', '--value'])
    if (!(linger.ok && linger.out.trim() === 'yes') && !exec('loginctl', ['enable-linger', user]).ok) {
      notes.push(`没能开启 linger：注销后服务会停、开机要登录后才跑。需要的话执行 sudo loginctl enable-linger ${user}`)
    }
  } else if (kind === 'launchd') {
    const file = plistPath()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, launchdPlist(launch, runArgv, dir, logFile()))
    const uid = process.getuid?.() ?? 0
    exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
    // bootout 是异步收尾的，紧跟着 bootstrap 可能报 5: Input/output error；没有图形登录（纯 ssh）时退到 user 域
    let last = ''
    let ok = false
    for (let i = 0; i < 6 && !ok; i++) {
      if (i > 0) sleepSync(500)
      const r = exec('launchctl', ['bootstrap', i < 5 ? `gui/${uid}` : `user/${uid}`, file])
      ok = r.ok
      last = r.out
    }
    if (!ok) throw new Error(`launchctl bootstrap 失败：${last}`)
  } else {
    if (kind === 'windows') {
      const file = startupPath()
      mkdirSync(join(file, '..'), { recursive: true })
      // UTF-16LE + BOM：wscript 才认得路径里的中文（用户名是中文很常见）
      writeFileSync(file, `\ufeff${windowsStartupVbs(launch, ['supervise', ...args], dir)}`, 'utf16le')
    } else {
      notes.push('这台机器没有可用的 systemd 用户服务：已在后台启动，但不会开机自启（重启后再执行一次 start）。')
    }
    spawnSupervisor(launch, args)
  }
  return { kind, notes }
}

/** 停止并取消自启 */
export function removeService(): ServiceKind {
  const kind = serviceKind()
  if (kind === 'systemd' && existsSync(unitPath())) {
    exec('systemctl', ['--user', 'disable', '--now', UNIT])
    rmSync(unitPath(), { force: true })
    exec('systemctl', ['--user', 'daemon-reload'])
  } else if (kind === 'launchd') {
    const uid = process.getuid?.() ?? 0
    exec('launchctl', ['bootout', `gui/${uid}/${LABEL}`])
    exec('launchctl', ['bootout', `user/${uid}/${LABEL}`])
    rmSync(plistPath(), { force: true })
  } else if (kind === 'windows') {
    rmSync(startupPath(), { force: true })
  }
  stopSupervisor()
  return kind
}

export type ServiceStatus = { kind: ServiceKind; installed: boolean; running: boolean; pid: number | null }

export function serviceStatus(): ServiceStatus {
  const kind = serviceKind()
  if (kind === 'systemd') {
    const active = exec('systemctl', ['--user', 'is-active', UNIT]).out.trim() === 'active'
    const pid = Number(exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT]).out.trim()) || null
    return { kind, installed: existsSync(unitPath()), running: active, pid }
  }
  if (kind === 'launchd') {
    const uid = process.getuid?.() ?? 0
    let r = exec('launchctl', ['print', `gui/${uid}/${LABEL}`])
    if (!r.ok) r = exec('launchctl', ['print', `user/${uid}/${LABEL}`])
    const pid = r.ok ? Number(/\bpid = (\d+)/.exec(r.out)?.[1]) || null : null
    return { kind, installed: existsSync(plistPath()), running: pid !== null, pid }
  }
  const pid = runningSupervisor()
  return { kind, installed: kind === 'windows' && existsSync(startupPath()), running: pid !== null, pid }
}
