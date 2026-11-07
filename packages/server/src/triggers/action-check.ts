// ---------- 保存 / 恢复规则时，按主人此刻的身份现判动作的目标（AI 页的 REST 与 Genet 的定时器工具共用） ----------
// 只判「现在就知道不行」的：页面 / 合集 / 模板还在、主人可写或读得到、属性名对得上、收件人是空间成员。
// agent 在不在线不判（机器可能只是暂时离线，配规则时不该被挡），到点执行时 hub.ts 照常再按主人此刻的身份判一次。

import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { isPropId } from '@ramet/shared/collection-model'
import { pageAccess } from '../collab.js'
import { readSchema } from '../collections/store.js'
import { collectionGate } from '../routes/collections.js'
import { EVENT_ROW, type Action } from './actions.js'
import type { TriggerSource } from './payload.js'

type User = { id: string; role: string }

/** 叫 agent 的目标是某人的 Genet 页：那是 Genet 自己的对话，别的 agent 在上面跑会把它搅乱 */
export const GENET_PAGE_TARGET = 'Genet 页是 Genet 自己的对话，叫 agent 要选别的页（要叫 Genet 用「叫 Genet」动作）'

export async function isGenetPage(pool: Pick<Pool, 'query'>, pageId: string): Promise<boolean> {
  return ((await pool.query('SELECT 1 FROM assistants WHERE page_id = $1', [pageId])).rowCount ?? 0) > 0
}

export type CheckCtx = {
  pool: Pool
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  owner: User
  source: TriggerSource
  /** 规则所在空间（发通知的收件人必须是它的成员） */
  spaceId: string
  /** 内置规则（builtin.ts）：没有 Genet 页只是「还不能生效」（列表上写明、事件来了不发），不拦保存与开关 */
  genetOptional?: boolean
}

/** 事件不带合集行的来源：改属性只能指定行 */
const NO_EVENT_ROW: Partial<Record<TriggerSource, string>> = {
  timer: '定时规则没有「事件所在的行」：要指定改哪一行',
  comment: '评论触发的规则没有「事件所在的行」：要指定改哪一行',
  mention: '正文 @ 触发的规则没有「事件所在的行」：要指定改哪一行',
  page_watch: '盯页面的规则没有「事件所在的行」（一次汇报可能是好几页）：要指定改哪一行',
  webhook: '收到外部请求的规则没有「事件所在的行」：要指定改哪一行',
}

async function writablePage(pool: Pool, owner: User, pageId: string, kind: 'doc' | 'any', what: string): Promise<{ kind: string } | string> {
  const page = (await pool.query<{ kind: string; title: string }>('SELECT kind, title FROM live_pages WHERE id = $1', [pageId])).rows[0]
  const role = page ? await pageAccess(pool, pageId, owner) : null
  if (!page || role === null || (kind === 'doc' && page.kind !== 'doc')) return `${what}已经不在了（进了回收站），或者你看不到它了`
  if (role === 'viewer') return `你不能编辑${what}《${page.title || '无标题'}》`
  return { kind: page.kind }
}

/** 属性名 / id 都要在合集里（值的类型到执行时按那一刻的定义判） */
async function propsKnown(ctx: CheckCtx, collectionId: string, keys: string[]): Promise<string | null> {
  const schema = await readSchema(ctx.pool, collectionId, ctx.getLiveDoc)
  const missing = keys.find((k) => !schema.props.some((p) => (isPropId(k) && p.id === k) || p.name.trim() === k.trim()))
  return missing === undefined ? null : `合集里没有叫「${missing}」的属性`
}

async function checkOne(ctx: CheckCtx, a: Action): Promise<string | null> {
  const { pool, owner } = ctx
  switch (a.type) {
    case 'genet': {
      if (ctx.genetOptional) return null
      const home = (await pool.query('SELECT 1 FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1', [owner.id])).rowCount
      return home ? null : 'Genet 页还没有建好：先打开一次 AI 页'
    }
    case 'agent': {
      const page = await writablePage(pool, owner, a.page, 'doc', '目标页')
      if (typeof page === 'string') return page
      return (await isGenetPage(pool, a.page)) ? GENET_PAGE_TARGET : null
    }
    case 'set_props': {
      if (a.row === EVENT_ROW) return NO_EVENT_ROW[ctx.source] ?? null
      const parent = (await pool.query<{ parent_id: string | null }>("SELECT parent_id FROM live_pages WHERE id = $1 AND kind = 'doc'", [a.row])).rows[0]?.parent_id
      const gate = parent ? await collectionGate(pool, owner, parent, 'write') : null
      if (!parent || !gate?.ok) return `row:${a.row} 不是你能编辑的合集里的行`
      return propsKnown(ctx, parent, Object.keys(a.set))
    }
    case 'create_page': {
      const parent = await writablePage(pool, owner, a.parent, 'any', '要建在的那一页')
      if (typeof parent === 'string') return parent
      if (parent.kind !== 'doc' && parent.kind !== 'collection') return '只能建在文档页或合集下'
      if (a.template && (await pageAccess(pool, a.template, owner)) === null) return `模板页 page:${a.template} 不在了，或者你看不到它`
      if (a.props && parent.kind !== 'collection') return '只有建在合集下（新建行）才能填属性'
      return a.props ? propsKnown(ctx, a.parent, Object.keys(a.props)) : null
    }
    case 'notify': {
      if (a.to === 'owner') return null
      const members = new Set(
        (await pool.query<{ user_id: string }>('SELECT user_id FROM space_members WHERE space_id = $1 AND user_id = ANY($2::text[])', [ctx.spaceId, a.to])).rows.map((r) => r.user_id),
      )
      const outsider = a.to.find((u) => !members.has(u))
      return outsider === undefined ? null : `收件人 ${outsider} 不是这个空间的成员`
    }
    case 'webhook':
      return null
    case 'ai_prop': {
      if (a.row === EVENT_ROW && NO_EVENT_ROW[ctx.source]) return NO_EVENT_ROW[ctx.source]!
      const gate = await collectionGate(pool, owner, a.collection, 'write')
      return gate.ok ? null : '要填 AI 属性的合集不在了，或者你不能编辑它'
    }
    // 块在不在、是不是 AI 块到执行时判（块会被移动 / 删掉，页面在、能写是保存时就知道的）
    case 'ai_gen': {
      const page = await writablePage(pool, owner, a.page, 'doc', 'AI 块所在的那一页')
      return typeof page === 'string' ? page : null
    }
  }
}

/** 第一个不行的动作的原因（多个动作时写明第几个）；都行 = null */
export async function checkActions(ctx: CheckCtx, actions: readonly Action[]): Promise<string | null> {
  for (const [i, a] of actions.entries()) {
    const reason = await checkOne(ctx, a)
    if (reason) return actions.length > 1 ? `第 ${i + 1} 个动作：${reason}` : reason
  }
  return null
}
