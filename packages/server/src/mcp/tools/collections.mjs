// ---------- 合集：read_collection / set_props / create_collection / edit_collection（在合集里建行是 hub.mjs 的 create_page 带 props） ----------
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
  const extra = [
    ...(body.where?.length ? [`条件：${body.where.join('；')}`] : []),
    ...(body.sort?.length ? [`排序：${body.sort.join('，')}`] : []),
    ...(body.query ? [`关键词「${body.query}」`] : []),
  ]
  const scope = body.view ? `按视图${quote(body.view.name)}的筛选和排序读` : extra.length ? '' : '不筛选，按手动顺序'
  const how = [scope, ...extra].filter(Boolean).join('，')
  out.push(body.view || extra.length ? `${how}，命中 ${body.total} 行` : `全部 ${body.total} 行（${how}）`)
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

/** create_collection / edit_collection 共用的 ops 说明（与 collections/ai-schema.ts 的演练同口径） */
const OPS_HELP =
  'ops 是按顺序执行的步骤（后面的步骤能用前面刚加的属性），有一步不行就整批不改：' +
  '{ op: "add_prop", name, type, options?, formula?, prefix?, prompt?, target?, two_way?, reverse_name?, single?, relation?, of?, fn? } 加属性，' +
  'type 用 text 文本 / number 数字 / select 单选 / multi_select 多选 / status 状态 / date 日期 / checkbox 复选框 / url / email / phone / person 人员 / ' +
  'files 文件 / created_time / edited_time / created_by / edited_by / unique_id 自动编号（prefix 前缀）/ formula 公式（formula 写 [单价] * [数量]）/ ' +
  'ai AI 属性（prompt 写要 AI 按每行填什么）/ relation 关联（target 填对方合集 collection:<id>，可以是这个合集自己；two_way 时对方多一个反向关联，reverse_name 是它的名字；single 只能关联一行）/ ' +
  'rollup 汇总（relation 填本合集的关联属性名，of 填对方合集的属性名，fn 如 count、sum、average、min、max、earliest、latest、show_original）；' +
  '单选 / 多选 / 状态的 options 是选项名列表（状态的选项可写 { name, group: 未开始 | 进行中 | 已完成 }）。' +
  '{ op: "rename_prop", prop, name }，{ op: "delete_prop", prop }（只摘定义，值还在，可以从版本历史恢复），{ op: "add_options", prop, options }，' +
  '{ op: "add_view", name, layout: table | board | list | gallery | calendar | timeline, group_by?, date_by?, where?, sort? }（看板按单选 / 状态分列，日历 / 时间线按日期属性排；where / sort 写法同 read_collection），' +
  '{ op: "rename", title } 改合集名。'

const opsSchema = { type: 'array', description: '按顺序执行的步骤，见工具说明', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'], additionalProperties: true } }

const changesText = (changes) => (changes?.length ? `\n${changes.map((c) => `- ${c}`).join('\n')}` : '')

export const tools = [
  {
    name: 'read_collection',
    define: () => ({
      name: 'read_collection',
      description:
        '读取一个 Ramet 合集（像数据库的一张表）：返回属性（列）、视图和行，每一行带它的属性值。' +
        '正文里的 集合「名」 collection:<id> 就是合集；read_page 读到合集页时也会提示用这个工具。' +
        '缺省读全部行、按手动顺序；给 view 则按那个视图的筛选和排序读。也可以临时筛选：where 是条件列表，每条 { prop: 属性名, op, value }，' +
        'op 用 = != > < >= <= 包含 不包含 为空 不为空（或 read_collection 报错里列出的运算），value 照显示的写法填（选项名、用户名、YYYY-MM-DD）；' +
        'sort 是 [{ prop, dir: asc | desc }]；query 是关键词（在名称和属性值里找）。合集大时用条件筛，不要一页页翻。' +
        '每一行本身也是页面，返回的 page:<行id> 可以用 read_page 读它的正文。' +
        '改行的属性用 set_props；在合集里新建一行用 create_page（parentId 填合集 id，props 填属性值）。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionId: { type: 'string', description: '合集 id，或正文里的 collection:<id> / page:<id> 记号' },
          view: { type: 'string', description: '按哪个视图读（视图名或 id）；缺省读全部行' },
          where: {
            type: 'array',
            description: '临时条件（同时满足），叠加在视图的筛选上',
            items: { type: 'object', properties: { prop: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['prop'] },
          },
          sort: { type: 'array', description: '临时排序，换掉视图的排序', items: { type: 'object', properties: { prop: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['prop'] } },
          query: { type: 'string', description: '关键词：在名称和属性值里找（不分大小写）' },
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
      if (Array.isArray(args.where) && args.where.length) q.set('where', JSON.stringify(args.where))
      if (Array.isArray(args.sort) && args.sort.length) q.set('sort', JSON.stringify(args.sort))
      if (typeof args.query === 'string' && args.query.trim()) q.set('query', args.query.trim())
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
  {
    name: 'create_collection',
    define: () => ({
      name: 'create_collection',
      description:
        '新建一个合集（像数据库的一张表），默认放在当前页下；给 parentId 则放在那个页面下（只能是普通页面，同一个空间）。' +
        '新合集自带一个「状态」属性和一个表格视图；ops 里加了同名的「状态」就换成你定义的。' +
        OPS_HELP +
        '返回新合集的 collection:<id>，之后用 create_page（parentId 填它）往里加行。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '合集的名字' },
          parentId: { type: 'string', description: '放在哪个页面下；缺省 = 当前页下' },
          ops: opsSchema,
        },
        required: ['title'],
      },
    }),
    run: async (args) => {
      const body = { title: String(args.title ?? ''), ...(args.parentId ? { parentId: args.parentId } : {}), ...(args.ops !== undefined ? { ops: args.ops } : {}) }
      const r = await call('/api/ramet/collections', { method: 'POST', body })
      if (declined(r)) return declined(r)
      if (broken(r)) return failure('没有建成', r)
      return reply(`已新建合集「${r.json.title}」 collection:${r.json.id}${r.json.parentId ? `，在 page:${r.json.parentId} 下` : '，在空间顶层'}。${changesText(r.json.changes)}`)
    },
  },
  {
    name: 'edit_collection',
    define: () => ({
      name: 'edit_collection',
      description: '改一个合集的结构：属性、选项、视图、合集名（改行的值用 set_props）。' + OPS_HELP,
      inputSchema: {
        type: 'object',
        properties: {
          collectionId: { type: 'string', description: '合集 id，或 collection:<id> / page:<id> 记号' },
          ops: opsSchema,
        },
        required: ['collectionId', 'ops'],
      },
    }),
    run: async (args) => {
      const id = collectionIdOf(args.collectionId)
      if (!id) return reply('要给出合集 id（collection:<id>）。', true)
      const r = await call(`/api/ramet/collections/${encodeURIComponent(id)}/schema`, { method: 'POST', body: { ops: args.ops } })
      if (declined(r)) return declined(r)
      if (r.status === 404) return reply(`没有找到合集 ${id}。`)
      if (broken(r)) return failure('没有改成', r)
      return reply(`已改合集 collection:${id}：${changesText(r.json.changes)}`)
    },
  },
]
