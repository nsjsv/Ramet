// ---------- Genet 盯页面：watch_page / list_watches / unwatch_page ----------
// 只给 Genet（中心按凭证决定，见 /api/ramet/tools）。盯好就生效（读到外来事件之后、用户亲自说话之前例外，先问用户）：
// 别人改了那一页（可连子页）、停手满设定的时长后，中心在这个对话里写一条「[Ramet 自动化」开头的通知，带改动摘要，叫你按 instruction 处理
// （routes/watch-tools.ts、triggers/sources/page-watch.ts）。用户自己改的不算。
import { broken, call, declined, failure, reply } from '../lib.mjs'

const RESULT = { delivered: '送达', skipped: '跳过', failed: '失败', queued: '排队中', pending: '处理中' }

/** 一条盯页面规则的一行说明（list_watches 与建好的回显共用） */
function line(w) {
  const parts = [`${w.id}「${w.name}」`, w.triggerText]
  if (!w.enabled) parts.push(w.pausedReason ? `已暂停：${w.pausedReason}` : '已暂停')
  else parts.push(w.nextText ? `攒着改动，约 ${w.nextText} 汇报` : '盯着，还没人改')
  if (w.last) parts.push(`最近一次：${RESULT[w.last.status] ?? w.last.status}${w.last.reason ? `（${w.last.reason}）` : ''}`)
  return parts.join(' · ')
}

export const tools = [
  {
    name: 'watch_page',
    define: () => ({
      name: 'watch_page',
      description:
        '盯一页：用户要你「盯着 / 留意 / 有人改了告诉我」某一页（或某一页及子页）时用。盯好立刻生效。' +
        '之后别人（不是用户自己）改了那里、停手满 quiet_minutes 分钟，Ramet 在这个对话里发一条以「[Ramet 自动化」开头的通知，' +
        '带「谁改的、改成了什么」的摘要，叫你按 instruction 处理。返回规则的说明，告诉用户。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: '要盯的页：page:<id> 或页面 id' },
          subtree: { type: 'boolean', description: '连子页一起盯（缺省 true）' },
          quiet_minutes: { type: 'integer', minimum: 1, maximum: 120, description: '别人停手多少分钟算改完（缺省 10）' },
          instruction: {
            type: 'string',
            description: '收到改动时要做什么，用用户的口吻写（缺省：看看改了什么，值得我知道的简要告诉我，不用管的就标记不用处理）',
          },
        },
        required: ['page'],
      },
    }),
    run: async (args) => {
      const body = {
        page: String(args.page ?? ''),
        ...(args.subtree !== undefined ? { subtree: args.subtree } : {}),
        ...(args.quiet_minutes !== undefined ? { quiet: args.quiet_minutes } : {}),
        ...(args.instruction ? { instruction: String(args.instruction) } : {}),
      }
      const r = await call('/api/ramet/watches', { method: 'POST', body })
      if (declined(r)) return declined(r)
      if (broken(r) || !r.json.watch) return failure('没能盯上', r)
      return reply(`已盯上：${line(r.json.watch)}`)
    },
  },
  {
    name: 'list_watches',
    define: () => ({
      name: 'list_watches',
      description: '列出用户盯着的页：id、范围、静默时长、是否攒着改动、最近一次的结果。不盯之前先用它找 id。',
      inputSchema: { type: 'object', properties: {} },
    }),
    run: async () => {
      const r = await call('/api/ramet/watches')
      if (!r.ok || !Array.isArray(r.json?.watches)) return failure('列不出盯着的页', r)
      const { watches } = r.json
      if (watches.length === 0) return reply('还没有盯着的页。')
      return reply([`共盯着 ${watches.length} 处：`, ...watches.map((w) => `- ${line(w)}`)].join('\n'))
    },
  },
  {
    name: 'unwatch_page',
    define: () => ({
      name: 'unwatch_page',
      description: '不盯了：删掉一条盯页面的规则（之后那里再改也不通知）。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '规则 id（list_watches / watch_page 返回的）' } }, required: ['id'] },
    }),
    run: async (args) => {
      const r = await call(`/api/ramet/watches/${encodeURIComponent(String(args.id ?? ''))}`, { method: 'DELETE' })
      if (declined(r)) return declined(r)
      if (broken(r) || !r.json.ok) return failure('没能取消', r)
      return reply(`已不再盯「${r.json.name}」。`)
    },
  },
]
