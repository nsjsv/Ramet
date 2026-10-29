// ---------- 运行中排队发送（存在服务端）----------
// agent 在跑时发的消息先排着（send_queue 表），这一轮正常结束后由服务端以排队的人的身份写进文档（queue-message.ts）
// 并发起下一轮；刷新、换设备、关掉浏览器都不影响。页面上的人都能看到排队区，只有排的人能撤回 / 立即发送。
// 派发的唯一入口是 onRunEnd（由 manager.release 调，它是所有一轮结束的唯一出口）：
//   end                → 出队最早的一条派发
//   cancelled + 有插队 → 派发插队的那条（立即发送 = 标 jump + 停下当前这一轮）
//   其余（出错 / 手动停止） → 暂停：不自动发，排队区提示，可以手动立即发送
// 入队时页面恰好空着（刚结束）就直接派发，免得排进一个再也等不到结束的队。
// 派发前按排队的人重判权限（页面可写、resolve agent / 机器使用权）：不够就丢掉这条并广播原因（不替失权的人跑）。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AgentEvent } from './types.js'

export type QueueKind = 'message' | 'continue'

type Row = { id: string; page_id: string; user_id: string; agent: string; kind: QueueKind; text: string; images: string[]; jump: boolean; created_at: Date; username: string | null }

/** 广播 / GET 的形状：文字只给摘要（排队区一行），图片只给张数 */
export type QueueView = { id: string; userId: string; username: string; agent: string; kind: QueueKind; text: string; images: number; jump: boolean; at: string }

const SUMMARY_MAX = 200
const MAX_TEXT = 100_000
const MAX_IMAGES = 4
const IMAGE_SRC = /^\/api\/files\/[0-9a-f-]{36}$/i

export class QueueForbiddenError extends Error {}
export class QueueBadRequestError extends Error {}

/** 队列要从 manager 拿的东西（同 ManagerHost 的做法：这里不碰适配器 / RunState） */
export type QueueHost = {
  running(pageId: string): boolean
  stop(pageId: string): void
  /** 以 user 身份往文档末尾写一条用户消息（message 类） */
  writeMessage(pageId: string, user: { id: string; role: string }, text: string, images: string[], agent: string): Promise<void>
  /** 以 user 身份发起一轮：'busy' = 别人抢先开了一轮（留着等下一次结束）；string = 不能替他跑的原因（丢掉） */
  start(pageId: string, user: { id: string; role: string }, agent: string): Promise<'ok' | 'busy' | { reason: string }>
  /** 这个人此刻还能写这一页吗 */
  writable(pageId: string, user: { id: string; role: string }): Promise<boolean>
  /** 这个人此刻能用这个 agent 吗（机器使用权 / 在线）：不能 = 原因。写消息之前先判，免得写进去了才发现跑不了 */
  usable(user: { id: string; role: string }, agent: string): Promise<string | null>
  broadcast(pageId: string, ev: AgentEvent): void
}

const SELECT = `SELECT q.*, u.username FROM send_queue q LEFT JOIN users u ON u.id = q.user_id`

function view(r: Row): QueueView {
  const text = r.text.replace(/\s+/g, ' ').trim()
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username ?? '',
    agent: r.agent,
    kind: r.kind,
    text: text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text,
    images: r.images.length,
    jump: r.jump,
    at: r.created_at.toISOString(),
  }
}

export class SendQueue {
  /** 上一轮出错 / 被手动停止的页面：不自动发（内存里记；重启后清掉，等下一次结束或手动发送） */
  private paused = new Set<string>()
  /** 正在派发的页面：同一页同时只派发一条（写文档 + 发起一轮之间有 await） */
  private dispatching = new Set<string>()

  constructor(
    private pool: Pool,
    private host: QueueHost,
  ) {}

  async list(pageId: string): Promise<{ items: QueueView[]; paused: boolean }> {
    const { rows } = await this.pool.query<Row>(`${SELECT} WHERE q.page_id = $1 ORDER BY q.created_at, q.id`, [pageId])
    return { items: rows.map(view), paused: this.paused.has(pageId) }
  }

  async enqueue(
    pageId: string,
    user: { id: string; role: string },
    input: { agent: unknown; kind: unknown; text: unknown; images: unknown },
  ): Promise<QueueView> {
    const kind = input.kind === 'continue' ? 'continue' : input.kind === 'message' ? 'message' : null
    if (!kind) throw new QueueBadRequestError('kind 应为 message 或 continue')
    const agent = typeof input.agent === 'string' ? input.agent : ''
    const text = typeof input.text === 'string' ? input.text.slice(0, MAX_TEXT) : ''
    const images = Array.isArray(input.images) ? input.images.filter((s): s is string => typeof s === 'string' && IMAGE_SRC.test(s)).slice(0, MAX_IMAGES) : []
    if (kind === 'message' && !text.trim() && images.length === 0) throw new QueueBadRequestError('空消息')
    const id = randomUUID()
    await this.pool.query(
      'INSERT INTO send_queue (id, page_id, user_id, agent, kind, text, images) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, pageId, user.id, agent, kind, kind === 'message' ? text : '', JSON.stringify(images)],
    )
    const row = (await this.pool.query<Row>(`${SELECT} WHERE q.id = $1`, [id])).rows[0]!
    // 页面恰好空着（入队的请求与这一轮的结束擦肩而过）：直接派发
    if (!this.host.running(pageId)) {
      this.paused.delete(pageId)
      await this.dispatchNext(pageId, false)
    } else await this.publish(pageId)
    return view(row)
  }

