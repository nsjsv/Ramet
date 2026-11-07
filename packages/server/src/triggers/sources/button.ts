// ---------- 来源：点按钮（source = 'button'，规则挂在按钮所在的页 / 合集上：scope_page） ----------
// 正文按钮块（节点 attrs.rule）与合集按钮列（属性 cfg.rule）都指向一条这样的规则；配置只有按钮上的字（label）。
// 点按钮 = POST /api/automations/:id/press：能编辑那一页（合集按钮：能编辑那个合集、行是它的活行）的人才点得了；
//   规则必须挂在点它的那一页上——按钮被复制到别的页时，指着的还是原来那一页的规则，点了要说清楚，而不是在别处跑起来。
// 触发者 = 点的人：别人点主人的按钮是外来的（AI 动作有副作用先问主人，D6），主人自己点照常跑。点完不等动作（后台跑），先回「已触发」。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { pageAccess } from '../../collab.js'
import { memberRow, readSchema } from '../../collections/store.js'
import { rowTexts } from '../../collections/value-text.js'
import type { TriggerHub } from '../hub.js'
import type { EventPayload } from '../payload.js'
import { textCtx } from './collection.js'

export const BUTTON_LABEL_MAX = 40

/** { label }：按钮上的字，1–40 字 */
export function parseButtonConfig(raw: unknown): { label: string } | { error: string } {
  const label = typeof (raw as { label?: unknown } | null)?.label === 'string' ? (raw as { label: string }).label.replace(/\s+/g, ' ').trim() : ''
  if (!label) return { error: '按钮上写什么？（label 不能为空）' }
  if ([...label].length > BUTTON_LABEL_MAX) return { error: `按钮上的字最多 ${BUTTON_LABEL_MAX} 个` }
  return { label }
}

export function describeButton(raw: unknown): string {
  const c = parseButtonConfig(raw)
  return 'error' in c ? '点按钮' : `点「${c.label}」按钮`
}

export type PressDeps = { pool: Pool; hub: Pick<TriggerHub, 'emit' | 'background'>; getLiveDoc?: (docName: string) => Y.Doc | undefined }
export type PressResult = { status: 200; name: string } | { status: 400 | 403 | 404 | 409; error: string }

const NOT_SET = '这个按钮还没设置，或者它的设置已经删了'

/** 点一个按钮：判过权限与归属后在后台触发，立刻返回 */
export async function pressButton(
  deps: PressDeps,
  user: { id: string; role: string },
  ruleId: string,
  input: { page?: unknown; row?: unknown },
): Promise<PressResult> {
  const { pool } = deps
  const rule = (
    await pool.query<{ id: string; source: string; enabled: boolean; scope_page: string | null; config: unknown }>(
      'SELECT id, source, enabled, scope_page, config FROM agent_triggers WHERE id = $1',
      [ruleId],
    )
  ).rows[0]
  if (!rule || rule.source !== 'button') return { status: 404, error: NOT_SET }
  const page = typeof input.page === 'string' ? input.page.replace(/^page:/, '') : ''
  if (!page || rule.scope_page !== page) return { status: 400, error: '这个按钮的设置在别的页上：重新设置一下' }
  const role = await pageAccess(pool, page, user)
  if (role === null) return { status: 404, error: '这一页不在了，或者你看不到它' }
  if (role === 'viewer') return { status: 403, error: '只读成员不能点按钮' }
  if (!rule.enabled) return { status: 409, error: '这个按钮的设置暂停了' }
  const target = (await pool.query<{ kind: string; title: string }>('SELECT kind, title FROM live_pages WHERE id = $1', [page])).rows[0]
  if (!target) return { status: 404, error: '这一页不在了，或者你看不到它' }
  const label = describeButtonLabel(rule.config)
  const actor = { id: user.id, name: (await pool.query<{ username: string }>('SELECT username FROM users WHERE id = $1', [user.id])).rows[0]?.username ?? '' }
  const extra: Array<[string, string]> = [
    ['按钮', label],
    ['所在页', `《${target.title || '无标题'}》（page:${page}）`],
  ]
  let payload: Omit<EventPayload, 'source'>
  if (target.kind === 'collection') {
    const rowId = typeof input.row === 'string' ? input.row : ''
    const found = rowId ? await memberRow(pool, rowId) : null
    if (!found || found.collectionId !== page) return { status: 400, error: '那一行不在这个合集里了' }
    const schema = await readSchema(pool, page, deps.getLiveDoc)
    payload = {
      actor,
      page: { id: found.row.id, title: found.row.title },
      row: { id: found.row.id, props: rowTexts(schema, found.row, await textCtx(pool, schema, [found.row])) },
      extra: [...extra, ['链接', `/page/${found.row.id}`]],
    }
  } else {
    payload = { actor, page: { id: page, title: target.title }, extra }
  }
  deps.hub.background(() =>
    deps.hub.emit({
      source: 'button',
      key: `button:${rule.id}:${randomUUID()}`,
      scopePage: page,
      actorId: user.id,
      payload,
      match: (r) => r.id === rule.id,
    }),
  )
  return { status: 200, name: label }
}

function describeButtonLabel(raw: unknown): string {
  const c = parseButtonConfig(raw)
  return 'error' in c ? '按钮' : c.label
}
