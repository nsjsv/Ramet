// ---------- connector 侧的配对：申请链接 → 打印 → 等浏览器确认 → 落盘 ----------
// 中心侧见 agents/pairing.ts。这里不带任何密钥：连 /connector/pair 发 pair-request，中心回一次性码，
// 拼成 <中心>/connect/<码> 打印给人；用户在浏览器选空间确认后，长期 token 经同一条连接下发（paired），写进本地配置。
// 链接只在这条连接还开着时有效：进程退出 / 断线即作废，重新执行再申请。

import WebSocket from 'ws'
import { CONNECTOR_PAIR_PATH, type ConnectorAgentInfo, type PairReply } from '../agents/protocol.js'
import { writeConnectorConfig, type ConnectorConfig } from './access.js'
import { httpBase } from './grant-cli.js'

/** 连上中心并拿到链接的时限（拿到链接后按链接自己的有效期等） */
const LINK_TIMEOUT_MS = 20_000
/** 链接到期后再多等一会儿：到期由中心判，它会发 pair-error */
const EXPIRY_GRACE_MS = 30_000

export type PairInput = { name: string; cwd: string; agents: ConnectorAgentInfo[] }

/** 把 cloud 地址归一化成 ws(s) 源：用户填 http://host 或 wss://host 都行（配置里存的就是它） */
export function cloudOrigin(cloud: string): string {
  const url = new URL(cloud)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  return `${url.protocol}//${url.host}`
}

/** 申请配对并等浏览器确认，返回长期 token 与主人（确认的人） */
function requestPair(
  origin: string,
  input: PairInput,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ connectorId: string; token: string; ownerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin}${CONNECTOR_PAIR_PATH}`)
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (err: Error | null, value?: { connectorId: string; token: string; ownerId: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      ws.close()
      if (err) reject(err)
      else resolve(value!)
    }
    const arm = (ms: number, message: string): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        ws.terminate()
        done(new Error(message))
      }, ms)
      timer.unref()
    }
    const onAbort = (): void => done(new Error('配对已取消'))
    signal?.addEventListener('abort', onAbort)
    arm(LINK_TIMEOUT_MS, '连不上中心或中心没有回应（中心地址是否正确？）')
    ws.on('open', () => ws.send(JSON.stringify({ t: 'pair-request', name: input.name, defaultCwd: input.cwd, agents: input.agents })))
    ws.on('message', (data) => {
      let msg: PairReply
      try {
        msg = JSON.parse(String(data)) as PairReply
      } catch {
        return
      }
      if (msg.t === 'pair-link') {
        const url = `${httpBase(origin)}/connect/${msg.code}`
        log('请在浏览器打开下面的链接，登录后选择空间并确认接入（10 分钟内有效，只能用一次）：')
        log('')
        log(`    ${url}`)
        log('')
        log(`确认页上的校验码应为 ${msg.code}；不是你本人在这台机器上发起的配对，不要确认。等待确认…`)
        arm(Math.max(0, Date.parse(msg.expiresAt) - Date.now()) + EXPIRY_GRACE_MS, '配对链接已过期，请重新执行')
      } else if (msg.t === 'paired') {
        done(null, { connectorId: msg.connectorId, token: msg.token, ownerId: msg.ownerId })
      } else if (msg.t === 'pair-error') {
        done(new Error(msg.message))
      }
    })
    ws.on('close', () => done(new Error('与中心的连接断开，配对没有完成，请重新执行')))
    ws.on('error', (err) => done(err))
  })
}

/** 要不要先配对：没有配置，或这次指定的中心与已配对的不同（老配置没记中心的不算） */
export function needsPair(config: ConnectorConfig | null, origin: string): boolean {
  return !config || (config.cloud !== '' && config.cloud !== origin)
}

/** 配对并落盘，返回新 token。重新配对 = 新身份：主人以确认的人为准，旧的授权名单作废（它属于旧的 connectorId） */
export async function pairAndSave(
  origin: string,
  input: PairInput,
  tokenFile: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const paired = await requestPair(origin, input, log, signal)
  log(`配对成功：connectorId=${paired.connectorId}`)
  writeConnectorConfig(tokenFile, { token: paired.token, cloud: origin, ownerId: paired.ownerId })
  log(`token 已写入 ${tokenFile}`)
  return paired.token
}
