// ---------- 评论里 @空间 AI：叫这个团队空间共用的 AI 回这个串 ----------
// 与评论里 @Genet（genet-call.ts）的区别：Genet 是叫的人自己的 AI，经他的 Genet 页处理；空间 AI 是空间的，直接在中心跑一轮
// （drivers/assistant/run-once.ts，不挂在任何对话页上），回复以 AI 自己的名义写进串里（comments.author_ai = 'space'，没有用户作者）。
// 发起（posted，评论接口写成功之后在后台跑）：新串首条 / 回复里带空间 AI 记号、作者不是 AI → 记一次呼叫。
//   页面在私人区 → 直接记 failed「私人页上叫不了空间 AI」；页面所在空间没启用（没配、连接没了）或叫的人不是成员 → failed「这个空间还没有启用 AI」；
//   否则记 waiting 排队。
// 同一个串里的呼叫一个接一个跑（后叫的要看得到前一次的回复，并发回两条也乱）；不同串互不等。
// 跑：排到时再按此刻的配置解析一次（排队期间可能被停用）→ 签一把只读、收窄到这个空间、权限上限是叫的人的凭证 →
//   一轮（输入：空间记忆、页面、划词原文、整串评论带署名、叫它的那条、去掉记号后的要求）→ 文字非空就写回串里 → answered。
//   出错 / 空回复 / 超时 / 服务关停 → failed + 原因（驱动给的错误文案已经抹掉了 key）。
// AI 的回复照样交给 posted（「评论找我」、收件箱）：它作者是 AI，到这里第一步就返回，回复里带了记号也不会自己叫醒自己。
// 只在进程内排队：服务重启时还 waiting 的在启动时结成 failed（recover），关停时在跑的停掉、排着的直接结成 failed。

import type { Pool } from 'pg'
import { AssistantDriver } from '../agents/drivers/assistant/driver.js'
import { runOnce } from '../agents/drivers/assistant/run-once.js'
import type { ResolvedAgent } from '../agents/manager-types.js'
import { resolveSpaceAi, SPACE_AI_DEFAULT_NAME, SPACE_AI_ID, SPACE_AI_OFF, spaceAiNames } from '../agents/space-ai.js'
import type { AgentAdapter } from '../agents/types.js'
import { memoryBlockOfPage } from '../memories.js'
import { mintPageToken, revokePageToken } from '../page-read.js'
import type { PostedComment } from '../triggers/sources/comment.js'
import { fitThread } from './genet-call.js'
import { addAiReply, callsSpaceAi, COMMENT_MAX, KIND_ENABLED, plainMentions, withoutSpaceAi, type Anchor } from './store.js'

export type SpaceAiCallDeps = {
  pool: Pool
  /** 空间 AI 的驱动实例与 MCP 回打中心的地址（manager.spaceAiRunner） */
  runner(agent: ResolvedAgent): { adapter: AgentAdapter; url: string }
  /** 这一页的评论变了（广播 + 收件箱） */
  changed(pageId: string): void
  /** AI 的回复写好了：同界面上的回复一样交出去 */
  posted(c: PostedComment): void
}

/** 一次最长跑多久：模型挂住时串里不能一直「正在回复」 */
export const CALL_TIMEOUT_MS = 10 * 60_000
export const CALL_RESTARTED = '服务重启了，请再叫一次'
export const CALL_TIMED_OUT = '等了太久没有结果，请再叫一次'
export const CALL_EMPTY = '没有给出回复'
export const CALL_GONE = '评论串或页面已经不在了'
export const CALL_PRIVATE = '私人页上叫不了空间 AI：它是整个空间共用的，碰不到某个人的私人区'
/** 失败原因的长度上限（上游报错可能很长） */
const REASON_MAX = 300
const LINE_MAX = 1500

const SELECT_CALL = 'SELECT body, author_ai, deleted_at IS NOT NULL AS deleted FROM comments WHERE id = $1'
const SELECT_PRIVATE = 'SELECT 1 FROM pages WHERE id = $1 AND private_owner IS NOT NULL'
const INSERT_CALL = `INSERT INTO comment_ai_calls (comment_id, thread_id, invoker_id, state, reason, created_at, settled_at)
  VALUES ($1, $2, $3, $4::text, $5, $6, CASE WHEN $4::text = 'waiting' THEN NULL ELSE now() END)
  ON CONFLICT (comment_id) DO NOTHING RETURNING comment_id`
const SETTLE = `UPDATE comment_ai_calls SET state = $2, reason = $3, settled_at = now() WHERE comment_id = $1 AND state = 'waiting'`
const RECOVER = `UPDATE comment_ai_calls a SET state = 'failed', reason = $1, settled_at = now() FROM comment_threads t
  WHERE a.state = 'waiting' AND a.created_at < $2 AND t.id = a.thread_id RETURNING t.page_id`
