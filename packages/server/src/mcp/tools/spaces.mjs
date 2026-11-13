// ---------- 跨空间：read_space（只给 Genet） ----------
// Genet 跨用户所在的所有空间服务他一个人：用户此刻所在空间的约定（公共记忆 + skill 清单）中心会自动带上，
// 别的空间只在空间清单里；要去那里干活、记那里的约定之前，用这个工具取一次。不是成员的空间读不到。
import { call, failure, reply } from '../lib.mjs'

export const tools = [
  {
    name: 'read_space',
    define: () => ({
      name: 'read_space',
      description:
        '读用户所在的某个空间的约定：它的公共记忆（成员确认记下、在那个空间里干活要遵循的）和 skill 清单。' +
        '用户此刻所在空间的约定 Ramet 会自动带给你，不用读；要去别的空间干活（改那里的页、派那里的活、用那里的 skill、记那里的约定）之前先读一次。' +
        'space 填空间清单里的 space:<id> 的 id。',
      inputSchema: {
        type: 'object',
        properties: { space: { type: 'string', description: '空间 id（空间清单里 space: 后面那段）' } },
        required: ['space'],
      },
    }),
    run: async (args) => {
      const space = String(args.space ?? '').replace(/^space:/, '').trim()
      if (!space) return reply('请给出空间 id。', true)
      const r = await call(`/api/ramet/spaces/${encodeURIComponent(space)}/context`)
      if (r.status === 404) return reply('读不到这个空间：没有这个空间，或用户不是它的成员。', true)
      if (!r.ok || typeof r.json?.text !== 'string') return failure('读空间失败', r)
      return reply(r.json.text)
    },
  },
]
