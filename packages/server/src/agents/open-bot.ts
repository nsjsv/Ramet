// ---------- 机器人客户端（@hocuspocus/provider 连自身 ws）----------
// AI 回复块要写进协同文档，但 agent 进程在别处（本机子进程或 connector 机器上），
// 中心用一条直连 ws 会话代它写。两种入口共用这一段：
//   - openBotDoc：调用 /continue 的浏览器把 cookie 传进来，复用那份用户会话（正常路径）
//   - openBotAsUser：跨 server 重启认领在飞回合时中心只有 user_id（cookie 不进库），
//     临时签发一张会话，收尾即作废
// 两者的 ws 升级都带 x-ramet-bot 进程内密钥，服务端核过才把这次写入记成 agent。
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { DELETE_SESSION, INSERT_SESSION, SESSION_COOKIE } from '../auth.js'

/** 等服务端确认收下机器人客户端的全部写入，有上限：服务端不回也不能把收尾挂死 */
const BOT_DRAIN_MS = 3000
export const BOT_SYNC_TIMEOUT_MS = 15_000

export function drainBot(provider: HocuspocusProvider): Promise<void> {
  if (!provider.hasUnsyncedChanges) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const finish = (): void => {
    clearTimeout(timer)
    provider.off('unsyncedChanges', check)
    resolve()
  }
  const check = (): void => {
    if (!provider.hasUnsyncedChanges) finish()
  }
  const timer = setTimeout(finish, BOT_DRAIN_MS)
  provider.on('unsyncedChanges', check)
  return promise
}

export type Bot = { provider: HocuspocusProvider; doc: Y.Doc }

/** 连本文档的协同会话：cookieHeader + 进程内密钥 + agent 归属头 */
function connect(opts: {
  pageId: string
  wsPort: () => number
  botSecret: string
  cookieHeader: string
  agentId: string
}): Bot {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, undefined, {
        headers: {
          cookie: opts.cookieHeader,
          'x-ramet-bot': opts.botSecret,
          'x-ramet-agent': encodeURIComponent(opts.agentId),
        },
      })
    }
  }
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${opts.wsPort()}/collab`,
    WebSocketPolyfill: CookieWebSocket as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: `page:${opts.pageId}`,
    token: 'ramet-bot',
    quiet: true,
  })
  // provider.destroy() 不管外部传入的 socket（preserveConnection 缺省为真，只 detach）：不跟着销毁，ws 就一直开着，
  // 30 秒没消息还会自动重连，空连接再被服务端以 4401 踢掉（日志里误导性的「An authentication token is required」），
  // connectionChecker 定时器从此常驻。必须排在 provider 自己的 destroy 之后，那时它已摘掉挂在 socket 上的监听
  // （先销毁 socket 的话，socket 的 destroy 事件会经 provider 转发回来，互相触发）
  const destroyProvider = provider.destroy.bind(provider)
  provider.destroy = () => {
    destroyProvider()
    wsProvider.destroy()
  }
  return { provider, doc: provider.document }
}

async function waitSynced(provider: HocuspocusProvider): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  provider.on('synced', () => resolve())
  const timeout = setTimeout(() => reject(new Error('机器人客户端连接超时')), BOT_SYNC_TIMEOUT_MS)
  timeout.unref?.()
  try {
    await promise
  } catch (e) {
    provider.destroy()
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

/** 复用发起者的浏览器会话（正常一轮）。失败时 provider 已销毁 */
export async function openBotDoc(opts: {
  pageId: string
  wsPort: () => number
  botSecret: string
  cookieHeader: string
  agentId: string
}): Promise<Bot> {
  const bot = connect(opts)
  await waitSynced(bot.provider)
  return bot
}

/** 认领期专用：中心没有 cookie，用 user_id 临时签一张只给这次写入用的会话。
 *  收尾时调用 revoke() 删掉它，浏览器 cookie 不存进 open_runs。 */
export async function openBotAsUser(opts: {
  pool: Pool
  pageId: string
  wsPort: () => number
  botSecret: string
  userId: string
  agentId: string
}): Promise<Bot & { revoke: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  await opts.pool.query(INSERT_SESSION, [token, opts.userId])
  const revoke = async (): Promise<void> => {
    await opts.pool.query(DELETE_SESSION, [token]).catch(() => undefined)
  }
  try {
    const bot = connect({ ...opts, cookieHeader: `${SESSION_COOKIE}=${token}` })
    await waitSynced(bot.provider)
    return { ...bot, revoke }
  } catch (err) {
    await revoke()
    throw err
  }
}
