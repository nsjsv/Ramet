// ---------- 记忆：propose_memory（只提议，用户点「记住」才写入）----------
// 空间公共记忆是这个空间里所有 agent 共享、每轮开跑时全部带上的上下文；个人记忆只有用户本人看得到、只给 Genet。
// agent 不能直接写：这里把一条建议交给中心，中心在当前页弹出「记住这条？」让用户确认（没有超时），点「记住」才落库；点「不用」或这一轮被停止就不写。
// 记到哪由中心按页面定（Genet 页 / 任务页 = 个人记忆，别的页 = 页面所在空间）；Genet 能用 space 指定一个空间（工具清单里有 read_space 的就是它）。
import { call, failure, reply } from '../lib.mjs'

/** 这把凭证是 Genet 的：它的工具清单里才有 read_space（中心按凭证决定） */
const genet = (caps) => Array.isArray(caps?.tools) && caps.tools.includes('read_space')

export const tools = [
  {
    name: 'propose_memory',
    define: (caps) => ({
      name: 'propose_memory',
      description:
        (genet(caps)
          ? '向用户提议记住一条跨对话长期有效的信息。不填 space = 写进用户的个人记忆（他自己的偏好、习惯，只有他看得到，只给你）；' +
            '填 space = 写进那个空间的公共记忆（团队约定、项目事实，那个空间里所有 agent 都会看到；只读成员的空间记不了）。用户点「记住」后才写入。'
          : '向用户提议记住一条跨对话长期有效的信息（团队约定、项目事实、用户偏好、踩过的坑），用户点「记住」后才会写进这个空间的公共记忆，之后所有 agent 的每一轮都能看到。') +
        '**这是提议，不是写入：会在当前页弹出确认，等用户决定（没有超时）；用户点「不用」则不记。** ' +
        '只提议值得长期保留、且不会很快过时的内容；一条只讲一件事，写成完整的一两句话（单条不超过 2000 字）；不要记临时的任务进度、可以从代码里直接读到的东西，也不要记密钥和密码。' +
        '同一件事不要反复提议。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容：一条完整、独立能读懂的话' },
          ...(genet(caps) ? { space: { type: 'string', description: '记进哪个空间的公共记忆（空间 id）；记用户个人的偏好就不填' } } : {}),
        },
        required: ['text'],
      },
    }),
    run: async (args) => {
      const space = typeof args.space === 'string' ? args.space.replace(/^space:/, '').trim() : ''
      const r = await call('/api/ramet/memories/propose', { method: 'POST', body: { text: String(args.text ?? ''), ...(space ? { space } : {}) } })
      if (r.json?.declined) return reply('用户没有同意记下这条（或这一轮被停止了），没有写入。不要再次提议同一条。')
      if (r.json?.error) return reply(`没有记下：${r.json.error}`, true)
      if (!r.ok || !r.json?.ok) return failure('提议记忆失败', r)
      return reply(`用户同意了，已记入${r.json.savedTo ?? '这个空间的公共记忆'}。`)
    },
  },
]
