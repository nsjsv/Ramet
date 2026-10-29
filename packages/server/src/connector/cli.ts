// ---------- connector CLI 入口 ----------
// 用法（agent 所在机器上跑）：
//   ramet-connector start --cloud http://<中心地址>   # 安装包（scripts/pack-connector.mjs）：打印配对链接，浏览器确认后装成后台服务
//   npm run connector -w packages/server -- start --cloud ...   # 源码里同样可以
//   npm run connector -w packages/server -- --cloud ...         # 不带子命令 = 前台运行（同 run）
//
// 本机 agent 清单来自与中心同一套配置源：RAMET_AGENTS 环境变量或 cwd 下 agents.json（后台服务的 cwd 是 ~/.ramet）。

import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropOuterClaudeSession } from '../claude-session-env.js'
import { readConnectorConfig } from './access.js'
import { GRANT_HELP, runGrantCommand, stdioIo } from './grant-cli.js'
import { defaultTokenFile, localAgents, pairOnly, runConnector } from './index.js'
import { cloudOrigin, needsPair } from './pair.js'
import {
  installService,
  KIND_TEXT,
  loadEnvSnapshot,
  logFile,
  rametDir,
  removeService,
  rotateLog,
  saveEnvSnapshot,
  serviceStatus,
  type Launch,
} from './service.js'
import { supervise } from './supervise.js'

const SCRIPT = fileURLToPath(import.meta.url)
/** 源码运行时入口是 cli.ts：服务里要带 tsx 加载器；安装包里是打好的 connector.mjs，直接 node 跑 */
const FROM_SOURCE = SCRIPT.endsWith('.ts')
const CMD = FROM_SOURCE ? 'npm run connector -w packages/server --' : 'ramet-connector'

function launch(): Launch {
  return { node: process.execPath, prefix: FROM_SOURCE ? ['--import', import.meta.resolve('tsx')] : [], script: SCRIPT }
}

/** 安装包里 package.json 与入口同目录；源码运行没有，显示 dev */
function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

const HELP = `ramet connector —— 把本机 agent 接进中心 server（出站 WSS，无需公网端口）

后台服务（开机 / 登录自启，崩了自动拉起，断线自动重连）:
  ${CMD} start --cloud <中心地址>   首次：终端打印配对链接，到浏览器选空间确认后在后台运行
  ${CMD} start            重启后台服务（装了新 agent CLI、改了 PATH、升级安装包后执行一次）
  ${CMD} start --repair   重新配对（机器被撤销 / 拒绝后，或想换个空间）
  ${CMD} status           看状态和最近日志
  ${CMD} logs [-f] [-n 行数]
  ${CMD} stop             停止并取消自启

前台运行（调试用，Ctrl+C 退出）:
  ${CMD} run [--cloud <url>] [--repair]

选项:
  --cloud <url>      中心地址 http(s)://host[:port]（就是你在浏览器里打开的地址；配对后存进配置，之后不用再给；
                     换成别的中心会重新配对）
  --repair           重新配对：打印新的配对链接，确认后换成新身份（token 落 ~/.ramet/connector.json）
  --name <name>      显示名（默认 hostname）
  --cwd <dir>        agent 默认工作目录（start 默认家目录，run 默认当前目录）
  --token-file <p>   连接配置路径（默认 ~/.ramet/connector.json）
  --version          显示版本
  --help             显示本帮助

授权子命令（机器主人在这台机器上确认 / 查看 / 收回别人的使用授权）:
  ${CMD} grant confirm <确认码>        确认网页上发起的授权（要再输入 yes）
  ${CMD} grant list                    看本机授权名单
  ${CMD} grant revoke <用户名或 id>    收回某人在这台机器上的授权

环境变量:
  RAMET_IDLE_MS      适配器闲置回收窗口毫秒（默认 10 分钟；0 = 到期立即回收，仅调试/验收用）

本机 agent 配置: RAMET_AGENTS 环境变量，或 agents.json（与中心同格式；后台服务读 ~/.ramet/agents.json，run 读当前目录），例如
  RAMET_AGENTS='[{"id":"omp","label":"omp","command":"omp","args":["acp"]}]'
后台服务用的是执行 start 那一刻的终端环境（PATH 等快照在 ~/.ramet/connector.env.json）。
`

