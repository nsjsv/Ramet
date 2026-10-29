// ---------- 带队（/带队）：组长的两个工具 ----------
// 只有带队那一轮的组长凭证才有（中心按凭证里的 team 上下文决定列不列，见 /api/ramet/tools）：
//   submit_plan  计划轮：把拆好的任务提交成一份草稿计划，用户在计划卡上确认后才开工；
//   send_back    执行轮：交叉审查之后把某个任务打回给组员重做（同步等新结果，每个任务最多 2 次）。
// 权限与约束全在中心端点，这里只带凭证、转述结果。
import { call, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'submit_plan',
    define: (caps) => ({
      name: 'submit_plan',
      description:
        '（带队·计划轮）把总目标拆成任务，提交一份计划给用户审阅；用户确认后才会开工。这一轮不要自己动手做任务。' +
        '可用的组员：' +
        (caps.team?.candidates ?? []).map((a) => `${a.id}（${a.label}）`).join('、') +
        '。同一轮再次调用会覆盖上一份（用户确认之前）。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划标题（≤100 字）' },
          tasks: {
            type: 'array',
            description: '任务，1–8 个；没有依赖的任务会并行开工',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '任务 id：字母、数字、- 或 _，最长 32 个字符，计划内唯一' },
                title: { type: 'string', description: '任务标题（≤100 字）' },
                detail: { type: 'string', description: '任务说明：让组员不看对话也能开工（目标、范围、要读的 page: 引用、验收标准）' },
                assignee: { type: 'string', description: '负责的组员 id（从可用组员里选）' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: '必须先做完的任务 id' },
              },
              required: ['id', 'title', 'assignee'],
            },
          },
        },
        required: ['title', 'tasks'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/team/plan', { method: 'POST', body: { title: args.title, tasks: args.tasks } })
      if (r.json?.error) return reply(`计划没有提交：${r.json.error}`, true)
      if (!r.ok || !r.json?.planId) return failure('提交计划失败', r)
      return reply('计划已提交，等用户在计划卡上确认（可以改标题、换负责人、指定工作目录）。用一两句话说明你的拆法就结束这一轮，不要开始做任务。')
    },
  },
  {
    name: 'send_back',
    define: (caps) => ({
      name: 'send_back',
      description:
        '（带队·交叉审查）把某个任务打回给它的组员重做，同步等它重新交付（可能要几分钟），返回新结果。' +
        '只能打回已经交付或出错的任务；每个任务最多打回 2 次。feedback 要具体：哪里不对、要怎么改。' +
        '当前任务：' +
        (caps.team?.tasks ?? []).map((t) => `${t.id}（${t.title}）`).join('、') +
        '。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要打回的任务 id' },
          feedback: { type: 'string', description: '给组员的修改意见' },
        },
        required: ['taskId', 'feedback'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/team/send-back', { method: 'POST', body: { taskId: String(args.taskId ?? ''), feedback: String(args.feedback ?? '') } })
      if (!r.ok || !r.json) return failure('打回失败', r)
      const out = r.json
      if (out.error) return reply(`没有打回：${out.error}`, true)
      const meta = [out.label || out.agent, out.outcome === 'end' ? '重新交付' : out.outcome === 'cancelled' ? '已停止' : '出错', `${out.steps} 步`, `${Math.max(1, Math.round(out.ms / 1000))}s`]
      return reply(`[${meta.join(' · ')}]\n${out.output || '（它没有给出文字回答）'}${out.error ? `\n出错原因：${out.error}` : ''}`)
    },
  },
]
