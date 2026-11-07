// ---------- Genet 派出去的任务：做完回报 / 等它做完 ----------
// dispatch_task 派出去就返回，Genet 不知道任务什么时候做完。这里在任务页「派出去的那一轮」结束时回报一次（assistant_tasks 一行，
// reported_at 落值即用掉，之后同一页上的追问 / 续跑不再回报）：
//   完成 / 失败 → 在 Genet 页末尾写一条通知块（带 notice 属性的 user_message），再叫醒 Genet 接着处理；
//   被手动停止 → 只把这一行用掉，不回报（是用户自己停的）；
//   Genet 正在 wait_task 里等这一页 → 结果直接交给它，不写通知（不然同一个结果它会收到两次）。
// 通知块用 user_message 而不是新节点：runTurn 取「最后一条用户消息」当这一轮的输入、seen 增量、排队 continue 全都直接可用。
// 回报前按发起人重判权限（Genet 页可写、Genet 可用），同排队派发：不替失权的人跑（写块 + 叫醒在 genet-notify.ts，定时触发也用它）。
// 定时器的目标是任务页时，到点写进去的那一轮同样回报：派发前 arm 把这一行重新登记成「还没回报」。
// 入口 onRunEnd 由 manager 在一轮结束时调（与 send-queue 的 onRunEnd 同一处），同步返回、内部吞错，不能让一轮的收尾抛出去。

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { decodeStats } from '@ramet/shared/reply-stats'
import { pageAccess, type DocWriter } from '../collab.js'
import { ASSISTANT_ID } from './assistant-agent.js'
import { blockMarkdown } from './doc.js'
import { GenetNotify } from './genet-notify.js'
import type { PendingApproval } from './manager-types.js'
import { inheritedAttrs } from './queue-message.js'
import type { QueueHost, SendQueue } from './send-queue.js'

/** done / failed / stopped = 那一轮的结局；running = 还在跑（等到上限）；approval = 在等用户批准；idle = 还没有回复 */
export type TaskStatus = 'done' | 'failed' | 'stopped' | 'running' | 'approval' | 'idle'

export type TaskResult = {
  pageId: string
  title: string
  label: string
  status: TaskStatus
  /** 那一轮的用时（回复块记的），拿不到为 null */
  ms: number | null
  reason: string | null
  /** 最后一块回复的正文（markdown 口径），截到 RESULT_MAX */
  text: string
  truncated: boolean
}

/** 结果正文的字数上限：给 wait_task 的文字与通知块里克隆的回复子块用同一个预算，超了 Genet 自己 read_page */
export const RESULT_MAX = 6000
/** wait_task 的等待上限（分钟）：缺省 / 最小 / 最大 */
export const WAIT_MINUTES = { default: 10, min: 1, max: 30 } as const
/** 等待期间多久看一次任务是不是在等审批（审批不经过一轮的收尾，只能轮询内存里的待批表） */
const APPROVAL_POLL_MS = 2000

type Waiter = { home: string; give(r: TaskResult): void; abort(): void }

type Row = { page_id: string; home_id: string; user_id: string; agent: string; label: string }

export type TaskWatchDeps = {
  pool: Pool
  host: Pick<QueueHost, 'running' | 'writable' | 'usable'>
  /** 叫醒 Genet 页用它的 wake */
  queue: Pick<SendQueue, 'wake'>
  writeDoc?: DocWriter
  /** 页面正文：活文档优先 */
  fragment(pageId: string): Promise<Y.XmlFragment>
  approvals(): PendingApproval[]
}

