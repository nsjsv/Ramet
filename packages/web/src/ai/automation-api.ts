/* ---------- 规则（自动化）的 REST 客户端（服务端 routes/automations.ts；形状同 server/src/triggers/rules.ts 的 AutomationView）----------
 * 规则 = 触发（来源 + 来源的配置）+ 一串动作，以主人的身份执行。定时器也是规则（source = 'timer'，config = 时间表）。
 * 校验全在服务端：400 的 message 是人话，表单照着显示。触发与动作的说明一律用服务端给的 triggerText / actionsText。 */

import type { Condition } from '@ramet/shared/collection-model'
import { request } from '../api'

/** 规则的来源（与服务端 triggers/payload.ts 的 TRIGGER_SOURCES 同一份；新来源在这里加一项） */
export const RULE_SOURCES = ['timer', 'comment', 'mention', 'page_watch', 'webhook', 'collection', 'button', 'ai_block', 'ai_prop'] as const
export type RuleSource = (typeof RULE_SOURCES)[number]

/** 时间表（服务端 triggers/schedule.ts 的 Schedule）：once 的 at 是本地墙上时间 'YYYY-MM-DDTHH:MM'，days 1 = 周一 … 7 = 周日 */
export type Schedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'every'; minutes: number }

/** 动作（服务端 triggers/actions.ts 的 Action）。set / props 的键是属性名或属性 id，值里的字符串可以带变量 */
export type Action =
  | { type: 'genet'; instruction: string }
  | { type: 'agent'; page: string; agent: string; instruction: string }
  | { type: 'set_props'; row: string; set: Record<string, unknown> }
  | { type: 'create_page'; parent: string; title: string; template?: string; props?: Record<string, unknown> }
  | { type: 'notify'; to: 'owner' | string[]; text: string }
  | { type: 'webhook'; url: string; body?: string }
  /** 刷新 AI 块：只从 AI 块的「自动更新」建，表单里只读 */
  | { type: 'ai_gen'; page: string; block: string }
  /** 填 AI 属性：只从 AI 属性的「自动更新」建，表单里只读 */
  | { type: 'ai_prop'; collection: string; prop: string; row: string }

export type ActionType = Action['type']

export type ActionResult = { type: string; status: 'done' | 'failed' | 'skipped' | 'queued' | 'waiting'; reason: string }

export type RuleStatus = 'pending' | 'queued' | 'delivered' | 'skipped' | 'failed'

export type AutomationView = {
  id: string
  name: string
  /** 服务端可能比前端新：认不出的来源照样列出来，只是不能改触发 */
  source: RuleSource | (string & {})
  /** 来源的配置：定时 = Schedule */
  config: unknown
  triggerText: string
  timeZone: string
  nextAt: string | null
  /** 下次触发的当地时间；不再触发（暂停 / 一次性已触发 / 事件来源）为空 */
  nextText: string
  actions: Action[]
  actionsText: string[]
  enabled: boolean
  /** 连续失败自动暂停的原因；手动暂停为空 */
  pausedReason: string
  /** 挂靠页（合集 / 按钮 / AI 块所在页） */
  scopePage: { id: string; title: string } | null
  /** 最近一次：at = 那次本应触发的时刻（事件 = 发生时刻）；results = 每个动作的结局 */
  last: { status: RuleStatus; reason: string; at: string; results: ActionResult[] } | null
  createdAt: string
  /** 每人一条的内置规则（评论找我 / 正文 @我）：只能关、不能删、不能改名；普通规则为 null。旧服务端不给 */
  builtin?: BuiltinSource | null
  /** 内置规则此刻还不能生效的原因：这期间事件来了直接不发；能生效为 null */
  dormant?: RuleDormant | null
  /** 主人的用户名（合集上列出别人的规则时写明是谁的） */
  ownerName?: string
  /** 看的人就是主人：只有主人能改 / 删（合集上列出的别人的规则只读） */
  mine?: boolean
}

/** 还不能生效：code 认补救办法（服务端 triggers/builtin.ts 的 DormantCode：no_connection / no_genet_page；认不出的不给按钮），text 是显示的人话 */
export type RuleDormant = { code: string; text: string }

/** 内置规则的来源（服务端 triggers/builtin.ts 的 BUILTIN_SOURCES） */
export type BuiltinSource = 'comment' | 'mention'

/** 评论为什么找我（服务端 triggers/builtin.ts 的 COMMENT_REASONS，顺序同） */
export const COMMENT_REASONS = ['mention', 'reply', 'new_thread'] as const
export type CommentReason = (typeof COMMENT_REASONS)[number]

/** 「评论找我」的配置：spaces 空 = 全部空间 */
export type CommentConfig = { reasons: CommentReason[]; spaces: string[] }
/** 「正文 @我」的配置 */
export type MentionConfig = { spaces: string[] }
/** 合集里有变化：新增了一行 / 属性改了（只看哪些属性、改成满足哪些条件） */
export type CollectionConfig = { collection: string; on: 'added' | 'edited'; props: string[]; filter: { all: Condition[] } }
/** 盯页面：盯哪一页、含不含子页、别人停手多少分钟算改完 */
export type WatchConfig = { page: string; subtree: boolean; quiet: number }

export type RuleInput = { name: string; source: RuleSource; config: unknown; actions: Action[]; scopePage?: string }
export type RulePatch = { name?: string; config?: unknown; actions?: Action[]; enabled?: boolean }

const path = (id: string): string => `/api/me/automations/${encodeURIComponent(id)}`

export const automationApi = {
  list: () => request<{ automations: AutomationView[]; timeZone: string }>('/api/me/automations'),
  /** hookPath = 收到外部请求的地址（/api/hooks/<密钥>），只在这一次给 */
  create: (input: RuleInput) =>
    request<{ automation: AutomationView; hookPath?: string }>('/api/me/automations', { method: 'POST', body: JSON.stringify(input) }),
  /** 收到外部请求的规则换地址：旧地址立刻失效，新地址只给这一次 */
  rotateHook: (id: string) => request<{ automation: AutomationView; hookPath: string }>(`${path(id)}/hook`, { method: 'POST' }),
  update: (id: string, patch: RulePatch) =>
    request<{ automation: AutomationView }>(path(id), { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.automation),
  remove: (id: string) => request<unknown>(path(id), { method: 'DELETE' }),
  /** 挂在这一页（合集）上的规则：编辑者看得到，别人的只读 */
  scoped: (pageId: string) => request<{ automations: AutomationView[] }>(`/api/pages/${pageId}/automations`).then((r) => r.automations),
}
