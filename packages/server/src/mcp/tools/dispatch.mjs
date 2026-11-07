// ---------- AI 互调：run_agent / Genet 派活：dispatch_task ----------
// 只有能叫人的会话才有 run_agent（中心按凭证决定，见 /api/ramet/tools）：被叫的会话不能再叫，只嵌一层。
// 叫人本身不用批；被叫 agent 里的危险操作照常弹审批（在调用方所在的页面）。
// 被叫的 agent 只拿到 task 和 task 里的 page: 引用（自己用 read_page 读）；它的步骤与回答留痕在调用方的过程页里。
// dispatch_task 只给 Genet：不等对方做完，在 Genet 页下建一个任务页、让那个 agent 在那里开跑就返回，进度在任务页上。
// model / effort 只在用户点名时填：中心把它们写成任务页的页面级配置（任务页上的追问照样用），对不上就派不出去并列出可选值。
// 派出去的那一轮做完 / 失败时中心会在 Genet 页写一条任务通知并叫醒 Genet（agents/task-watch.ts）；wait_task 只给必须拿到结果才能往下走的时候用。
import { broken, call, declined, failure, reply } from '../lib.mjs'

/** 可派 / 可叫的 agent 写进工具说明：id（名字），现在用不了的带上原因 */
const agentList = (agents) =>
  agents.map((a) => `${a.id}（${a.label}${a.unavailable ? `，现在用不了：${a.unavailable}` : ''}）`).join('、')