/** 「3 分 12 秒」：通知抬头与 wait_task 的回显共用 */
export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 60)} 小时`
}

const VERB: Record<'done' | 'failed', string> = { done: '已完成', failed: '失败了' }

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

function lastReply(fragment: Y.XmlFragment): Y.XmlElement | null {
  let last: Y.XmlElement | null = null
  fragment.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') last = c
  })
  return last
}

/** 回复块的结局（没有回复 = idle；o:run = 还在跑或刚重启没认领回来） */
function replyOutcome(reply: Y.XmlElement | null): TaskStatus {
  if (!reply) return 'idle'
  const o = decodeStats(reply.getAttribute('stats')).o
  return o === 'error' ? 'failed' : o === 'cancelled' ? 'stopped' : o === 'run' ? 'running' : 'done'
}

/** 回复的子块按预算取：放得下的整块留着，放不下就停（宁可少一块，不切半块 markdown）。
 *  第一块就超预算（比如一大段代码）时只留它截断后的文字（cut），通知块里写成一段纯文字，不克隆整块 */
function budgeted(reply: Y.XmlElement | null): { blocks: Array<{ el: Y.XmlElement; cut?: string }>; text: string; truncated: boolean } {
  const blocks: Array<{ el: Y.XmlElement; cut?: string }> = []
  const parts: string[] = []
  let used = 0
  let truncated = false
  reply?.forEach((c) => {
    if (truncated || !(c instanceof Y.XmlElement)) return
    const t = blockMarkdown(c)
    if (used + t.length <= RESULT_MAX) {
      blocks.push({ el: c })
      parts.push(t)
      used += t.length
      return
    }
    truncated = true
    if (blocks.length > 0) return
    const cut = `${t.slice(0, RESULT_MAX)}…`
    blocks.push({ el: c, cut })
    parts.push(cut)
  })
  return { blocks, text: parts.join('\n\n'), truncated }
}

function paragraph(inlines: Array<Y.XmlText | Y.XmlElement>): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, inlines)
  return p
}

function text(s: string): Y.XmlText {
  const t = new Y.XmlText()
  t.insert(0, s)
  return t
}

/** 通知块：抬头（任务链接 + 结局 + agent + 用时）、失败原因、最后一块回复的子块（克隆，按预算截断） */
export function noticeElement(
  fragment: Y.XmlFragment,
  r: TaskResult & { status: 'done' | 'failed' },
  reply: Y.XmlElement | null,
): Y.XmlElement {
  const msg = new Y.XmlElement('user_message')
  const attrs = { ...inheritedAttrs(fragment, ASSISTANT_ID), id: randomUUID(), author: '', notice: r.status, task: r.pageId }
  for (const [k, v] of Object.entries(attrs)) msg.setAttribute(k, v)
  const mention = new Y.XmlElement('page_mention')
  mention.setAttribute('pageId', r.pageId)
  mention.setAttribute('title', r.title)
  const meta = [VERB[r.status], r.label, ...(r.ms !== null ? [durationText(r.ms)] : [])].join(' · ')
  const body: Y.XmlElement[] = [paragraph([text('任务 '), mention, text(` ${meta}`)])]
  if (r.reason) body.push(paragraph([text(`原因：${r.reason}`)]))
  const { blocks, truncated } = budgeted(reply)
  if (blocks.length > 0) body.push(...blocks.map((b) => (b.cut === undefined ? b.el.clone() : paragraph([text(b.cut)]))))
  else body.push(paragraph([text('（它没有给出文字回答）')]))
  if (truncated) body.push(paragraph([text('（后面还有，完整内容见任务页）')]))
  msg.insert(0, body)
  return msg
}

export type RunEndListener = (pageId: string, outcome: 'end' | 'cancelled' | 'error', error: string | null, startedAt: number) => Promise<void>

export class TaskWatch {
  /** 正在 wait_task 里等的：任务页 → 等待者（home = 在等的 Genet 页，停它时作废） */
  private waiters = new Map<string, Set<Waiter>>()
  /** 正在收尾回报的任务页：arm 要等它先把上一轮的那一行用掉，否则重新登记的这一行会被上一轮的回报吃掉 */
  private settling = new Map<string, Promise<void>>()
  /** 往 Genet 页写通知 + 叫醒（同一个 Genet 页排成一条链）。定时触发拿同一个实例，与任务回报排在同一条链上 */
  readonly notify: GenetNotify
  /** 别处也要在一轮结束时收尾的（评论呼叫，comments/genet-call.ts）：与任务回报同一时机，不等、出错只记日志 */
  private ended: RunEndListener[] = []

  constructor(private deps: TaskWatchDeps) {
    this.notify = new GenetNotify(deps)
  }

  onEnd(fn: RunEndListener): void {
    this.ended.push(fn)
  }

  /** 派活登记（/api/ramet/dispatch 在写好任务消息、开跑之前调：开跑后一轮可能很快就结束） */
  async register(t: { pageId: string; homeId: string; userId: string; agent: string; label: string }): Promise<void> {
    await this.deps.pool.query('INSERT INTO assistant_tasks (page_id, home_id, user_id, agent, label) VALUES ($1, $2, $3, $4, $5)', [
      t.pageId,
      t.homeId,
      t.userId,
      t.agent,
      t.label,
    ])
  }

  /** 定时器在任务页上写好指令、开跑之前调：这一轮做完照常回报 Genet（同派活）。已有的那一行重新登记，label 空着就沿用原来的 */
  async arm(t: { pageId: string; homeId: string; userId: string; agent: string; label: string }): Promise<void> {
    await this.settling.get(t.pageId)
    await this.deps.pool.query(
      `INSERT INTO assistant_tasks (page_id, home_id, user_id, agent, label) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id) DO UPDATE SET home_id = EXCLUDED.home_id, user_id = EXCLUDED.user_id, agent = EXCLUDED.agent,
         label = COALESCE(NULLIF(EXCLUDED.label, ''), assistant_tasks.label), created_at = now(), reported_at = NULL`,
      [t.pageId, t.homeId, t.userId, t.agent, t.label],
    )
  }

  /** arm 了却没开跑（开跑被拒）：把这一行收回，免得之后别的一轮被当成派出去的那一轮回报 */
  async disarm(pageId: string): Promise<void> {
    await this.deps.pool.query('UPDATE assistant_tasks SET reported_at = now() WHERE page_id = $1 AND reported_at IS NULL', [pageId])
  }

  /** 一轮结束（manager 调）。shutdown 不是结局：远端回合认领回来后还会再结束一次。startedAt = 这一轮开始的时刻 */
  onRunEnd(pageId: string, outcome: 'end' | 'cancelled' | 'error' | 'shutdown', error?: string | null, startedAt?: number): void {
    if (outcome === 'shutdown') return
    for (const fn of this.ended) {
      fn(pageId, outcome, error ?? null, startedAt ?? Date.now()).catch((err: unknown) =>
        console.error(`[genet] 一轮结束的收尾失败(${pageId}): ${err instanceof Error ? err.message : String(err)}`),
      )
    }
    const status = outcome === 'end' ? 'done' : outcome === 'error' ? 'failed' : 'stopped'
    const done = this.settle(pageId, status, error ?? null).catch((err: unknown) =>
      console.error(`[genet] 任务回报失败(${pageId}): ${err instanceof Error ? err.message : String(err)}`),
    )
    this.settling.set(pageId, done)
    void done.finally(() => {
      if (this.settling.get(pageId) === done) this.settling.delete(pageId)
    })
  }

  private async settle(pageId: string, status: 'done' | 'failed' | 'stopped', reason: string | null): Promise<void> {
    // 先取等待者再用掉这一行：两步之间新来的 wait_task 看到的是「不在跑」，自己去用这一行，不会两边都落空
    const waiting = this.waiters.get(pageId)
    const row = await this.consume(pageId)
    if (!row && !waiting?.size) return
    const reply = lastReply(await this.deps.fragment(pageId))
    const result = await this.result(pageId, reply, status, status === 'failed' ? reason : null)
    if (waiting?.size) {
      for (const w of [...waiting]) w.give(result)
      return
    }
    if (!row || status === 'stopped') return
    const r = { ...result, status }
    const refused = await this.notify.post(row.home_id, row.user_id, (frag) => noticeElement(frag, r, reply))
    if (refused) console.error(`[genet] 不回报任务 ${row.page_id}：${refused}`)
  }

  /** wait_task 能等的页：homeId 这个 Genet 页下的活页、user 看得到（端点在先发头之前判，好回 404） */
  async owns(pageId: string, homeId: string, user: { id: string; role: string }): Promise<boolean> {
    const page = (await this.deps.pool.query<{ parent_id: string | null }>('SELECT parent_id FROM live_pages WHERE id = $1', [pageId])).rows[0]
    return page?.parent_id === homeId && (await pageAccess(this.deps.pool, pageId, user)) !== null
  }

  /** wait_task：等任务页上这一轮结束。调用方已确认凭证是 homeId 这个 Genet 页的、owns 为真 */
  async wait(pageId: string, homeId: string, minutes: number, signal: AbortSignal): Promise<TaskResult> {
    const pending = (): boolean => this.deps.approvals().some((a) => a.pageId === pageId)
    // 下面到登记等待者之间不能有 await：否则这一轮恰好在中间结束，等待者就再也等不到
    if (pending()) return this.current(pageId, 'approval')
    if (!this.deps.host.running(pageId)) {
      // 已经有结局：结果交给 Genet，这一行（若还没回报）用掉，不再另发通知
      const now = await this.current(pageId, null)
      if (now.status === 'done' || now.status === 'failed' || now.status === 'stopped') await this.consume(pageId)
      return now
    }
    const ms = Math.min(Math.max(Number.isFinite(minutes) ? minutes : WAIT_MINUTES.default, WAIT_MINUTES.min), WAIT_MINUTES.max) * 60_000
    const { promise, resolve, reject } = Promise.withResolvers<TaskResult>()
    let set = this.waiters.get(pageId)
    if (!set) this.waiters.set(pageId, (set = new Set()))
    const waiters = set
    const done = (): void => {
      clearTimeout(timer)
      clearInterval(poll)
      signal.removeEventListener('abort', abort)
      waiters.delete(waiter)
      if (waiters.size === 0 && this.waiters.get(pageId) === waiters) this.waiters.delete(pageId)
    }
    // 超时 / 等到审批：这一行不用掉，之后照常自动回报
    const settleWith = (status: 'running' | 'approval'): void => {
      done()
      this.current(pageId, status).then(resolve, reject)
    }
    const abort = (): void => {
      done()
      reject(new Error('已停止'))
    }
    const waiter: Waiter = {
      home: homeId,
      give: (r) => {
        done()
        resolve(r)
      },
      abort,
    }
    waiters.add(waiter)
    const timer = setTimeout(() => settleWith('running'), ms)
    const poll = setInterval(() => {
      if (pending()) settleWith('approval')
    }, APPROVAL_POLL_MS)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return promise
  }

  /** Genet 页被停止（manager.stop）：它在等的全部作废，那些任务做完时照常回报。
   *  不能只靠请求断开：MCP 进程收到取消后不会掐断它发给中心的请求，等待会一直挂到任务结束、把结果吞掉 */
  cancelWaits(homeId: string): void {
    for (const set of [...this.waiters.values()]) for (const w of [...set]) if (w.home === homeId) w.abort()
  }

  /** 此刻的结果；status 给了就用它（还在跑 / 等审批），否则按最后一块回复判 */
  private async current(pageId: string, status: TaskStatus | null): Promise<TaskResult> {
    const reply = lastReply(await this.deps.fragment(pageId))
    return this.result(pageId, reply, status ?? replyOutcome(reply), null)
  }

  private async result(pageId: string, reply: Y.XmlElement | null, status: TaskStatus, reason: string | null): Promise<TaskResult> {
    const meta = (
      await this.deps.pool.query<{ title: string; label: string | null; agent: string | null }>(
        'SELECT p.title, t.label, t.agent FROM pages p LEFT JOIN assistant_tasks t ON t.page_id = p.id WHERE p.id = $1',
        [pageId],
      )
    ).rows[0]
    const running = status === 'running' || status === 'approval' || status === 'idle'
    const { text, truncated } = running ? { text: '', truncated: false } : budgeted(reply)
    const ms = running || !reply ? null : (decodeStats(reply.getAttribute('stats')).ms ?? null)
    const label = meta?.label || meta?.agent || (reply ? attr(reply, 'agent') : '')
    return { pageId, title: meta?.title || '无标题', label, status, ms, reason, text, truncated }
  }

  /** 用掉这一行（原子：同时来的两方只有一方拿到） */
  private async consume(pageId: string): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      'UPDATE assistant_tasks SET reported_at = now() WHERE page_id = $1 AND reported_at IS NULL RETURNING page_id, home_id, user_id, agent, label',
      [pageId],
    )
    return rows[0] ?? null
  }
}