  /** 撤回（只有本人）：删掉并把文字 / 图片还给输入框；不存在 = null */
  async withdraw(pageId: string, itemId: string, user: { id: string }): Promise<{ text: string; images: string[] } | null> {
    const row = (await this.pool.query<Row>(`${SELECT} WHERE q.id = $1 AND q.page_id = $2`, [itemId, pageId])).rows[0]
    if (!row) return null
    if (row.user_id !== user.id) throw new QueueForbiddenError('只能撤回自己排的消息')
    await this.pool.query('DELETE FROM send_queue WHERE id = $1', [itemId])
    await this.publish(pageId)
    return { text: row.text, images: row.images }
  }

  /** 立即发送（只有本人）：在跑就标插队并停下当前这一轮（结束时派发它）；空着就直接派发 */
  async sendNow(pageId: string, itemId: string, user: { id: string }): Promise<boolean> {
    const row = (await this.pool.query<Row>(`${SELECT} WHERE q.id = $1 AND q.page_id = $2`, [itemId, pageId])).rows[0]
    if (!row) return false
    if (row.user_id !== user.id) throw new QueueForbiddenError('只能发送自己排的消息')
    await this.pool.query('UPDATE send_queue SET jump = (id = $1) WHERE page_id = $2', [itemId, pageId])
    this.paused.delete(pageId)
    if (this.host.running(pageId)) {
      await this.publish(pageId)
      this.host.stop(pageId)
    } else await this.dispatchNext(pageId, true)
    return true
  }

  /** 一轮结束（manager.release 调）：按结局决定派发还是暂停。不抛：派发的失败只进广播 */
  onRunEnd(pageId: string, outcome: 'end' | 'cancelled' | 'error' | 'shutdown'): void {
    if (outcome === 'shutdown') return
    void (async () => {
      if (outcome === 'end') {
        this.paused.delete(pageId)
        await this.dispatchNext(pageId, false)
      } else if (outcome === 'cancelled' && (await this.hasJump(pageId))) {
        this.paused.delete(pageId)
        await this.dispatchNext(pageId, true)
      } else if (await this.hasAny(pageId)) {
        this.paused.add(pageId)
        await this.publish(pageId)
      }
    })().catch((err: unknown) => console.error('[queue] 派发失败', err))
  }

  private async hasJump(pageId: string): Promise<boolean> {
    return ((await this.pool.query('SELECT 1 FROM send_queue WHERE page_id = $1 AND jump LIMIT 1', [pageId])).rowCount ?? 0) > 0
  }

  private async hasAny(pageId: string): Promise<boolean> {
    return ((await this.pool.query('SELECT 1 FROM send_queue WHERE page_id = $1 LIMIT 1', [pageId])).rowCount ?? 0) > 0
  }

  /** 派发一条：jumpFirst = 插队的优先，否则最早的。权限不够 → 丢掉换下一条；别人抢先开了一轮 → 留着 */
  private async dispatchNext(pageId: string, jumpFirst: boolean): Promise<void> {
    if (this.dispatching.has(pageId)) return
    this.dispatching.add(pageId)
    try {
      for (;;) {
        if (this.host.running(pageId)) break
        const order = jumpFirst ? 'q.jump DESC, q.created_at, q.id' : 'q.created_at, q.id'
        const row = (await this.pool.query<Row>(`${SELECT} WHERE q.page_id = $1 ORDER BY ${order} LIMIT 1`, [pageId])).rows[0]
        if (!row) break
        const role = (await this.pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [row.user_id])).rows[0]?.role
        const user = role ? { id: row.user_id, role } : null
        if (!user || !(await this.host.writable(pageId, user))) {
          await this.drop(pageId, row, '排队的人已经不能编辑这一页了')
          continue
        }
        const unusable = await this.host.usable(user, row.agent)
        if (unusable) {
          await this.drop(pageId, row, unusable)
          continue
        }
        if (row.kind === 'message') {
          try {
            await this.host.writeMessage(pageId, user, row.text, row.images, row.agent)
          } catch (err) {
            await this.drop(pageId, row, `写进文档失败：${err instanceof Error ? err.message : String(err)}`)
            continue
          }
        }
        await this.pool.query('DELETE FROM send_queue WHERE id = $1', [row.id])
        const started = await this.host.start(pageId, user, row.agent)
        if (started === 'busy') {
          // 别人抢先开了一轮：消息（若有）已经在文档里，下一次结束时以 continue 补上这一轮
          await this.pool.query('INSERT INTO send_queue (id, page_id, user_id, agent, kind, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
            row.id, pageId, row.user_id, row.agent, 'continue', row.created_at,
          ])
          break
        }
        if (started !== 'ok') {
          this.host.broadcast(pageId, { type: 'queue_dropped', id: row.id, reason: started.reason })
          continue
        }
        break
      }
    } finally {
      this.dispatching.delete(pageId)
      await this.publish(pageId)
    }
  }

  private async drop(pageId: string, row: Row, reason: string): Promise<void> {
    await this.pool.query('DELETE FROM send_queue WHERE id = $1', [row.id])
    this.host.broadcast(pageId, { type: 'queue_dropped', id: row.id, reason })
  }

  private async publish(pageId: string): Promise<void> {
    this.host.broadcast(pageId, { type: 'queue', ...(await this.list(pageId)) })
  }
}
