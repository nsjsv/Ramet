// ---------- AI 互调：run_agent ----------
// 只有能叫人的会话才有这个工具（中心按凭证决定，见 /api/ramet/tools）：被叫的会话不能再叫，只嵌一层。
// 叫人本身不用批；被叫 agent 里的危险操作照常弹审批（在调用方所在的页面）。
// 被叫的 agent 只拿到 task 和 task 里的 page: 引用（自己用 read_page 读）；它的步骤与回答留痕在调用方的过程页里。
import { call, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'run_agent',
    define: (caps) => ({
      name: 'run_agent',
      description:
        '把一个子任务交给另一个 AI agent 做，等它做完把结果带回来（同步，可能要几分钟）。' +
        '被叫的 agent 看不到当前对话，只拿到你写的 task：要它读的页面 / 块用 page:<页面id> / page:<页面id>#<块id> 写进 task（它自己用 read_page 读）；' +
        '它里面的危险操作照常弹审批；它不能再叫别的 agent。可叫的 agent：' +
        caps.agents.map((a) => `${a.id}（${a.label}）`).join('、') +
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
]
