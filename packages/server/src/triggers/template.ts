// ---------- 动作里的变量：{{actor}} {{page}} {{page_link}} {{text}} {{row.<属性名>}} {{now}} {{rule}}（纯函数） ----------
// 规则配好的文字（指令、标题、属性值、通知、webhook 请求体）在每次触发时按这一次的事件展开。
// 认不出的变量原样留着：拼错了用户在结果里一眼看得出，不会悄悄变成空串。没有值的变量（定时器没有触发者）展开成空串。
// 向外 webhook 的请求体是 JSON，展开时把值按 JSON 字符串转义（escape），用户写的 "{{text}}" 里有引号也不会把请求体弄坏。

import { taskMention } from '../agents/assistant-agent.js'
import { localStamp } from './schedule.js'
import type { EventPayload } from './payload.js'

/** 编辑器上提示的变量（顺序即提示顺序）；row.<属性名> 另算 */
export const TEMPLATE_VARS = ['actor', 'page', 'page_link', 'text', 'now', 'rule'] as const

export type TemplateVars = {
  actor: string
  page: string
  page_link: string
  text: string
  now: string
  rule: string
  row: Record<string, string>
}

export function templateVars(p: EventPayload, rule: string, now: Date, tz: string): TemplateVars {
  return {
    actor: p.actor?.name ?? '',
    page: p.page?.title ?? '',
    page_link: p.page ? taskMention(p.page.title || '无标题', p.page.id) : '',
    text: p.text ?? '',
    now: localStamp(now, tz),
    rule,
    row: p.row?.props ?? {},
  }
}

const VAR = /\{\{\s*([a-z_]+)(?:\.([^{}]+?))?\s*\}\}/g

/** 字符串里的变量展开；escape 给了就对每个值先转义 */
export function expand(template: string, vars: TemplateVars, escape?: (v: string) => string): string {
  return template.replace(VAR, (whole, name: string, sub: string | undefined) => {
    let value: string | undefined
    if (name === 'row' && sub !== undefined) value = vars.row[sub.trim()]
    else if (sub === undefined && (TEMPLATE_VARS as readonly string[]).includes(name)) value = vars[name as (typeof TEMPLATE_VARS)[number]]
    if (value === undefined) return whole
    return escape ? escape(value) : value
  })
}

/** JSON 字符串里的转义（不带两边的引号） */
export const jsonEscape = (v: string): string => JSON.stringify(v).slice(1, -1)

/** 任意值里的字符串都展开（属性值可能是数组 / 对象），别的原样 */
export function expandValue(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === 'string') return expand(value, vars)
  if (Array.isArray(value)) return value.map((v) => expandValue(v, vars))
  return value
}
