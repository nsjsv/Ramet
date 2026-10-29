// ---------- 空间公共记忆：propose_memory（只提议，用户点「记住」才写入）----------
// 记忆是这个空间里所有 agent 共享、每轮开跑时全部带上的上下文。agent 不能直接写：这里把一条建议交给中心，
// 中心在当前页弹出「记住这条？」让成员确认（没有超时），点「记住」才落库；点「不用」或这一轮被停止就不写。
import { call, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'propose_memory',
    define: () => ({
      name: 'propose_memory',
      description:
        '向用户提议记住一条跨对话长期有效的信息（团队约定、项目事实、用户偏好、踩过的坑），用户点「记住」后才会写进这个空间的公共记忆，之后所有 agent 的每一轮都能看到。' +
        '**这是提议，不是写入：会在当前页弹出确认，等用户决定（没有超时）；用户点「不用」则不记。** ' +
        '只提议值得长期保留、且不会很快过时的内容；一条只讲一件事，写成完整的一两句话（单条不超过 2000 字）；不要记临时的任务进度、可以从代码里直接读到的东西，也不要记密钥和密码。' +
        '同一件事不要反复提议。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的内容：一条完整、独立能读懂的话' } },
        required: ['text'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/memories/propose', { method: 'POST', body: { text: String(args.text ?? '') } })
      if (r.json?.declined) return reply('用户没有同意记下这条（或这一轮被停止了），没有写入。不要再次提议同一条。')
      if (r.json?.error) return reply(`没有记下：${r.json.error}`, true)
      if (!r.ok || !r.json?.ok) return failure('提议记忆失败', r)
      return reply('用户同意了，已记入这个空间的公共记忆，之后每一轮都会带上。')
    },
  },
]
