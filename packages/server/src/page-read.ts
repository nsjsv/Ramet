// ---------- 页面读取能力（AI 按行读页面 / 取图 / 写回文档） ----------
// 中心建立 agent 会话时签发短期凭证（mintPageToken），绑发起会话的用户与所属适配器。
// 消费方是 AI 侧 stdio MCP 进程（mcp/ramet.mjs）：只拿中心地址和凭证两个环境变量，HTTP 打中心的 `/api` 端点。
// 绝不把登录 cookie 交给 AI 子进程：它的环境变量 AI 自己读得到，而 cookie 能调的远不止这几个端点。
// `read_page` / `read_image` / `edit_page` 共用同一把凭证、同一个 MCP 进程，端点与 MCP 共用同一份内核：
// 读走「能看见」（live_pages + space_members，与其它页面读路径同口径），写走「能改」（沿用 routes/pages.ts 的 writable：viewer 403，非成员 404）。
//
// 谁拉起 AI，谁在自己机器上拼 MCP 命令：stdio 配置里的 command/args 是拉起 AI 那台机器上的路径
// （`process.execPath` + 这份代码旁边的 `mcp/ramet.mjs`），中心的路径在用户电脑上不存在，发过去只会得到 `Internal error`。
// 所以跨机只传 PageTool.grant（中心对外地址 + 凭证）。地址口径见 httpBaseFor：
// 本机 agent = RAMET_PUBLIC_URL ?? 中心回环端口；connector 只认 RAMET_PUBLIC_URL，没设就报错。
//
// 凭证只在内存里（进程重启即失效），TTL 是兜底；会话 / 适配器结束时按 scope 撤销。多实例部署需要改成共享存储。

import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { loadDocForRead, type DocWriter } from './collab.js'
import { uploadDir } from './uploads.js'
import { fragmentSpans } from './updates.js'
import { editPageForUser, parseOps } from './page-write.js'
import { findBlockElement } from './block-ids.js'
import { standaloneMarkdown } from './agents/refs.js'

/** 端点路径与环境变量名的契约在本文件（MCP 进程不 import 这里，工具名在 mcp/tools/*.mjs） */
export const READ_PAGE_PATH = '/api/pages/:id/text'
export const READ_IMAGE_PATH = '/api/files/:id/ai'
export const EDIT_PAGE_PATH = '/api/pages/:id/edit'
export const READ_PAGE_URL_ENV = 'RAMET_PAGE_URL'
export const READ_PAGE_TOKEN_ENV = 'RAMET_PAGE_TOKEN'
/** 缺省 / 上限行数（上限卡响应体积） */
export const PAGE_LINES_DEFAULT = 200
export const PAGE_LINES_MAX = 400
/** AI 取图的体积闸：工具结果是提示词的一部分，大图会挤爆上下文。有 webp 展示版时发展示版，正常远小于这个数 */
export const PAGE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024
/** 凭证 TTL 兜底：凭证不该无限期有效 */
const PAGE_TOKEN_TTL_MS = 2 * 60 * 60_000

/** 页面读取能力，跨机只传这两样（中心对外地址 + 凭证），由拉起 AI 的一端拼成本机 command/args（pageToolServer） */
export type PageToolGrant = { url: string; token: string }

/** 页面按行读取的响应形状（MCP 进程与端点共用） */
export type PageReadResult = {
  title: string
  /** 生效的起始行号（从 1 开始） */
  offset: number
  /** 生效的行数上限 */
  limit: number
  /** 页面正文字数（content_text 的行数） */
  total: number
  lines: string[]
}

/** 给 AI 看的一张图（read_image 与提示词里的图片块共用）：有 webp 展示版就用它（与 /display 同一份产物），
 *  超过 PAGE_IMAGE_MAX_BYTES 不给；不存在或不是图片 = not_found */