type Args = {
  cloud?: string
  repair?: boolean
  name?: string
  cwd?: string
  tokenFile?: string
  help?: boolean
  service?: boolean
  follow?: boolean
  lines?: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined) throw new Error(`${arg} 缺参数值`)
      i++
      return value
    }
    switch (arg) {
      case '--cloud':
        out.cloud = take()
        break
      case '--pair':
        throw new Error(`配对码已取消：执行 ${CMD} start --cloud <中心地址>，按终端里打印的链接到浏览器确认即可`)
      case '--repair':
        out.repair = true
        break
      case '--name':
        out.name = take()
        break
      case '--cwd':
        out.cwd = take()
        break
      case '--token-file':
        out.tokenFile = take()
        break
      case '--service':
        out.service = true
        break
      case '-f':
      case '--follow':
        out.follow = true
        break
      case '-n':
      case '--lines':
        out.lines = Number(take())
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        if (arg?.startsWith('-')) throw new Error(`未知参数 ${arg}（--help 看用法）`)
    }
  }
  return out
}

/** 前台常驻。--service = 由后台服务拉起：先铺回 start 时的终端环境、日志带时间戳并定时轮转 */
async function run(args: Args): Promise<void> {
  const tokenFile = args.tokenFile ?? defaultTokenFile()
  let log: ((line: string) => void) | undefined
  if (args.service) {
    const n = loadEnvSnapshot()
    dropOuterClaudeSession() // 老版本 start 拍的快照里可能还带着
    rotateLog()
    setInterval(rotateLog, 3_600_000).unref()
    log = (line) => console.log(`${new Date().toISOString()} [connector] ${line}`)
    log(`后台服务启动（版本 ${version()}，铺回 ${n} 个环境变量）`)
  }
  const config = readConnectorConfig(tokenFile)
  const cloud = args.cloud ?? config?.cloud
  if (args.service && !(cloud && config?.token)) {
    // 正常退出（码 0）：服务管理器只拉起异常退出的，配置没了拉起来也没用；后台没人看终端，不在这里配对
    log?.(`没有连接配置（${tokenFile}），停止；先执行 ${CMD} start --cloud <中心地址>`)
    return
  }
  if (!cloud) {
    console.error(HELP)
    process.exitCode = 1
    return
  }
  await runConnector({
    cloud,
    repair: args.repair,
    name: args.name,
    cwd: args.cwd,
    tokenFile,
    log,
    // 调试/验收用：缩短闲置窗口，验证在飞轮次不会被回收（生产不设，用默认 10 分钟）
    idleMs: process.env.RAMET_IDLE_MS ? Number(process.env.RAMET_IDLE_MS) : undefined,
  })
}