// 串还在、页面是活的、那种评论开着（p 是 live_pages，列与 pages 相同，KIND_ENABLED 照用）
const SELECT_CONTEXT = `SELECT p.id AS page_id, p.title, p.space_id, t.anchor FROM comment_threads t JOIN live_pages p ON p.id = t.page_id
  WHERE t.id = $1 AND p.kind = 'doc' AND ${KIND_ENABLED}`
const SELECT_THREAD = `SELECT c.id, c.author_ai, u.username, c.body, c.via FROM comments c LEFT JOIN users u ON u.id = c.author_id
  WHERE c.thread_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`

const cut = (s: string, max: number): string => ([...s].length > max ? `${[...s].slice(0, max).join('')}…` : s)

/** 交给空间 AI 的那一段话（纯函数，测试看形状）。署名行与 SPACE_AI_SYSTEM_PROMPT 里「[来自 某人]」的说明同口径 */
export function callPrompt(input: {
  invoker: string
  memory: string
  page: { id: string; title: string }
  quote: string | null
  /** 已经排进预算的整串评论，每条「作者：内容」 */
  lines: string[]
  /** 去掉记号后的要求（可空） */
  request: string
}): string {
  const { invoker } = input
  return [
    `[来自 ${invoker}]`,
    `${invoker} 在一条评论里叫了你。你的回复会作为一条评论直接发进这个评论串：只回答，不改页面；写纯文字，不用 Markdown 的标题、表格和链接语法，提到页面直接写标题；简短，先说结论。`,
    ...(input.memory ? ['', input.memory] : []),
    '',
    `页面：《${input.page.title || '无标题'}》（page:${input.page.id}，要看正文就用 read_page 读）`,
    ...(input.quote ? [`评论针对的原文：「${input.quote}」`] : []),
    '评论串（从早到晚）：',
    ...input.lines.map((l) => `- ${l.split('\n').join('\n  ')}`),
    '',
    input.request ? `${invoker} 的要求：${input.request}` : `${invoker} 没有另写要求：看评论串，回应叫你的那条`,
  ].join('\n')
}

export class SpaceAiCalls {
  /** 串 → 排在最后的那一次（同一串串行） */
  private chains = new Map<string, Promise<void>>()
  private running = new Set<AbortController>()
  private closing = false
  /** 进程开始管事的时刻：在它之前写下、还 waiting 的呼叫是上一个进程留下的 */
  private readonly since = new Date()

  constructor(private deps: SpaceAiCallDeps) {}

  /** 启动时：上一个进程没跑完的呼叫结成 failed（排队只在内存里，重启就没了） */
  async recover(): Promise<void> {
    const { rows } = await this.deps.pool.query<{ page_id: string }>(RECOVER, [CALL_RESTARTED, this.since])
    for (const page of new Set(rows.map((r) => r.page_id))) this.deps.changed(page)
  }

  /** 关停：在跑的停掉（结成 failed），排着的轮到时直接结成 failed，之后的新评论不再发起 */
  dispose(): void {
    this.closing = true
    for (const ctl of this.running) ctl.abort(CALL_RESTARTED)
  }

  /** 一条刚写进去的评论：叫了空间 AI 就发起一次（调用方不等；返回的 promise 覆盖到这一次跑完） */
  async posted(c: PostedComment): Promise<void> {
    const invoker = c.authorId
    // 空间 AI 自己写的：回复里带了记号也不叫自己
    if (invoker === null || this.closing) return
    const { pool } = this.deps
    const row = (await pool.query<{ body: string; author_ai: string | null; deleted: boolean }>(SELECT_CALL, [c.commentId])).rows[0]
    if (!row || row.deleted || row.author_ai || !callsSpaceAi(row.body)) return
    const agent = await resolveSpaceAi(pool, { id: invoker }, c.pageId)
    const off = agent ? '' : (await pool.query(SELECT_PRIVATE, [c.pageId])).rowCount ? CALL_PRIVATE : SPACE_AI_OFF
    const created = await pool.query(INSERT_CALL, [c.commentId, c.threadId, invoker, agent ? 'waiting' : 'failed', off, new Date()])
    if (!created.rowCount) return
    this.deps.changed(c.pageId)
    if (agent) await this.enqueue(c.threadId, () => this.answer(c, invoker))
  }

