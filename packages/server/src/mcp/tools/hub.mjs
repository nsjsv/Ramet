// ---------- 知识中枢：搜索 / 新建 / 移动 / 改名 / 移入回收站 ----------
// 以发起这一轮的用户的身份与权限执行（凭证绑着发起人）：搜索只返回他看得见的页面，新建 / 移动 / 改名要他有写权。
// 新建、移动、改名不用批；移入回收站要用户批准（审批弹在当前页的审批条里，没有超时，拒绝则不执行）。
import { call, failure, reply } from '../lib.mjs'

const pageRef = (id, title) => `page:${id}「${title || '无标题'}」`

export const tools = [
  {
    name: 'search_pages',
    define: () => ({
      name: 'search_pages',
      description: '在用户能看到的页面里按标题与正文搜索（模糊匹配，过程页不参与）。返回页面 id、标题和命中的片段，拿 id 再用 read_page 读全文。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜的词' },
          limit: { type: 'number', description: '最多返回几条（缺省 10，上限 30）' },
        },
        required: ['query'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/search', { method: 'POST', body: { query: String(args.query ?? ''), limit: args.limit } })
      if (!r.ok) return failure('搜索失败', r)
      const hits = r.json.results
      if (hits.length === 0) return reply('没有找到匹配的页面。')
      return reply(hits.map((h) => `${pageRef(h.id, h.title)}${h.snippet ? `  ${h.snippet.replace(/\s+/g, ' ')}` : ''}`).join('\n'))
    },
  },
  {
    name: 'create_page',
    define: () => ({
      name: 'create_page',
      description:
        '新建一个页面。默认放在当前页下（当前页 = 这一轮对话所在的页面）；给 parentId 则放在那个页面下，同一个空间。' +
        'text 是页面正文（markdown；单独一行 image:<uuid> 落图片，page:<uuid> 落页面提及）。返回新页面的 id。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '页面标题' },
          text: { type: 'string', description: '正文（markdown），缺省为空页面' },
          parentId: { type: 'string', description: '放在哪个页面下（页面 id）；缺省 = 当前页下' },
        },
        required: ['title'],
      },
    }),
    run: async (args) => {
      const r = await call('/api/ramet/pages', {
        method: 'POST',
        body: { title: String(args.title ?? ''), text: typeof args.text === 'string' ? args.text : undefined, parentId: args.parentId },
      })
      if (!r.ok) return failure('新建页面失败', r)
      return reply(`已新建 ${pageRef(r.json.id, r.json.title)}${r.json.parentId ? `，在 page:${r.json.parentId} 下` : '，在空间顶层'}。`)
    },
  },
  {
    name: 'move_page',
    define: () => ({
      name: 'move_page',
      description: '把一个页面（连同它的子页面）移到另一个页面之下；不给 parentId 或给 null = 移到空间顶层。只能在同一个空间内移动，不能移到自己的子孙之下。',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: '要移动的页面 id' },
          parentId: { type: ['string', 'null'], description: '新的父页面 id；null / 缺省 = 空间顶层' },
        },
        required: ['pageId'],
      },
    }),
    run: async (args) => {
      const id = String(args.pageId ?? '')
      const r = await call(`/api/ramet/pages/${encodeURIComponent(id)}/move`, { method: 'POST', body: { parentId: args.parentId ?? null } })
      if (!r.ok) return failure('移动页面失败', r)
      return reply(`已把 ${pageRef(id, r.json.title)} 移到${r.json.parentId ? ` page:${r.json.parentId} 之下` : '空间顶层'}。`)
    },
  },
  {
    name: 'rename_page',
    define: () => ({
      name: 'rename_page',
      description: '给页面改标题。',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: '页面 id' },
          title: { type: 'string', description: '新标题' },
        },
        required: ['pageId', 'title'],
      },
    }),
    run: async (args) => {
      const id = String(args.pageId ?? '')
      const r = await call(`/api/ramet/pages/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { title: String(args.title ?? '') } })
      if (!r.ok) return failure('改名失败', r)
      return reply(`已改名：${pageRef(id, r.json.title)}。`)
    },
  },
  {
    name: 'trash_page',
    define: () => ({
      name: 'trash_page',
      description:
        '把页面（连同它的子页面）移入回收站，可以在回收站恢复。**这是危险操作：会在当前页弹出审批，等用户批准后才执行（没有超时）；用户拒绝则页面不动。** 不要为了整理而随意删除。',
      inputSchema: {
        type: 'object',
        properties: { pageId: { type: 'string', description: '要移入回收站的页面 id' } },
        required: ['pageId'],
      },
    }),
    run: async (args) => {
      const id = String(args.pageId ?? '')
      const r = await call(`/api/ramet/pages/${encodeURIComponent(id)}/trash`, { method: 'POST', body: {} })
      if (r.json?.rejected) return reply('用户拒绝了这次删除，页面没有变化。')
      if (!r.ok || !r.json?.ok) return failure('移入回收站失败', r)
      return reply(`已把 page:${id} 移入回收站（含 ${r.json.trashed} 个页面，可在回收站恢复）。`)
    },
  },
]
