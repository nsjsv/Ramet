// ---------- Genet 的定时器：set_timer / list_timers / update_timer / delete_timer ----------
// 只给 Genet（中心按凭证决定，见 /api/ramet/tools）。设好就生效，不弹审批（读到外来事件之后、用户亲自说话之前例外）；到点中心在 Genet 页写一条定时提醒叫醒 Genet，
// 或者在指定的任务页上以用户的身份写进指令、让那一页的 agent 接着跑（triggers/hub.ts）。
// 时间表是结构化参数（kind 枚举 + 各自的字段），不让中心去解析自然语言；时间都是用户时区的墙上时间。
import { broken, call, declined, failure, reply } from '../lib.mjs'

const SCHEDULE = {
  type: 'object',
  description:
    '时间表，按用户时区的本地时间：' +
    'once = 只一次（填 at）；daily = 每天（填 time）；weekly = 每周几（填 days 和 time，工作日 = [1,2,3,4,5]）；every = 每隔多少分钟（填 minutes，最少 60）',
  properties: {
    kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'every'] },
    at: { type: 'string', description: 'once 用：本地时间 YYYY-MM-DDTHH:MM，如 2026-11-07T09:00，必须晚于现在' },
    time: { type: 'string', description: 'daily / weekly 用：24 小时制 HH:MM，如 09:00' },
    days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'weekly 用：1 = 周一 … 7 = 周日' },
    minutes: { type: 'integer', minimum: 60, maximum: 10080, description: 'every 用：间隔分钟数，60 到 10080（7 天）' },
  },
  required: ['kind'],
}

const RESULT = { delivered: '送达', skipped: '跳过', failed: '失败', queued: '排队中', pending: '处理中' }

const targetText = (t) => (t.kind === 'genet' ? 'Genet（这个对话）' : `任务页 [@${t.title}](page:${t.pageId})`)

/** 一个定时器的一行说明（list_timers 与改完的回显共用） */
function line(t) {
  const parts = [`${t.id}「${t.name}」`, t.scheduleText]
  if (t.enabled && t.nextText) parts.push(`下次 ${t.nextText}（${t.timeZone}）`)
  else parts.push(t.pausedReason ? `已暂停：${t.pausedReason}` : t.enabled ? '不再触发' : '已暂停')
  parts.push(`到点叫 ${targetText(t.target)}`)
  if (t.last) parts.push(`最近一次：${RESULT[t.last.status] ?? t.last.status}${t.last.reason ? `（${t.last.reason}）` : ''}`)
  return parts.join(' · ')
}

export const tools = [
  {
    name: 'set_timer',
    define: () => ({
      name: 'set_timer',
      description:
        '设一个定时器：用户要求「到点 / 每天 / 每周 / 每隔多久」做某件事或提醒他时用。设好立刻生效。' +
        '到点时 Ramet 在这个对话里发一条以「[Ramet 定时提醒」开头的消息叫你按 instruction 去做；' +
        'target 填 page:<任务页id> 时则改为把 instruction 以用户的身份写进那个任务页、让那一页的 agent 接着做（做完照常通知你）。' +
        '时间按用户时区理解（你每一轮开头的「[现在：…]」那一行就是用户时区的当前时间）。返回时间表的说法和下次触发时间，告诉用户。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '短名字，40 字以内，如「喝水」「日报」' },
          instruction: { type: 'string', description: '到点要做什么，用用户的口吻写清楚（到点时你或任务页的 agent 只看得到这段）' },
          schedule: SCHEDULE,
          target: {
            type: 'string',
            description: '到点叫谁：不填 = Genet 自己（缺省，大多数情况）；page:<任务页id> = 那个任务页上的 agent（只能是你用 dispatch_task 派出去的任务页，适合重复的开发活）',
          },
        },
        required: ['name', 'instruction', 'schedule'],
      },
    }),
    run: async (args) => {
      const body = { name: args.name, instruction: args.instruction, schedule: args.schedule, ...(args.target ? { target: String(args.target) } : {}) }
      const r = await call('/api/ramet/timers', { method: 'POST', body })
      if (declined(r)) return declined(r)
      if (broken(r) || !r.json.timer) return failure('没能设好定时器', r)
      const t = r.json.timer
      return reply(`已设定时「${t.name}」：${t.scheduleText}，下次 ${t.nextText}（${t.timeZone}），到点叫 ${targetText(t.target)}。id: ${t.id}`)
    },
  },
  {
    name: 'list_timers',
    define: () => ({
      name: 'list_timers',
      description: '列出用户的定时器：id、名字、时间表、下次触发时间、到点叫谁、是否启用、最近一次的结果。改 / 删之前先用它找 id。',
      inputSchema: { type: 'object', properties: {} },
    }),
    run: async () => {
      const r = await call('/api/ramet/timers')
      if (!r.ok || !Array.isArray(r.json?.timers)) return failure('列不出定时器', r)
      const { timers, now, timeZone } = r.json
      if (timers.length === 0) return reply(`还没有定时器（现在是 ${now}，${timeZone}）。`)
      return reply([`现在是 ${now}（${timeZone}），共 ${timers.length} 个定时器：`, ...timers.map((t) => `- ${line(t)}`)].join('\n'))
    },
  },
  {
    name: 'update_timer',
    define: () => ({
      name: 'update_timer',
      description:
        '改一个定时器：名字、指令、时间表，或者暂停 / 恢复（enabled）。只填要改的。改时间表不会自动恢复已暂停的定时器，' +
        '要它重新生效（比如已经触发过的一次性定时）就同时填 enabled: true。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '定时器 id（list_timers / set_timer 返回的）' },
          name: { type: 'string' },
          instruction: { type: 'string' },
          schedule: SCHEDULE,
          enabled: { type: 'boolean', description: 'false = 暂停，true = 恢复' },
        },
        required: ['id'],
      },
    }),
    run: async (args) => {
      const id = encodeURIComponent(String(args.id ?? ''))
      const body = Object.fromEntries(['name', 'instruction', 'schedule', 'enabled'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]))
      const r = await call(`/api/ramet/timers/${id}`, { method: 'PATCH', body })
      if (declined(r)) return declined(r)
      if (broken(r) || !r.json.timer) return failure('没能改好定时器', r)
      return reply(`已改好：${line(r.json.timer)}`)
    },
  },
  {
    name: 'delete_timer',
    define: () => ({
      name: 'delete_timer',
      description: '删掉一个定时器（之后不再触发）。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '定时器 id' } }, required: ['id'] },
    }),
    run: async (args) => {
      const r = await call(`/api/ramet/timers/${encodeURIComponent(String(args.id ?? ''))}`, { method: 'DELETE' })
      if (declined(r)) return declined(r)
      if (broken(r) || !r.json.ok) return failure('没能删掉定时器', r)
      return reply(`已删除定时「${r.json.name}」。`)
    },
  },
]