  private enqueue(threadId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(threadId) ?? Promise.resolve()).then(work)
    const tail = run.catch(() => undefined)
    this.chains.set(threadId, tail)
    void tail.then(() => {
      if (this.chains.get(threadId) === tail) this.chains.delete(threadId)
    })
    return run
  }

  private async settle(c: PostedComment, state: 'answered' | 'failed', reason = ''): Promise<void> {
    await this.deps.pool.query(SETTLE, [c.commentId, state, cut(reason, REASON_MAX)])
    this.deps.changed(c.pageId)
  }

  /** 跑一次并把结局写回；不抛错（出了错就是 failed 的原因） */
  private async answer(c: PostedComment, invoker: string): Promise<void> {
    const ctl = new AbortController()
    this.running.add(ctl)
    const timer = setTimeout(() => ctl.abort(CALL_TIMED_OUT), CALL_TIMEOUT_MS)
    timer.unref?.()
    const held: { token?: string } = {}
    try {
      if (this.closing) return await this.settle(c, 'failed', CALL_RESTARTED)
      const reply = await this.reply(c, invoker, ctl.signal, held)
      if (typeof reply !== 'string') return
      await this.settle(c, 'failed', reply)
    } catch (err) {
      const reason = ctl.signal.aborted ? String(ctl.signal.reason) : err instanceof Error ? err.message : String(err)
      await this.settle(c, 'failed', reason || '出错了').catch((e: unknown) => console.error('[space-ai] 呼叫结局没写进去', e))
    } finally {
      clearTimeout(timer)
      this.running.delete(ctl)
      if (held.token) revokePageToken(held.token)
    }
  }

  /** 读上下文 → 跑一轮 → 写回。写回了返回 null；没写回返回原因（调用方记 failed） */
  private async reply(c: PostedComment, invoker: string, signal: AbortSignal, held: { token?: string }): Promise<string | null> {
    const { pool } = this.deps
    type Ctx = { page_id: string; title: string; space_id: string; anchor: Anchor | null }
    const ctx = (await pool.query<Ctx>(SELECT_CONTEXT, [c.threadId])).rows[0]
    if (!ctx) return CALL_GONE
    // 排在前一次后面的这段时间里，空间 AI 可能被停用、叫的人可能离开了空间
    const agent = await resolveSpaceAi(pool, { id: invoker }, ctx.page_id)
    if (!agent?.space) return SPACE_AI_OFF
    const { adapter, url } = this.deps.runner(agent)
    if (!(adapter instanceof AssistantDriver)) throw new Error('空间 AI 没有起来')
    const body = (await pool.query<{ body: string }>('SELECT body FROM comments WHERE id = $1', [c.commentId])).rows[0]?.body ?? ''
    const thread = (await pool.query<{ id: string; author_ai: string | null; username: string | null; body: string; via: string | null }>(SELECT_THREAD, [c.threadId])).rows
    const aiName = (await spaceAiNames(pool, [ctx.page_id])).get(ctx.page_id) ?? SPACE_AI_DEFAULT_NAME
    const invokerName = (await pool.query<{ username: string }>('SELECT username FROM users WHERE id = $1', [invoker])).rows[0]?.username ?? '已注销用户'
    const lines = thread.map((r) => {
      const who = r.author_ai ? `${aiName}（你）` : `${r.username ?? '已注销用户'}${r.via === 'genet' ? '（Genet 代发）' : ''}`
      return `${who}${r.id === c.commentId ? '（叫你的这条）' : ''}：${plainMentions(r.body)}`
    })
    const text = callPrompt({
      invoker: invokerName,
      memory: await memoryBlockOfPage(pool, ctx.page_id),
      page: { id: ctx.page_id, title: ctx.title },
      quote: ctx.anchor?.text ? cut(ctx.anchor.text, LINE_MAX) : null,
      lines: fitThread(lines),
      request: plainMentions(withoutSpaceAi(body)),
    })
    // 只读、收窄到这个空间、权限上限是叫的人；scope = 空间 AI 的适配器 key（适配器回收时一起作废），用完立刻收回
    const token = mintPageToken(invoker, SPACE_AI_ID, { pageId: ctx.page_id, agentId: SPACE_AI_ID, canDispatch: false, space: agent.space.id, readOnly: true })
    held.token = token
    const out = await runOnce(adapter, { url, token, blocks: [{ type: 'text', text }], signal })
    if (signal.aborted) return String(signal.reason)
    const answer = cut(out.text.trim(), COMMENT_MAX - 1)
    if (!answer) return CALL_EMPTY
    // 跑的这段时间里串可能被删、页面进了回收站、那种评论被关掉：不往看不见的地方写
    const still = (await pool.query<Ctx>(SELECT_CONTEXT, [c.threadId])).rows[0]
    if (!still) return CALL_GONE
    const comment = await addAiReply(pool, { pageId: still.page_id, threadId: c.threadId, invokerId: invoker, body: answer })
    await this.settle(c, 'answered')
    this.deps.posted({ commentId: comment.id, threadId: c.threadId, pageId: still.page_id, authorId: null })
    return null
  }
}
