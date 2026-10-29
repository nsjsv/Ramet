// ---------- connector 命令行：机器授权的本机确认 / 查看 / 收回 ----------
//   grant confirm <确认码>     在这台机器上确认一次授权（网页上发起的授权，必须在这里确认才生效）
//   grant list                 看本机的授权名单（第二道闸认的就是这份）
//   grant revoke <用户名或 id> 收回某人在这台机器上的授权（先删本机名单，再通知中心）
// 本机授权名单（~/.ramet/connector.json 的 grants）只有这里的 confirm 能加人，中心的任何帧都不能（connector/access.ts）。
// confirm 的顺序有讲究：先看（GET），人工敲 yes，先写本地名单，再通知中心确认（POST），中心没确认成就把刚写的本地条目删掉。
// 这样中心确认生效时，本机名单里一定已经有这个人；反过来的失败（本地写了中心没确认）会被回滚，不会留下「本机放行、中心不知道」。
// stdin / stdout / fetch 都可注入，便于测试。

import { createInterface } from 'node:readline'
import type { GrantInfo } from '../agents/machine-grants.js'
import { CONNECTOR_TOKEN_HEADER } from '../agents/protocol.js'
import { addLocalGrant, readConnectorConfig, removeLocalGrants, type ConnectorConfig } from './access.js'

export type GrantIo = {
  out: (line: string) => void
  /** 提一个问题，返回敲的一整行（不含换行）；stdin 关了 / 没有输入 → '' */
  ask: (question: string) => Promise<string>
  fetch: typeof fetch
}

export function stdioIo(): GrantIo {
  return {
    out: (line) => console.log(line),
    ask: (question) =>
      new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        let answered = false
        rl.question(question, (answer) => {
          answered = true
          rl.close()
          resolve(answer)
        })
        rl.on('close', () => {
          if (!answered) resolve('')
        })
      }),
    fetch,
  }
}

export const GRANT_HELP = `用法:
  grant confirm <确认码>        在这台机器上确认网页上发起的授权（要再输入 yes）
  grant list                    看本机授权名单
  grant revoke <用户名或 id>    收回某人在这台机器上的授权
选项:
  --token-file <p>   连接配置路径（默认 ~/.ramet/connector.json）
  --cloud <url>      中心地址（默认取配置里的）`

type Parsed = { sub: string; rest: string[]; tokenFile?: string; cloud?: string }

function parse(argv: string[]): Parsed | null {
  const rest: string[] = []
  const out: Parsed = { sub: '', rest }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--token-file' || arg === '--cloud') {
      const value = argv[++i]
      if (!value) return null
      if (arg === '--token-file') out.tokenFile = value
      else out.cloud = value
    } else if (arg.startsWith('--')) return null
    else if (!out.sub) out.sub = arg
    else rest.push(arg)
  }
  return out
}

/** 配置里存的是 ws(s) 源（cloudOrigin），REST 要 http(s) */
export function httpBase(cloud: string): string {
  const url = new URL(cloud)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:'
  return `${url.protocol}//${url.host}`
}

const SCOPE_TEXT = { agent: 'agent（让 agent 在这台电脑上跑任务、批准它要做的操作）', machine: '终端与文件（在这台电脑上运行命令、读写文件）' }

