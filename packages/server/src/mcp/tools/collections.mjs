// ---------- 合集：read_collection / set_props（在合集里建行是 hub.mjs 的 create_page 带 props） ----------
// 读走「能看见」、写走「能改」，权限判定与值的换算校验全在中心端点（routes/collection-tools.ts），这里只带凭证、把返回的结构排成文字。
import { broken, call, declined, failure, reply } from '../lib.mjs'

/** 正文里的记号可以原样当参数：`collection:<id>`（合集块）或 `page:<id>`（合集页本身），带 #块id 的只取页面部分 */
function collectionIdOf(raw) {
  const m = /^(?:collection:|page:)?([^#\s]+)/.exec(String(raw ?? '').trim())
  return m ? m[1] : ''
}

const quote = (title) => `「${title || '无标题'}」`

function propLine(p) {
  const detail = [p.type, ...(p.options?.length ? [p.options.join(' / ')] : []), ...(p.note ? [p.note] : [])]
  return `${p.name}（${detail.join('，')}）`
}

function render(body) {
  const out = [`# 合集${quote(body.title)} collection:${body.id}`]
  out.push(body.props.length ? `属性：名称（行的标题）；${body.props.map(propLine).join('；')}` : '属性：只有名称（行的标题）')
  if (body.views.length) out.push(`视图：${body.views.map((v) => `${quote(v.name)}（${v.layout}，id ${v.id}）`).join('、')}`)
  out.push(body.view ? `按视图${quote(body.view.name)}的筛选和排序读，命中 ${body.total} 行` : `全部 ${body.total} 行（不筛选，按手动顺序）`)
  if (body.rows.length === 0) {
    out.push(body.total === 0 ? '（没有行）' : '（这一段没有行了）')
  } else {
    for (const row of body.rows) {
      const values = row.values.map(([name, text]) => `${name}：${text}`).join('；')
      out.push(`- page:${row.id}${quote(row.title)}${values ? ` — ${values}` : ''}`)
    }
  }
  if (body.next) out.push(`还有更多行：cursor 填 ${JSON.stringify(body.next)} 接着读。`)
  return out.join('\n')
}

export const tools = [
  {
    name: 'read_collection',
    define: () => ({
      name: 'read_collection',
      description:
        '读取一个 Ramet 合集（像数据库的一张表）：返回属性（列）、视图和行，每一行带它的属性值。' +
        '正文里的 集合「名」 collection:<id> 就是合集；read_page 读到合集页时也会提示用这个工具。' +
        '缺省读全部行、按手动顺序；给 view 则按那个视图的筛选和排序读。每一行本身也是页面，返回的 page:<行id> 可以用 read_page 读它的正文。' +
        '改行的属性用 set_props；在合集里新建一行用 create_page（parentId 填合集 id，props 填属性值）。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionId: { type: 'string', description: '合集 id，或正文里的 collection:<id> / page:<id> 记号' },
          view: { type: 'string', description: '按哪个视图读（视图名或 id）；缺省读全部行' },
          cursor: { type: 'string', description: '上一次返回的续读游标，接着往下读' },
          limit: { type: 'number', description: '最多返回多少行（缺省 50，上限 100）' },
        },
        required: ['collectionId'],
      },
    }),
    run: async (args) => {
      const id = collectionIdOf(args.collectionId)
      if (!id) return reply('要给出合集 id（collection:<id>）。', true)
      const q = new URLSearchParams()
      if (typeof args.view === 'string' && args.view.trim()) q.set('view', args.view.trim())
      if (typeof args.cursor === 'string' && args.cursor) q.set('cursor', args.cursor)
      if (typeof args.limit === 'number') q.set('limit', String(args.limit))
      const r = await call(`/api/ramet/collections/${encodeURIComponent(id)}?${q}`)
      // 404：不存在 / 不是合集 / 不在你的空间 / 已进回收站（中心刻意不区分）
      if (r.status === 404) return reply(`没有找到合集 ${id}。`)
      if (!r.ok || !r.json) return failure('读取合集失败', r)
      return reply(render(r.json))
    },
  },
  {
    name: 'set_props',
    define: () => ({
      name: 'set_props',
      description:
        '改合集里一行或几行的属性值（同一个合集，一次最多 100 行），也可以给一行改标题（名称）。' +
        'props 的键是属性名，值照 read_collection 显示的写法填：单选 / 状态填选项名，多选、人员、关联填名字的列表' +
        '（人员填成员的用户名，关联填对方行的 page:<行id> 或标题），日期填 YYYY-MM-DD（区间写成「开始 → 结束」），' +
        '数字填数字，复选框填 true / false；填 null 或空字符串清空。公式、汇总、创建时间这类算出来的属性改不了。' +
        '有一个值不对就一行都不改，并说明原因。',
      inputSchema: {
        type: 'object',
        properties: {
          rowIds: { type: 'array', items: { type: 'string' }, description: '要改的行：行 id 或 page:<行id>' },
          props: { type: 'object', description: '属性名 → 新的值', additionalProperties: true },
          title: { type: 'string', description: '新标题（名称）；只能在改一行时给' },
        },
        required: ['rowIds'],
      },
    }),
    run: async (args) => {
      const rowIds = Array.isArray(args.rowIds) ? args.rowIds : typeof args.rowIds === 'string' ? [args.rowIds] : []
      const body = { rowIds, ...(args.props !== undefined ? { props: args.props } : {}), ...(typeof args.title === 'string' ? { title: args.title } : {}) }
      const r = await call('/api/ramet/rows/set', { method: 'POST', body })
      if (declined(r)) return declined(r)
      if (broken(r)) return failure('没有改成', r)
      return reply(`已改合集「${r.json.collection.title || '无标题'}」里的 ${r.json.count} 行。`)
    },
  },
]
