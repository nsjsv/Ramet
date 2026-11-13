/* ---------- MCP 工具的记忆与空间约定端点（注册在 ramet-tools.ts 的同一个 app 上，凭证闸门同那里） ----------
 * GET  /api/ramet/spaces/:id/context → { text }：read_space，读用户所在任一空间的约定（公共记忆 + skill 清单，space-context.ts 的写法）。
 *   不是成员（含访客）404；空间 AI 的收窄凭证在 ramet-tools.ts 的白名单闸门就 403。
 * POST /api/ramet/memories/propose { text, space? } → 弹「记住这条？」，用户点「记住」才写。记到哪：
 *   - 给了 space：只有 Genet 能给（空间 AI 只能给自己的空间）；用户必须是那里的 owner / member（只读 400，非成员 404）。
 *   - 没给：页面在 Genet 子树里（Genet 页、任务页）= 用户的个人记忆；否则 = 页面所在空间（现状）。
 *   卡片标题写明记进哪里（个人记忆、或 Genet 指定的空间）；别的 agent 记进页面所在空间时照旧。
 *   先判能不能写（空 / 超长 / 满了 → 直接回告 agent，不打扰用户）；点「不用」/ 这一轮被停止 / 调用方断开 = 不写。 */

import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import { genetOwnerOf, isAssistantId } from '../agents/assistant-agent.js'
import type { OwnApprovals } from '../agents/own-approvals.js'
import { renderSpaceBlock, spaceContext } from '../agents/space-context.js'
import { addMemory, checkMemory } from '../memories.js'
import type { GrantCtx } from '../page-read.js'
import { addPersonalMemory, checkPersonalMemory } from '../personal-memories.js'
import { heartbeatJson } from './ramet-consent.js'
import { roleInSpace, writable } from './pages.js'

type Granted = { user: { id: string; role: 'admin' | 'user' }; ctx: GrantCtx }
type PageRow = { id: string; space_id: string | null }

export type MemoryToolDeps = {
  pool: Pool
  granted: (c: Context) => Promise<Granted | null>
  writablePage: (user: Granted['user'], id: string, space?: string) => Promise<{ page: PageRow } | { status: 403 | 404; error: string }>
  approvals: () => OwnApprovals
  notifyMemories?: () => void
}

type Target = { kind: 'personal' } | { kind: 'space'; id: string; name: string; named: boolean }

const SELECT_SPACE = 'SELECT id, name FROM spaces WHERE id = $1'
const SELECT_PAGE_SPACE = 'SELECT p.space_id AS id, s.name FROM live_pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1'

export function memoryToolRoutes(app: Hono, deps: MemoryToolDeps): void {
  const { pool } = deps

  app.get('/api/ramet/spaces/:id/context', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const space = (await pool.query<{ id: string; name: string }>(SELECT_SPACE, [c.req.param('id')])).rows[0]
    if (!space || (await roleInSpace(pool, g.user, space.id)) === null) return c.json({ error: '没有这个空间，或你不是它的成员' }, 404)
    return c.json({ text: renderSpaceBlock(space, await spaceContext(pool, space.id), 'asked') })
  })

  /** 提议记到哪；不行就是给 agent 的错误 */
  async function targetOf(g: Granted, pageId: string, raw: unknown): Promise<Target | { status: 400 | 404; error: string }> {
    if (typeof raw === 'string' && raw) {
      if (!isAssistantId(g.ctx.agentId) && raw !== g.ctx.space) return { status: 400, error: '这个会话不能指定记到哪个空间' }
      const space = (await pool.query<{ id: string; name: string }>(SELECT_SPACE, [raw])).rows[0]
      const role = space ? await roleInSpace(pool, g.user, space.id) : null
      if (!space || role === null) return { status: 404, error: '没有这个空间，或用户不是它的成员' }
      if (!writable(role)) return { status: 400, error: `用户在「${space.name}」是只读成员，不能记` }
      return { kind: 'space', id: space.id, name: space.name, named: true }
    }
    if ((await genetOwnerOf(pool, pageId)) === g.user.id) return { kind: 'personal' }
    const space = (await pool.query<{ id: string; name: string }>(SELECT_PAGE_SPACE, [pageId])).rows[0]
    if (!space) return { status: 400, error: '这个页面不在任何空间里，没法记忆' }
    return { kind: 'space', id: space.id, name: space.name, named: false }
  }

  app.post('/api/ramet/memories/propose', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const pageId = g.ctx.pageId
    // 没有绑页面 = 没有地方弹确认：不能静默写入
    if (!pageId) return c.json({ error: '这个会话没有绑定页面，没法弹出确认，不能提议记忆' }, 403)
    // 卡片弹在凭证绑的这一页上（空间 AI 的直接对话页在私人区，所以这里不按空间收窄；记到哪由 targetOf 管）
    const found = await deps.writablePage(g.user, pageId)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; space?: unknown }
    const target = await targetOf(g, pageId, body.space)
    if ('error' in target) return c.json({ error: target.error }, target.status)
    const raw = typeof body.text === 'string' ? body.text : ''
    const checked = target.kind === 'personal' ? await checkPersonalMemory(pool, g.user.id, raw) : await checkMemory(pool, target.id, raw)
    if (!checked.ok) return c.json({ error: checked.message }, checked.reason === 'empty' ? 400 : 413)
    const text = checked.text
    const brief = text.replace(/\s+/g, ' ')
    const where = target.kind === 'personal' ? '你的个人记忆' : `「${target.name}」的空间记忆`
    const shown = target.kind === 'personal' || target.named ? `（写进${where}）` : ''
    return heartbeatJson(c, async () => {
      const decision = await deps.approvals().decide(
        { pageId, agentId: g.ctx.agentId },
        {
          title: `记住这条？${shown}「${brief.length > 60 ? `${brief.slice(0, 60)}…` : brief}」`,
          toolCall: { kind: 'other', title: '记住这条', content: [{ type: 'content', content: { type: 'text', text } }] },
          labels: { allow: '记住', reject: '不用' },
          // 空间 AI 的只给叫它的人批；个人记忆只有本人能点
          ...(g.ctx.space || target.kind === 'personal' ? { only: g.user.id } : {}),
        },
        c.req.raw.signal,
      )
      if (!decision.allowed || !decision.by) return { declined: true }
      if (target.kind === 'personal') {
        const res = await addPersonalMemory(pool, g.user.id, text, pageId)
        if (!res.ok) return { error: res.message }
        deps.notifyMemories?.()
        return { ok: true, id: res.memory.id, savedTo: where }
      }
      // 等待期间页面可能被回收 / 搬走：没指定空间时按页面此刻所在的空间再判一次（空间 AI 的页搬出了它的空间就不记）
      let spaceId = target.id
      if (!target.named) {
        const now = (await pool.query<{ id: string }>(SELECT_PAGE_SPACE, [pageId])).rows[0]
        if (!now || (g.ctx.space && now.id !== g.ctx.space)) return { error: '页面已经不存在了，没有记下' }
        spaceId = now.id
      }
      const res = await addMemory(pool, spaceId, text, decision.by, pageId)
      if (!res.ok) return { error: res.message }
      deps.notifyMemories?.()
      return { ok: true, id: res.memory.id, savedTo: where }
    })
  })
}