function stamp(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

type Ctx = { tokenFile: string; config: ConnectorConfig; base: string; io: GrantIo }

async function call(ctx: Ctx, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await ctx.io.fetch(`${ctx.base}${path}`, {
    method,
    headers: { [CONNECTOR_TOKEN_HEADER]: ctx.config.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function asInfo(json: unknown): GrantInfo | null {
  if (!json || typeof json !== 'object') return null
  const g = json as Partial<GrantInfo>
  const scopes = Array.isArray(g.scopes) ? g.scopes.filter((s) => s === 'agent' || s === 'machine') : []
  if (typeof g.grantId !== 'string' || typeof g.userId !== 'string' || typeof g.username !== 'string' || typeof g.expiresAt !== 'string' || scopes.length === 0) return null
  return {
    grantId: g.grantId,
    userId: g.userId,
    username: g.username,
    scopes,
    expiresAt: g.expiresAt,
    grantedById: typeof g.grantedById === 'string' ? g.grantedById : '',
    grantedBy: typeof g.grantedBy === 'string' ? g.grantedBy : '',
    machineName: typeof g.machineName === 'string' ? g.machineName : '',
  }
}

async function confirm(code: string, ctx: Ctx): Promise<number> {
  const { io } = ctx
  // 本机还没记录主人时没法核对发起人，不确认（宁可多拒绝），也不必去问中心
  if (!ctx.config.ownerId) {
    io.out('本机还没有记录这台机器的主人：请先让 connector 连上中心一次（或重新配对），再确认授权。')
    return 1
  }
  const peek = await call(ctx, 'GET', `/api/connector/grants/${encodeURIComponent(code)}`)
  if (peek.status === 404) {
    io.out('确认码无效：不存在、已过期（15 分钟有效）、已被确认、已被取消，或不属于这台机器。')
    return 1
  }
  const info = peek.status === 200 ? asInfo(peek.json) : null
  if (!info) {
    io.out(`中心返回了无法识别的内容（HTTP ${peek.status}），已取消。`)
    return 1
  }
  // 发起授权的必须是这台机器的主人（钉在本机配置里的 ownerId）：不是就不是主人授权的，不确认
  if (info.grantedById !== ctx.config.ownerId) {
    io.out('这条授权不是本机主人发起的，已拒绝。')
    return 1
  }
  const scopes = info.scopes.map((s) => `    · ${SCOPE_TEXT[s]}`)
  io.out('')
  io.out('============================================================')
  io.out(`  即将允许「${info.username}」使用这台电脑（${info.machineName}）的：`)
  for (const line of scopes) io.out(line)
  io.out(`  到期：${stamp(info.expiresAt)}${info.grantedBy ? `（由 ${info.grantedBy} 发起）` : ''}`)
  io.out('')
  io.out('  这等于把这台电脑交给他。到期之前，他可以随时使用上面这些能力；')
  io.out('  你可以随时用 `grant revoke` 或在网页上收回，收回后立即生效。')
  io.out('============================================================')
  const answer = await io.ask('确认请输入 yes（输入其它任何内容都会取消）: ')
  if (answer !== 'yes') {
    io.out('已取消，没有授权。')
    return 1
  }
  const local = { userId: info.userId, scopes: info.scopes, expiresAt: info.expiresAt, grantId: info.grantId, username: info.username }
  if (addLocalGrant(ctx.tokenFile, local) !== 'ok') {
    io.out(`本机连接配置读不到（${ctx.tokenFile}），无法写入授权名单。`)
    return 1
  }
  let confirmed = false
  let reason = ''
  try {
    const done = await call(ctx, 'POST', `/api/connector/grants/${encodeURIComponent(code)}/confirm`)
    confirmed = done.status === 200
    if (!confirmed) reason = `中心拒绝了确认（HTTP ${done.status}）`
  } catch (err) {
    reason = `连不上中心：${err instanceof Error ? err.message : String(err)}`
  }
  if (!confirmed) {
    // 中心没确认成功：刚写的本地条目撤回，不留「本机放行、中心不认」
    removeLocalGrants(ctx.tokenFile, { grantId: info.grantId })
    io.out(`${reason}。已撤回本机名单里的这一条，授权没有生效。`)
    return 1
  }
  io.out(`已授权：${info.username}（${info.scopes.join(' + ')}），到期 ${stamp(info.expiresAt)}。`)
  return 0
}

function list(ctx: Ctx): number {
  const { io, config } = ctx
  io.out(`本机授权名单（${ctx.tokenFile}）:`)
  io.out(`  主人: ${config.ownerId ?? '（还没记录）'}`)
  const grants = config.grants ?? []
  if (grants.length === 0) io.out('  （没有授权给任何人）')
  for (const g of grants) {
    const expired = Date.parse(g.expiresAt) <= Date.now()
    io.out(`  ${g.username ?? g.userId}  [${g.scopes.join(', ')}]  到期 ${stamp(g.expiresAt)}${expired ? '（已过期）' : ''}`)
  }
  return 0
}

async function revoke(who: string, ctx: Ctx): Promise<number> {
  const { io } = ctx
  const matched = (ctx.config.grants ?? []).filter((g) => g.userId === who || g.username === who)
  // 先删本机名单（这一步生效就够了，第二道闸立刻拒绝他），再通知中心
  const targets = matched.length > 0 ? [...new Set(matched.map((g) => g.userId))] : [who]
  let removed = 0
  for (const userId of targets) removed += removeLocalGrants(ctx.tokenFile, { userId })
  let revoked = 0
  try {
    for (const userId of targets) {
      const done = await call(ctx, 'POST', '/api/connector/grants/revoke', { userId })
      if (done.status !== 200) throw new Error(`中心返回 HTTP ${done.status}`)
      revoked += Number((done.json as { revoked?: number } | null)?.revoked ?? 0)
    }
  } catch (err) {
    io.out(`本机名单已删除 ${removed} 条，但通知中心失败：${err instanceof Error ? err.message : String(err)}`)
    io.out('中心上的授权仍然有效，请在网页上收回，或稍后重试。')
    return 1
  }
  if (removed === 0 && revoked === 0) {
    io.out(`没有找到「${who}」的授权（本机名单和中心都没有）。`)
    return 1
  }
  io.out(`已收回「${who}」：本机名单删除 ${removed} 条，中心收回 ${revoked} 条。`)
  return 0
}

/** 入口。argv 是 `grant` 之后的参数；返回退出码（0 成功 / 1 失败 / 2 用法错误） */
export async function runGrantCommand(argv: string[], opts: { defaultTokenFile: string; io: GrantIo }): Promise<number> {
  const { io } = opts
  const parsed = parse(argv)
  const need = parsed?.sub === 'list' ? 0 : 1
  if (!parsed || !['confirm', 'list', 'revoke'].includes(parsed.sub) || parsed.rest.length !== need) {
    io.out(GRANT_HELP)
    return 2
  }
  const tokenFile = parsed.tokenFile ?? opts.defaultTokenFile
  const config = readConnectorConfig(tokenFile)
  if (!config) {
    io.out(`读不到连接配置（${tokenFile}）：这台机器还没有配对过。先执行 start --cloud <中心地址> 接入中心。`)
    return 1
  }
  const cloud = parsed.cloud ?? config.cloud
  let base: string
  try {
    base = httpBase(cloud)
  } catch {
    io.out('配置里没有可用的中心地址，请加 --cloud http://<中心地址>。')
    return 1
  }
  const ctx: Ctx = { tokenFile, config, base, io }
  try {
    if (parsed.sub === 'list') return list(ctx)
    if (parsed.sub === 'confirm') return await confirm(parsed.rest[0]!, ctx)
    return await revoke(parsed.rest[0]!, ctx)
  } catch (err) {
    io.out(`失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