export const tools = [
  {
    name: 'run_agent',
    define: (caps) => ({
      name: 'run_agent',
      description:
        '把一个子任务交给另一个 AI agent 做，等它做完把结果带回来（同步，可能要几分钟）。' +
        '被叫的 agent 看不到当前对话，只拿到你写的 task：要它读的页面 / 块用 page:<页面id> / page:<页面id>#<块id> 写进 task（它自己用 read_page 读）；' +
        '它里面的危险操作照常弹审批；它不能再叫别的 agent。可叫的 agent：' +
        agentList(caps.agents) +
        '。',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: caps.agents.map((a) => a.id), description: '叫哪个 agent' },
          task: { type: 'string', description: '要它做的事，写清楚；需要它读的页面 / 块带上 page: 引用' },
        },
        required: ['agent', 'task'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/run-agent', { method: 'POST', body: { agent: String(args.agent ?? ''), task: String(args.task ?? '') } })
      if (!r.ok || !r.json) return failure('叫 agent 失败', r)
      const out = r.json
      if (out.error) return reply(`子任务没有完成：${out.error}${out.output ? `\n\n它已经说的：\n${out.output}` : ''}`, true)
      const meta = [out.label || out.agent, out.outcome === 'cancelled' ? '已停止' : '完成', `${out.steps} 步`, `${Math.max(1, Math.round(out.ms / 1000))}s`]
      return reply(`[${meta.join(' · ')}]\n${out.output || '（它没有给出文字回答）'}`)
    },
  },
  {
    name: 'dispatch_task',
    define: (caps) => ({
      name: 'dispatch_task',
      description:
        '把一件要在机器上动手的活（写代码、改项目、跑命令、查机器上的文件等）派给用户机器上的 agent：在 Genet 页下新建一个任务页，' +
        '以用户的身份写进任务说明，让那个 agent 在任务页上开跑，立即返回，不等它做完。' +
        '对方看不到这段对话，只拿到 task：要它读的页面 / 块用 page:<页面id> / page:<页面id>#<块id> 写进 task。' +
        '返回的 mention 要原样写进你的回复：它显示成任务页的链接，旁边是实时的进度。它做完或失败时 Ramet 会在对话里发一条任务通知叫你接着处理，不用等。' +
        '派不出去会返回原因，照实告诉用户。' +
        '用户点名了模型或思考程度才填 model / effort；对不上时会列出可选值，照着重填，拿不准就问用户。' +
        (caps.agents.length > 0
          ? `可派的 agent：${agentList(caps.agents)}。`
          : '现在没有可派的 agent（机器都不在线，或者用户还没有接入机器）。'),
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            ...(caps.agents.length > 0 ? { enum: caps.agents.map((a) => a.id) } : {}),
            description: '派给哪个 agent（用户点名了就用点名的那个）',
          },
          title: { type: 'string', description: '任务页的标题，一句话' },
          task: { type: 'string', description: '要它做的事，写清楚目标与要求；需要它读的页面 / 块带上 page: 引用' },
          model: {
            type: 'string',
            description: '让它用哪个模型（如 opus）。只在用户指定了模型时填，没指定就不填，用这个 agent 自己的默认；对不上会返回可选值',
          },
          effort: {
            type: 'string',
            description: '思考程度 / 推理强度（如 high、高）。只在用户指定了时填，没指定就不填；对不上会返回可选值',
          },
        },
        required: ['agent', 'title', 'task'],
      },
    }),
    run: async (args) => {
      // 空串当没填：模型偶尔会把可选参数填成 ''，那不是「用户指定了」
      const opt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      const r = await call('/api/ramet/dispatch', {
        method: 'POST',
        body: {
          agent: String(args.agent ?? ''),
          title: String(args.title ?? ''),
          task: String(args.task ?? ''),
          ...(opt(args.model) ? { model: opt(args.model) } : {}),
          ...(opt(args.effort) ? { effort: opt(args.effort) } : {}),
        },
      })
      if (declined(r)) return declined(r)
      if (broken(r)) return failure('派不出去', r)
      const out = r.json
      const applied = Array.isArray(out.applied) && out.applied.length > 0 ? `（${out.applied.map((a) => `${a.name} ${a.value}`).join(' · ')}）` : ''
      return reply(`已派给 ${out.label}${applied}，它在任务页 page:${out.pageId} 上开跑了（不用等它做完，做完会通知你）。把这段原样写进回复：${out.mention}`)
    },
  },
  {
    name: 'wait_task',
    define: () => ({
      name: 'wait_task',
      description:
        '等一个用 dispatch_task 派出去的任务做完，把它的结果带回来（同步，最多等 minutes 分钟）。' +
        '只在接下来的事必须用到这个结果时才用（比如要把它的产出交给下一个任务）；否则派完就回复用户，它做完会自动通知你。' +
        '等到了结果就不会再收到这个任务的通知；等超时或者任务在等用户批准时会提前返回，之后它做完照常通知你。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: '任务页，写成 page:<页面id>（dispatch_task 返回的那个）' },
          minutes: { type: 'number', description: '最多等几分钟，默认 10，最多 30' },
        },
        required: ['page'],
      },
    }),
    run: async (args) => {
      const body = { page: String(args.page ?? ''), ...(typeof args.minutes === 'number' ? { minutes: args.minutes } : {}) }
      const r = await call('/api/ramet/wait-task', { method: 'POST', body })
      if (!r.ok || !r.json) return failure('等不了这个任务', r)
      const out = r.json
      if (out.error) return reply(`等不了这个任务：${out.error}`, true)
      const page = `page:${out.pageId}`
      if (out.status === 'running') return reply(`任务「${out.title}」（${page}）还在跑。不用再等，它做完会自动通知你。`)
      if (out.status === 'approval') return reply(`任务「${out.title}」（${page}）在等用户批准，请提醒用户去任务页处理；它做完会自动通知你。`)
      if (out.status === 'idle') return reply(`任务「${out.title}」（${page}）还没有开始回复。`)
      const verb = out.status === 'done' ? '已完成' : out.status === 'failed' ? '失败' : '已被用户停止'
      const meta = [out.title, verb, out.label, ...(out.ms ? [`${Math.max(1, Math.round(out.ms / 1000))}s`] : [])]
      const lines = [`[${meta.join(' · ')}] ${page}`]
      if (out.reason) lines.push(`原因：${out.reason}`)
      lines.push(out.text || '（它没有给出文字回答）')
      if (out.truncated) lines.push(`（后面还有，完整内容用 read_page 读 ${page}）`)
      return reply(lines.join('\n'))
    },
  },
]
