// ---------- Genet 以用户的名义回复评论：reply_comment ----------
// 只给 Genet（中心按凭证决定，见 /api/ramet/tools）。每次都先在对话里弹审批卡，把要发的原文给用户看，用户点「发送」才以他的名义发出去，
// 评论上标「Genet 代发」（routes/comment-reply.ts）。用户没同意就没发。例外：用户在这个串里 @Genet 叫过它，回这一次直接发出。
import { broken, call, declined, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'reply_comment',
    define: () => ({
      name: 'reply_comment',
      description:
        '以用户的名义回复一个评论串：别人在评论里找用户、要回复时用；用户在评论里 @你（评论呼叫）时也用它把结果回在串里。thread 填通知里「评论串」那一行的 id，body 是要发的回复原文（就是最后发出去的样子）。' +
        '会先弹卡把原文给用户看，用户点「发送」才发出去，评论上会标「Genet 代发」；没同意就是没发，如实告诉用户。回应评论呼叫的那一次不弹卡、直接发出。拿不准怎么回时先在对话里起草、问用户，不要硬发。',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '评论串 id（通知里「评论串」那一行）' },
          body: { type: 'string', description: '回复原文，4000 字以内' },
        },
        required: ['thread', 'body'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/comments/reply', { method: 'POST', body: { thread: String(args.thread ?? ''), body: String(args.body ?? '') } })
      const no = declined(r)
      if (no) return no
      if (broken(r)) return failure('没能回复评论', r)
      return reply('已经以用户的名义回复了（评论上标着「Genet 代发」）。')
    },
  },
]