export async function loadAiImage(
  pool: Pool,
  id: string,
): Promise<{ error?: undefined; mime: string; data: string } | { error: 'not_found' } | { error: 'too_large'; size: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: 'not_found' }
  const row = (await pool.query<{ mime: string }>('SELECT mime FROM files WHERE id = $1', [id])).rows[0]
  if (!row || !row.mime.startsWith('image/')) return { error: 'not_found' }
  const webp = join(uploadDir(), `${id}.webp`)
  const path = existsSync(webp) ? webp : join(uploadDir(), id)
  if (!existsSync(path)) return { error: 'not_found' }
  const size = statSync(path).size
  if (size > PAGE_IMAGE_MAX_BYTES) return { error: 'too_large', size }
  const bytes = await readFile(path)
  return { mime: path === webp ? 'image/webp' : row.mime, data: bytes.toString('base64') }
}

// ---------- 凭证 ----------

/** 凭证绑的会话上下文：这把凭证是给哪一页上的哪个 agent 的。Ramet 工具（新建页默认放当前页下、审批弹在当前页、
 *  叫别的 agent 留痕在调用方的过程页里）都要它；由凭证决定，不让 AI 传 pageId 冒充别的会话。
 *  canDispatch = 能不能叫别的 agent（被叫的会话不能，只嵌一层）。 */
export type GrantCtx = {
  pageId: string | null
  agentId: string
  canDispatch: boolean
  /** 带队（/带队）的组长凭证：只在这一轮有效，决定多出哪个工具（plan → submit_plan；exec → send_back）。
   *  组员和普通会话没有这一项，端点按这一项判定，不看工具清单 */
  team?: { kind: 'plan' | 'exec'; runId: string; planId?: string }
  /** 精简档（agents/tool-profile.ts）的凭证：只认 read_page / read_image / edit_page，/api/ramet/* 的其余端点一律 403。
   *  没有这一项 = 完整档；无档不签凭证（不挂 MCP） */
  profile?: 'minimal'
}

type Grant = { userId: string; scope: string; expiresAt: number; ctx: GrantCtx }

const grants = new Map<string, Grant>()

function ttlMs(): number {
  const raw = Number(process.env.RAMET_PAGE_TOKEN_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : PAGE_TOKEN_TTL_MS
}

function sweep(now: number): void {
  for (const [token, g] of grants) if (g.expiresAt <= now) grants.delete(token)
}

/** 签发凭证。scope = 适配器 key（agent id）：适配器进程被回收 / connector 掉线时按它撤销。
 *  ctx 缺省 = 没绑页面、不能叫别的 agent（只能读写页面内容，不能弹审批） */
export function mintPageToken(userId: string, scope: string, ctx: Partial<GrantCtx> = {}): string {
  const token = randomBytes(32).toString('hex')
  sweep(Date.now())
  grants.set(token, {
    userId,
    scope,
    expiresAt: Date.now() + ttlMs(),
    ctx: {
      pageId: ctx.pageId ?? null,
      agentId: ctx.agentId ?? scope,
      canDispatch: ctx.canDispatch ?? false,
      ...(ctx.team ? { team: ctx.team } : {}),
      ...(ctx.profile ? { profile: ctx.profile } : {}),
    },
  })
  return token
}

/** 撤销某一轮带队的组长凭证（一轮结束就作废） */
export function revokeTeamGrants(runId: string): void {
  for (const [token, g] of grants) if (g.ctx.team?.runId === runId) grants.delete(token)
}

/** 撤销某适配器名下全部凭证（凭证不该活过适配器进程） */
export function revokePageTokens(scope: string): void {
  for (const [token, g] of grants) if (g.scope === scope) grants.delete(token)
}

/** 撤销某人在某适配器名下的全部凭证（他在那台机器上的授权被收回），同一适配器上别人的凭证不动 */
export function revokePageTokensOf(userId: string, scope: string): void {
  for (const [token, g] of grants) if (g.userId === userId && g.scope === scope) grants.delete(token)
}

/** 测试用：清空凭证表 */
export function clearPageTokens(): void {
  grants.clear()
}

/** 凭证是不是精简档的。只查内存不查库，因为 /api/ramet/* 的档位闸门每个请求都过一次。无效凭证 = false，由端点自己 401 */
export function isMinimalGrant(token: string): boolean {
  const grant = grants.get(token)
  return grant !== undefined && grant.expiresAt > Date.now() && grant.ctx.profile === 'minimal'
}

/** 凭证 → 请求者 + 会话上下文。坏凭证 / 过期凭证 / 账号已删一律 null（调用方转 401，不透露任何页面信息） */
export async function pageGrantOf(
  pool: Pool,
  token: string,
): Promise<{ user: { id: string; role: 'admin' | 'user' }; ctx: GrantCtx } | null> {
  const grant = grants.get(token)
  if (!grant) return null
  if (grant.expiresAt <= Date.now()) {
    grants.delete(token)
    return null
  }
  const { rows } = await pool.query<{ role: 'admin' | 'user' }>('SELECT role FROM users WHERE id = $1', [
    grant.userId,
  ])
  const role = rows[0]?.role
  return role ? { user: { id: grant.userId, role }, ctx: grant.ctx } : null
}

/** 凭证 → 请求者（只要身份的端点用） */
export async function pageReadUser(
  pool: Pool,
  token: string,
): Promise<{ id: string; role: 'admin' | 'user' } | null> {
  return (await pageGrantOf(pool, token))?.user ?? null
}

// ---------- 能力的跨机形态与本机形态 ----------

/** 中心交给 AI 的一个能力：跨 WSS 只传 grant，命令由执行端自己拼（见文件头） */
export type PageTool = { mcp: PageToolGrant }

/** ACP 的 MCP stdio 配置（schema 的 McpServerStdio，没有 type 字段：stdio 是 union 的默认项）。
 *  含绝对路径，只在拉起 AI 的那台机器上生成（pageToolServer），不可跨机搬运。 */
export type AcpMcpServer = {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

const MCP_SCRIPT = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))

