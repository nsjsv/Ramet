// ---------- Genet 的「不用处理」：mark_handled ----------
// 只给 Genet（中心按凭证决定，见 /api/ramet/tools）。看了一条自动化通知、判断不需要做任何事时调：这一轮的回复连同那条通知
// 在对话里折成一行灰字（理由就是那一行），点开能看原文；不亮收件箱。写进的是 Genet 页上正在写的这块回复（routes/mark-handled.ts）。
import { broken, call, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'mark_handled',
    define: () => ({
      name: 'mark_handled',
      description:
        '收到「[Ramet 自动化…」开头的通知、判断这件事不需要做任何事时调：写一句为什么不用处理。' +
        '这一轮的回复和那条通知会在对话里折成一行，用户点开才看原文。需要动手、或者要用户拍板的事不要调它。调完再用一句话回复。',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '一句话，200 字以内，如「只是确认收到，不用处理」' } },
        required: ['reason'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/mark-handled', { method: 'POST', body: { reason: String(args.reason ?? '') } })
      if (broken(r)) return failure('没能标记', r)
      return reply('已标记为不用处理。')
    },
  },
]
