// ---------- 规则的动作：形状与校验（纯函数；AI 页的 REST、Genet 的定时器工具、库里读出来的都过 parseActions） ----------
// 一条规则 = 触发 + 一串动作（1–10 个，按序执行，第一个失败就停，见 run-actions.ts）。六种：
//   genet       叫 Genet：Genet 页尾写一条事件通知（定时器是定时提醒）带上 instruction，叫醒它
//   agent       叫 agent：在 page 上以主人身份写 instruction、用 agent 跑（走排队发送；页在 Genet 名下做完照常回报 Genet）
//   set_props   改属性：row = 'event'（事件所在的那一行）或行 id；set 的键是属性 id 或属性名，值里的字符串可以带变量
//   create_page 新建页 / 行：parent 是文档页就建子页（可选 template = 从那一页复制），是合集就建一行（props 同 set_props）
//   notify      发通知：给主人（'owner'）或规则所在空间的几位成员发一条收件箱通知
//   webhook     向外 webhook：POST JSON 到 url（出站防护，内网地址拒绝，10 秒超时）；body 缺省 = { rule, event, payload }
//   ai_gen      刷新 AI 块：按 page 上那个 AI 块（block = 块 id）的提示词重新生成（ai-gen.ts，主人的模型连接）
//   ai_prop     填 AI 属性：按合集 collection 里 AI 属性 prop 的要求给一行（row = 'event' 或行 id）填值（ai-prop.ts）
// 有 genet / agent / ai_gen 的规则算「含 AI」，每日次数上限更低（hasAi）。这里只校验形状；页面、行、agent 能不能用由保存时与每次执行前现判。

import { ASSISTANT_ID } from '../agents/assistant-agent.js'

export const ACTION_TYPES = ['genet', 'agent', 'set_props', 'create_page', 'notify', 'webhook', 'ai_gen', 'ai_prop'] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const ACTION_LIMITS = {
  /** 一条规则最多几个动作 */
  count: 10,
  instruction: 4000,
  title: 200,
  text: 2000,
  url: 2000,
  body: 20_000,
  /** 一次改几个属性 */
  props: 50,
  /** 属性值里一个字符串最长多少 */
  value: 2000,
  recipients: 50,
} as const

export type Action =
  | { type: 'genet'; instruction: string }
  | { type: 'agent'; page: string; agent: string; instruction: string }
  | { type: 'set_props'; row: string; set: Record<string, unknown> }
  | { type: 'create_page'; parent: string; title: string; template?: string; props?: Record<string, unknown> }
  | { type: 'notify'; to: 'owner' | string[]; text: string }
  | { type: 'webhook'; url: string; body?: string }
  | { type: 'ai_gen'; page: string; block: string }
  | { type: 'ai_prop'; collection: string; prop: string; row: string }

export const ACTION_LABEL: Record<ActionType, string> = {
  genet: '叫 Genet',
  agent: '叫 agent',
  set_props: '改属性',
  create_page: '新建页 / 行',
  notify: '发通知',
  webhook: '向外 webhook',
  ai_gen: '刷新 AI 块',
  ai_prop: '填 AI 属性',
}

/** set_props 的 row 写 'event' = 事件所在的那一行 */
export const EVENT_ROW = 'event'

type Fail = { error: string }
const fail = (error: string): Fail => ({ error })

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/** 去掉两头空白；空 / 超长 = 原因（按码点数：中文、emoji 都算一个字） */
function text(raw: unknown, max: number, what: string): string | Fail {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return fail(`${what}不能为空`)
  if ([...s].length > max) return fail(`${what}最多 ${max} 个字`)
  return s
}

function id(raw: unknown, what: string): string | Fail {
  const s = typeof raw === 'string' ? raw.trim().replace(/^page:/, '') : ''
  if (!s || s.length > 100) return fail(`要给出${what}`)
  return s
}