function tailLines(n: number): string[] {
  try {
    return readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

async function start(args: Args): Promise<void> {
  if (process.getuid?.() === 0) console.log('提示：正在用 root 执行，服务会装在 root 名下。一般应以普通用户执行 start（只有 npm i -g 那步可能要 sudo）。')
  const tokenFile = resolve(args.tokenFile ?? defaultTokenFile())
  const cwd = resolve(args.cwd ?? homedir())
  mkdirSync(rametDir(), { recursive: true })
  process.chdir(rametDir()) // 与后台服务同一个 cwd：两边认的都是 ~/.ramet/agents.json
  const config = readConnectorConfig(tokenFile)
  const log = (line: string) => console.log(`[connector] ${line}`)
  const cloud = args.cloud ?? config?.cloud
  if (!config || args.repair || (args.cloud && needsPair(config, cloudOrigin(args.cloud)))) {
    if (!cloud) throw new Error(`首次接入要带中心地址：${CMD} start --cloud <中心地址>`)
    if (config && !args.repair) console.log(`已配对的中心是 ${config.cloud}，这次换成 ${cloudOrigin(cloud)}，重新配对。`)
    // 前台配对：链接打在这个终端里，确认完再装后台服务（后台没人看终端）
    await pairOnly({ cloud, name: args.name, cwd, tokenFile, log })
  } else {
    localAgents(log)
  }

  saveEnvSnapshot()
  const runArgs = ['--service', '--cwd', cwd, ...(args.name ? ['--name', args.name] : []), ...(args.tokenFile ? ['--token-file', tokenFile] : [])]
  const { kind, notes } = installService(launch(), runArgs)
  // 等一下再看：起不来（node 换了路径、入口被删）当场说，别让人以为好了
  await new Promise((r) => setTimeout(r, 2_000))
  const status = serviceStatus()
  if (status.running) {
    console.log(`已在后台运行（${KIND_TEXT[kind]}${kind === 'plain' ? '' : '，开机 / 登录后自动启动'}）。`)
  } else {
    console.log(`服务已注册（${KIND_TEXT[kind]}），但还没看到进程在跑。最近日志：`)
    for (const line of tailLines(20)) console.log(`  ${line}`)
  }
  for (const line of notes) console.log(line)
  console.log(`  状态：${CMD} status\n  日志：${CMD} logs -f\n  停止并取消自启：${CMD} stop`)
}

function status(args: Args): void {
  const s = serviceStatus()
  const config = readConnectorConfig(args.tokenFile ?? defaultTokenFile())
  const autostart = s.kind === 'plain' ? '' : s.installed ? '，已注册自启' : '，未注册自启'
  console.log(`版本：${version()}`)
  console.log(`中心：${config?.cloud ?? '（还没配对）'}`)
  console.log(`后台服务：${KIND_TEXT[s.kind]}${autostart}，${s.running ? `运行中（pid ${s.pid ?? '?'}）` : '没在运行'}`)
  console.log(`日志：${logFile()}`)
  const lines = tailLines(10)
  if (lines.length) {
    console.log('最近日志：')
    for (const line of lines) console.log(`  ${line}`)
  }
}

async function logs(args: Args): Promise<void> {
  const lines = tailLines(args.lines && args.lines > 0 ? args.lines : 100)
  if (lines.length) console.log(lines.join('\n'))
  if (!args.follow) return
  const file = logFile()
  const size = () => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }
  let offset = size()
  // 轮询而不用 fs.watch：日志会被轮转清零，watch 在各平台上对这种情况的表现不一致
  setInterval(() => {
    const now = size()
    if (now < offset) offset = 0
    if (now === offset) return
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(now - offset)
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    offset = now
    process.stdout.write(buf)
  }, 1_000)
  await new Promise(() => {}) // Ctrl+C 退出
}

async function main(): Promise<void> {
  // 在 Claude Code 里敲的 start / run：外层会话的变量不能进快照，也不能进 agent 和终端
  dropOuterClaudeSession()
  const argv = process.argv.slice(2)
  const [first, ...rest] = argv
  // 授权子命令：不连中心 websocket，只对 REST 说话（connector token 认证）
  if (first === 'grant') {
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(GRANT_HELP)
      return
    }
    process.exitCode = await runGrantCommand(rest, { defaultTokenFile: defaultTokenFile(), io: stdioIo() })
    return
  }
  if (first === '--version' || first === '-v') {
    console.log(version())
    return
  }
  if (first === 'supervise') return supervise(SCRIPT, rest)
  // 不带子命令（老写法 `--cloud …`）= 前台运行
  const sub = first && !first.startsWith('-') ? first : 'run'
  const args = parseArgs(sub === first ? rest : argv)
  if (args.help || argv.length === 0) {
    console.log(HELP)
    if (argv.length === 0) process.exitCode = 1
    return
  }
  switch (sub) {
    case 'run':
      return run(args)
    case 'start':
      return start(args)
    case 'stop':
      removeService()
      console.log('已停止，开机 / 登录后也不会再自动启动（重新启用：start）。')
      return
    case 'status':
      return status(args)
    case 'logs':
      return logs(args)
    default:
      throw new Error(`未知子命令 ${sub}（--help 看用法）`)
  }
}

await main().catch((err: unknown) => {
  console.error(`[connector] 失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