/** 本机拉起 AI 时的 stdio 配置：node 直跑这份代码旁边的 MCP 脚本（纯 JS，不依赖 tsx / 工作目录）。
 *  中心本机 agent 与 connector 各自调这一份，command/args 永远是执行端自己的路径。 */
export function pageToolServer(tool: PageTool): AcpMcpServer {
  return {
    name: 'ramet',
    command: process.execPath,
    args: [MCP_SCRIPT],
    env: [
      { name: READ_PAGE_URL_ENV, value: tool.mcp.url },
      { name: READ_PAGE_TOKEN_ENV, value: tool.mcp.token },
    ],
  }
}

/** 中心对外基址：`RAMET_PUBLIC_URL`（去尾斜杠）。
 *  本机 agent 与中心同机，缺省可回落到回环端口（传 `fallback`）；connector 在别的机器上，回环地址指向它自己，所以不给回落，没配就报错。 */
export function httpBaseFor(publicUrl: string | undefined, fallback?: string): string {
  const configured = publicUrl?.replace(/\/+$/, '')
  if (configured) return configured
  if (fallback) return fallback
  throw new Error('未配置 RAMET_PUBLIC_URL：connector 上的 agent 需要中心对外地址才能回打读页端点')
}

// ---------- 端点与 MCP 共用的读取内核 ----------

/** 未注入 DocWriter 时的兜底：直接拒绝写入，不静默丢内容。startServer 恒注入 createDocWriter。 */
const unavailableWriter: DocWriter = async () => {
  throw new Error('未注入文档写入会话（DocWriter）')
}

/** 读行 / 取图 / 写回端点，凭证走 Authorization: Bearer。必须挂在带 `use('*', requireAuth)` 的子应用
 *  （files / search / pages）之前，否则请求没到 handler 就被 401。`startServer` 里紧跟 authRoutes 挂载。 */
