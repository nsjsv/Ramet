// ---------- 收件箱有变化 → 给不在跟前的人推送新出现的条目 ----------
// 挂在收件箱的刷新信号上（index.ts 的 InboxPoke 回调：广播 'inbox' 的同时 poke 这里）。信号不带用户，
// 所以每次为每个有订阅的人现算一遍收件箱（collectInbox：可见性规则的唯一实现，推送不另判权限），
// 和已经通知过的身份（push_sent）比对，新出现的才发。
//   - 人在跟前（任一标签页可见 + 有焦点 + 最近有操作，presence.ts）：身份照样记下、不发，之后也不补推——他已经在应用里看到了；
//   - 一次新出现太多（合盖很久 / 规则刷屏）：前 MAX_BATCH - 1 条照发，其余合成一条「还有 N 件事」。
// 新订阅时先种基线（seed）：开启通知前就在收件箱里的条目不补发。
import type { Pool } from 'pg'
import { moreNotice, noticeIdent, noticeOf, type Notice } from '@ramet/shared/inbox-notice'
import { collectInbox, type InboxHost } from '../inbox.js'
import {
  claimIdents,
  dropEndpoint,
  loadVapidKeys,
  markDelivered,
  markFailed,
  pruneIdents,
  subscribers,
  subscriptionsOf,
  type Subscription,
} from './store.js'
import { checkEndpoint, createTransport, pushHostsFromEnv, PushNetworkError, sendPush, type PushTransport, type VapidKeys } from './webpush.js'

const MAX_BATCH = 10

/** 推给浏览器的内容（sw.js 读这几个字段） */
export type PushPayload = { title: string; body: string; url: string; tag: string }

export type PushDeps = {
  pool: Pool
  inbox: InboxHost
  isActive: (userId: string) => boolean
  /** 测试注入假的推送服务；生产按环境变量建（含代理） */
  transport?: PushTransport
  hosts?: readonly string[]
}

export type DeliverResult = { ok: true } | { ok: false; error: string; gone: boolean }

const payloadOf = (n: Notice): PushPayload => ({ title: n.title, body: n.body, url: n.url, tag: n.tag })

/** VAPID 的 sub：订阅时页面的 https 源；本机 http 开发时没有可用的，给一个保留域名的 mailto */
const subjectOf = (origin: string): string => (origin.startsWith('https://') ? origin : 'mailto:push@ramet.invalid')

/** 状态码 → 给人看的原因（不带响应内容） */
function failureText(status: number): string {
  if (status === 401 || status === 403) return `推送服务拒绝了这条推送（${status}）`
  if (status === 429) return '推送服务限流了，稍后再试（429）'
  return `推送服务返回 ${status}`
}

export class PushDispatcher {
  private readonly transport: PushTransport
  private readonly hosts: readonly string[]
  private running: Promise<void> | null = null
  private again = false
  private closed = false

  constructor(private readonly deps: PushDeps) {
    this.transport = deps.transport ?? createTransport()
    this.hosts = deps.hosts ?? pushHostsFromEnv()
  }

  /** 收件箱有变化。串行：在跑时来的信号排一次，跑完再来一遍（在跑的那次可能没看到刚发生的事） */
  poke(): void {
    if (this.closed) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = this.loop().finally(() => {
      this.running = null
    })
  }

  /** 等在跑的那次（含排队的）跑完；测试与关停用 */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  async close(): Promise<void> {
    this.closed = true
    await this.idle()
  }

  private async loop(): Promise<void> {
    do {
      this.again = false
      try {
        for (const user of await subscribers(this.deps.pool)) {
          if (this.closed) return
          await this.forUser(user, true).catch((err: unknown) => console.error('[push] 派发失败', user.id, err))
        }
      } catch (err) {
        console.error('[push] 派发失败', err)
      }
    } while (this.again && !this.closed)
  }

  /** 新订阅：把收件箱里现有的条目记成已通知 */
  async seed(user: { id: string; role: string }): Promise<void> {
    await this.forUser(user, false)
  }

  private async forUser(user: { id: string; role: string }, send: boolean): Promise<void> {
    const { pool } = this.deps
    const notices: [string, Notice][] = []
    for (const item of await collectInbox(pool, user, this.deps.inbox)) {
      const notice = noticeOf(item)
      if (notice) notices.push([noticeIdent(item), notice])
    }
    const idents = notices.map(([id]) => id)
    const fresh = await claimIdents(pool, user.id, idents)
    await pruneIdents(pool, user.id, idents)
    if (!send || fresh.size === 0 || this.deps.isActive(user.id)) return
    const list = notices.filter(([id]) => fresh.has(id)).map(([, n]) => n)
    const batch = list.length > MAX_BATCH ? [...list.slice(0, MAX_BATCH - 1), moreNotice(list.length - (MAX_BATCH - 1))] : list
    const vapid = await loadVapidKeys(pool)
    for (const sub of await subscriptionsOf(pool, user.id)) {
      for (const notice of batch) {
        const res = await this.deliver(sub, notice, vapid)
        if (!res.ok && res.gone) break
      }
    }
  }

  /** 给一条订阅发一条，并记下结局。gone = 订阅已失效（已删） */
  async deliver(sub: Subscription, notice: Notice, vapid?: VapidKeys): Promise<DeliverResult> {
    const { pool } = this.deps
    const endpoint = checkEndpoint(sub.endpoint, this.hosts)
    if (!endpoint) {
      // 库里的老行在清单收紧后不再放行：当失效处理，免得每次都试
      await dropEndpoint(pool, sub.endpoint)
      return { ok: false, error: '订阅地址不在允许的推送服务里', gone: true }
    }
    try {
      const { status } = await sendPush(endpoint, sub, payloadOf(notice), {
        vapid: vapid ?? (await loadVapidKeys(pool)),
        subject: subjectOf(sub.origin),
        transport: this.transport,
        urgency: notice.urgent ? 'high' : 'normal',
      })
      if (status >= 200 && status < 300) {
        await markDelivered(pool, sub.endpoint)
        return { ok: true }
      }
      if (status === 404 || status === 410) {
        await dropEndpoint(pool, sub.endpoint)
        return { ok: false, error: '这台设备的订阅已失效，请重新开启通知', gone: true }
      }
      const error = failureText(status)
      await markFailed(pool, sub.endpoint, error)
      return { ok: false, error, gone: false }
    } catch (err) {
      if (err instanceof PushNetworkError) {
        await markFailed(pool, sub.endpoint, err.message)
        return { ok: false, error: err.message, gone: false }
      }
      // 加密失败 = 订阅里的密钥坏了，这条订阅永远发不出去
      console.error('[push] 发送失败', err)
      await dropEndpoint(pool, sub.endpoint)
      return { ok: false, error: '这台设备的订阅无效，请重新开启通知', gone: true }
    }
  }
}