/** 属性值：键非空、个数有上限；值只收 JSON 原子值与它们的数组（字符串限长），对象一律不收 */
function propSet(raw: unknown, what: string): { set: Record<string, unknown> } | Fail {
  const r = record(raw)
  if (!r) return fail(`${what}要写成「属性 → 值」`)
  const entries = Object.entries(r)
  if (entries.length > ACTION_LIMITS.props) return fail(`${what}一次最多 ${ACTION_LIMITS.props} 个`)
  const out: Record<string, unknown> = {}
  const atom = (v: unknown): boolean =>
    v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && [...v].length <= ACTION_LIMITS.value)
  for (const [k, v] of entries) {
    const key = k.trim()
    if (!key) return fail(`${what}里有空的属性名`)
    if (!(atom(v) || (Array.isArray(v) && v.length <= ACTION_LIMITS.props && v.every(atom)))) return fail(`属性「${key}」的值写法不对`)
    out[key] = v
  }
  return { set: out }
}

function parseOne(raw: unknown): Action | Fail {
  const r = record(raw)
  const type = r?.type
  if (!r || typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) {
    return fail(`动作类型只能是 ${ACTION_TYPES.join(' / ')}`)
  }
  switch (type as ActionType) {
    case 'genet': {
      const instruction = text(r.instruction, ACTION_LIMITS.instruction, '给 Genet 的指令')
      return typeof instruction === 'string' ? { type: 'genet', instruction } : instruction
    }
    case 'agent': {
      const page = id(r.page, '在哪一页上跑')
      if (typeof page !== 'string') return page
      const agent = typeof r.agent === 'string' ? r.agent.trim() : ''
      if (!agent) return fail('要指定用哪个 agent')
      if (agent === ASSISTANT_ID) return fail('叫 Genet 请用「叫 Genet」动作')
      const instruction = text(r.instruction, ACTION_LIMITS.instruction, '给 agent 的指令')
      return typeof instruction === 'string' ? { type: 'agent', page, agent, instruction } : instruction
    }
    case 'set_props': {
      const row = r.row === undefined || r.row === EVENT_ROW ? EVENT_ROW : id(r.row, '要改哪一行')
      if (typeof row !== 'string') return row
      const set = propSet(r.set, '要改的属性')
      if ('error' in set) return set
      if (Object.keys(set.set).length === 0) return fail('至少改一个属性')
      return { type: 'set_props', row, set: set.set }
    }
    case 'create_page': {
      const parent = id(r.parent, '建在哪一页或哪个合集下')
      if (typeof parent !== 'string') return parent
      const title = text(r.title, ACTION_LIMITS.title, '标题')
      if (typeof title !== 'string') return title
      const out: Action = { type: 'create_page', parent, title }
      if (r.template !== undefined && r.template !== null && r.template !== '') {
        const template = id(r.template, '模板页')
        if (typeof template !== 'string') return template
        out.template = template
      }
      if (r.props !== undefined && r.props !== null) {
        const props = propSet(r.props, '新行的属性')
        if ('error' in props) return props
        if (Object.keys(props.set).length > 0) out.props = props.set
      }
      return out
    }
    case 'notify': {
      const body = text(r.text, ACTION_LIMITS.text, '通知的文字')
      if (typeof body !== 'string') return body
      if (r.to === undefined || r.to === 'owner') return { type: 'notify', to: 'owner', text: body }
      if (!Array.isArray(r.to) || r.to.length === 0 || r.to.length > ACTION_LIMITS.recipients || !r.to.every((u) => typeof u === 'string' && u.trim())) {
        return fail(`通知发给谁：owner（规则的主人），或 1–${ACTION_LIMITS.recipients} 位成员的用户 id`)
      }
      return { type: 'notify', to: [...new Set((r.to as string[]).map((u) => u.trim()))], text: body }
    }
    case 'webhook': {
      const url = typeof r.url === 'string' ? r.url.trim() : ''
      let parsed: URL | null = null
      try {
        parsed = url ? new URL(url) : null
      } catch {
        parsed = null
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return fail('webhook 地址要是 http(s) 开头的完整地址')
      if (url.length > ACTION_LIMITS.url) return fail(`webhook 地址最多 ${ACTION_LIMITS.url} 个字符`)
      if (r.body === undefined || r.body === null || r.body === '') return { type: 'webhook', url }
      if (typeof r.body !== 'string' || [...r.body].length > ACTION_LIMITS.body) return fail(`请求体要是文字，最多 ${ACTION_LIMITS.body} 个字`)
      return { type: 'webhook', url, body: r.body }
    }
    case 'ai_gen': {
      const page = id(r.page, 'AI 块在哪一页')
      if (typeof page !== 'string') return page
      const block = id(r.block, '是哪个 AI 块（块 id）')
      return typeof block === 'string' ? { type: 'ai_gen', page, block } : block
    }
    case 'ai_prop': {
      const collection = id(r.collection, '哪个合集')
      if (typeof collection !== 'string') return collection
      const prop = typeof r.prop === 'string' ? r.prop.trim() : ''
      if (!prop || prop.length > 40) return fail('要给出是哪个 AI 属性（属性 id）')
      const row = r.row === undefined || r.row === EVENT_ROW ? EVENT_ROW : id(r.row, '填哪一行')
      return typeof row === 'string' ? { type: 'ai_prop', collection, prop, row } : row
    }
  }
}

/** 一串动作；不合法 = 第几个动作的原因（人话，表单照着改） */
export function parseActions(raw: unknown): Action[] | Fail {
  if (!Array.isArray(raw) || raw.length === 0) return fail('至少要有一个动作')
  if (raw.length > ACTION_LIMITS.count) return fail(`一条规则最多 ${ACTION_LIMITS.count} 个动作`)
  const out: Action[] = []
  for (const [i, item] of raw.entries()) {
    const a = parseOne(item)
    if ('error' in a) return fail(raw.length > 1 ? `第 ${i + 1} 个动作：${a.error}` : a.error)
    out.push(a)
  }
  return out
}

/** 有叫 Genet / 叫 agent 的动作：算进 AI 的每日次数 */
export function hasAi(actions: readonly Action[]): boolean {
  return actions.some((a) => a.type === 'genet' || a.type === 'agent' || a.type === 'ai_gen' || a.type === 'ai_prop')
}

/** 「第 2 个动作（发通知）：原因」；只有一个动作时不加前缀（老定时器的原因原样） */
export function actionReason(actions: readonly Action[], index: number, reason: string): string {
  const a = actions[index]
  return actions.length > 1 && a ? `第 ${index + 1} 个动作（${ACTION_LABEL[a.type]}）：${reason}` : reason
}

/** 一个动作的一句话说明（列表的「动作摘要」、Genet 的回显）；title / agent 给了就用显示名 */
export function describeAction(a: Action, names: { page?: (id: string) => string; agent?: (id: string) => string } = {}): string {
  const page = (pid: string): string => `《${names.page?.(pid) ?? pid}》`
  const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s)
  switch (a.type) {
    case 'genet':
      return `叫 Genet：${clip(a.instruction)}`
    case 'agent':
      return `叫 ${names.agent?.(a.agent) ?? a.agent} 在${page(a.page)}：${clip(a.instruction)}`
    case 'set_props':
      return `改${a.row === EVENT_ROW ? '事件所在行' : ` row:${a.row} `}的 ${Object.keys(a.set).join('、')}`
    case 'create_page':
      return `在${page(a.parent)}下新建「${clip(a.title)}」${a.template ? `（用模板${page(a.template)}）` : ''}`
    case 'notify':
      return `通知${a.to === 'owner' ? '我' : ` ${a.to.length} 位成员`}：${clip(a.text)}`
    case 'webhook':
      return `POST ${clip(a.url)}`
    case 'ai_gen':
      return `刷新${page(a.page)}里的 AI 块`
    case 'ai_prop':
      return `填${page(a.collection)}的 AI 属性（${a.row === EVENT_ROW ? '事件所在行' : `row:${a.row}`}）`
  }
}