export function pageReadRoutes(
  pool: Pool,
  write?: DocWriter,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
) {
  const app = new Hono()

  /** Authorization: Bearer → 请求者。坏凭证 / 缺凭证一律 null（调用方转 401） */
  async function bearerUser(c: Context) {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    return token ? await pageReadUser(pool, token) : null
  }

  app.get(READ_PAGE_PATH, async (c) => {
    const user = await bearerUser(c)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    const { offset, limit } = normalizeReadParams(c.req.query('offset'), c.req.query('limit'))
    const block = c.req.query('block') || undefined
    const result = await readPageForUser(pool, user, c.req.param('id'), offset, limit, getLiveDoc, block)
    // 页面不存在 / 已回收 / 非成员一律同一个 404，不泄露存在性。页面读得到、块不在了是另一个 404
    if (result === NO_BLOCK) return c.json({ error: 'block not found' }, 404)
    return result ? c.json(result) : c.json({ error: 'page not found' }, 404)
  })

  // AI 取图走独立路径 /api/files/:id/ai，与公开页看图的 GET /api/files/:id 互不影响。
  // 图片字节本身不含权限语义，凭证有效即可
  app.get(READ_IMAGE_PATH, async (c) => {
    const user = await bearerUser(c)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    const img = await loadAiImage(pool, c.req.param('id'))
    // 不存在和不是图片都是 404，不区分
    if (img.error === 'not_found') return c.json({ error: 'image not found' }, 404)
    if (img.error === 'too_large') return c.json({ error: `图片太大（${Math.round(img.size / 1024)}KB），超过 1.5MB 上限` }, 413)
    return c.json({ mime: img.mime, data: img.data })
  })

  // AI 写回文档：ops 在一个 Yjs 事务里，失败不改文档（见 page-write.ts）。
  // 权限沿用 pages.ts 的 writable：非成员 / 不存在 404，viewer 403
  app.post(EDIT_PAGE_PATH, async (c) => {
    const user = await bearerUser(c)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('ops' in body)) return c.json({ error: 'body 需要 ops 数组' }, 400)
    let ops
    try {
      ops = parseOps(body.ops)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
    const outcome = await editPageForUser(pool, user, c.req.param('id'), ops, write ?? unavailableWriter)
    return 'ok' in outcome ? c.json({ ok: true }) : c.json({ error: outcome.error }, outcome.status)
  })

  return app
}

/** 活页面 + 可见性：必须是该页所在空间的成员，全局 admin 也不例外。
 *  不存在 / 已回收（live_pages 打不上）/ 非成员一律查不到，调用方转 404，不泄露存在性。 */
const SELECT_READABLE = `SELECT p.title FROM live_pages p
  WHERE p.id = $1 AND p.space_id IN (SELECT space_id FROM space_members WHERE user_id = $2)`

/** offset / limit 归一化：非法值回落缺省，limit 截到上限。offset 从 1 开始 */
function normalizeReadParams(
  offsetRaw: string | undefined,
  limitRaw: string | undefined,
): { offset: number; limit: number } {
  const offset = Number(offsetRaw)
  const limit = Number(limitRaw)
  return {
    offset: Number.isInteger(offset) && offset > 0 ? offset : 1,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, PAGE_LINES_MAX) : PAGE_LINES_DEFAULT,
  }
}

/** 页面读得到、但要读的块不在（`?block=` 时） */
const NO_BLOCK = 'no-block'

/** 按行切片：正文来自 `updates.fragmentSpans` 从当前文档（内存活文档优先）算出的整篇文字，
 *  与 edit_page 的 `old` 匹配的是同一份，不能用可能过期的 `pages.content_text`
 *  （协同存储钩子有 ~2s debounce，AI 刚写的字还读不到）。没有正文 = 空列表，不是错误。
 *  给了 `blockId` 就只读那一块（任意深度），文字用提示词口径（agents/refs.ts 的 standaloneMarkdown），不参与 edit_page 匹配。 */
async function readPageForUser(
  pool: Pool,
  user: { id: string; role: string },
  pageId: string,
  offset: number,
  limit: number,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  blockId?: string,
): Promise<PageReadResult | typeof NO_BLOCK | null> {
  const { rows } = await pool.query<{ title: string }>(SELECT_READABLE, [pageId, user.id])
  const row = rows[0]
  if (!row) return null
  const body = (await loadDocForRead(pool, `page:${pageId}`, getLiveDoc)).getXmlFragment('prosemirror')
  let text: string
  if (blockId) {
    const el = findBlockElement(body, blockId)
    if (!el) return NO_BLOCK
    text = standaloneMarkdown(el)
  } else {
    text = fragmentSpans(body).text
  }
  // ''.split 会给一个空行，那是假行
  const all = text ? text.split('\n') : []
  // 起点超过总行数 = 空窗而不是错误，AI 多翻一页不必区分读完了还是读不到
  const from = Math.min(offset - 1, all.length)
  return { title: row.title, offset, limit, total: all.length, lines: all.slice(from, from + limit) }
}
