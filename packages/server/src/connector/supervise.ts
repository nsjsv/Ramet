// ---------- 守护进程：Windows 与没有 systemd 的 Linux 用（systemd / launchd 自己会拉起，不经过这里） ----------
// 拉起 `run --service`，异常退出就退避重拉（1 秒起翻倍，封顶 60 秒；稳定跑过 1 分钟就从头算）；
// 退出码 0（被中心撤销 / 拒绝、没配对）不拉，守护进程跟着退出，与 systemd 的 on-failure、launchd 的 SuccessfulExit=false 同口径。
// 断线重连是 connector 自己的事（index.ts），这里只兜进程崩溃。pid 文件写的是守护进程自己的 pid，stop 按它杀进程树。

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { logFile, pidFile, rotateLog } from './service.js'

const RESTART_MIN_MS = 1_000
const RESTART_MAX_MS = 60_000
const STABLE_MS = 60_000

function note(line: string): void {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} [supervise] ${line}\n`)
  } catch {
    // 写不了日志也要接着守
  }
}

/** 常驻；script 是入口文件，args 是 `run` 之后的参数 */
export async function supervise(script: string, args: string[]): Promise<void> {
  writeFileSync(pidFile(), String(process.pid))
  let stopping = false
  let child: ReturnType<typeof spawn> | null = null
  const stop = () => {
    stopping = true
    child?.kill('SIGTERM')
    rmSync(pidFile(), { force: true })
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  let delay = RESTART_MIN_MS
  for (;;) {
    rotateLog()
    const fd = openSync(logFile(), 'a')
    const started = Date.now()
    // execArgv 原样带上：源码运行时里面是 tsx 加载器
    const proc = spawn(process.execPath, [...process.execArgv, script, 'run', ...args], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    child = proc
    closeSync(fd)
    const exit = await new Promise<{ how: string; clean: boolean }>((resolve) => {
      proc.once('error', (err) => resolve({ how: `起不来：${err.message}`, clean: false }))
      proc.once('exit', (code, signal) => resolve({ how: signal ? `被信号 ${signal} 结束` : `退出码 ${code}`, clean: code === 0 }))
    })
    if (stopping) return
    if (exit.clean) {
      note('connector 正常退出（被中心撤销 / 拒绝，或没配对），不再拉起；重新配对后执行 start')
      rmSync(pidFile(), { force: true })
      process.exit(0)
    }
    const how = exit.how
    if (Date.now() - started > STABLE_MS) delay = RESTART_MIN_MS
    note(`connector ${how}，${delay / 1000} 秒后重启`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, RESTART_MAX_MS)
  }
}
