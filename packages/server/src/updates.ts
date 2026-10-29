import * as Y from 'yjs'
import { LIST_MAX, parseCollection, type CollectionProp, type CollectionSchema, type CollectionView } from '@ramet/shared/collection-model'

// LCS 用 O(n²) DP，块列表先截到 MAX_BLOCKS：服务端每次只对窗口（≤200 条）的相邻对现算摘要，
// 单次请求的 diff 次数有上界，O(n²) 够用。出现数万块的页面再换 Myers。blockTexts 的截断同理是 diff 耗时的兜底。
export const MAX_BLOCKS = 2000
// 摘要单条文字预览上限，超出截断
export const SUMMARY_TEXT_MAX = 80
// 每条更新默认展示的摘要项数上限（前端可展开其余项，total 用截断前项数）
export const SUMMARY_ITEM_LIMIT = 20

export type SummaryKind = 'edit' | 'add' | 'del' | 'title' | 'create'
/** 正文块 / 标题 / 创建的摘要项（diffBlocks 只产这一种） */
export type BlockSummaryItem = { kind: SummaryKind; text: string }
/** 集合页的属性定义 / 视图变化 */
export type SchemaOp = 'prop_add' | 'prop_del' | 'prop_edit' | 'view_add' | 'view_del' | 'view_edit'
/** 一条摘要项。prop 是集合的行改了一个属性值：只给原始值（null 为空），名字与值的文字由前端按当前属性定义解读
 *  （经 readValue，同表格口径）；schema 是集合页的属性定义 / 视图变化，text 是名字（删除取旧名，其余取新名） */
export type SummaryItem =
  | BlockSummaryItem
  | { kind: 'prop'; prop: string; from: unknown; to: unknown }
  | { kind: 'schema'; op: SchemaOp; text: string }

// 首条快照（链锚点，无前驱）的摘要：只有「创建了」，不带文字
export const CREATE_SUMMARY: SummaryItem[] = [{ kind: 'create', text: '' }]

// 摘要文字预览统一在这里截断
function clip(text: string): string {
  return text.length > SUMMARY_TEXT_MAX ? text.slice(0, SUMMARY_TEXT_MAX) : text
}

// 块级子元素：递归拼文本时它们之间以 '\n' 连接（列表多条目 / 引用多段各占一行）；
// 行内结构（strong / em / link 等 XmlElement 与 XmlText）直接拼接。
// 这是唯一的文本抽取口径（摘要 diff / 块提及快照 / 搜索索引 / agent 上下文共用），只取读得见的文字，不 dump 节点属性：
// Y.XmlFragment.toString() 会把 id / pageId / title / icon 等属性序列化成 markup，摘要与 snippet 里就会冒出「<page_ref icon=...>」这类噪声。
// 原子节点（无子文本）的可见文字存在属性里，靠下面这张表显式取，表外的属性一律不是文字
const ATTR_TEXT: Record<string, string[]> = {
  page_ref: ['title'], // 子页面块：DOM 渲染的就是 attrs.title
  attachment: ['name'], // 附件卡片：显示文件名
  block_ref: ['text'], // 块提及 chip：显示插入时刻的文本快照
  callout: ['title'], // 提示框标题（空 = 外观默认名，不进文字）
  embed: ['src'], // 嵌入：地址就是它读得见的「文字」
}

/** 行内换行节点：没有文字但读得见（DOM 是 <br>）。漏掉它会让多行文本在
 *  搜索索引 / 摘要 / agent 上下文里连成一行（agent 回复的 markdown 换行就是这样来的） */
const HARD_BREAK = 'hardbreak'

/** 本站上传图片的 src 转文件 id。src 可带或不带 /display 后缀（视图层渲染 display 版，
 *  attrs.src 恒存原图地址，见 web/src/editor/media.ts 的 imageDisplaySchema）。
 *  外链返回 null，不是中心的文件，不下载、不取字节。 */
const IMAGE_URL_RE = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/display)?$/i

function imageFileId(src: unknown): string | null {
  const m = typeof src === 'string' ? IMAGE_URL_RE.exec(src) : null
  return m ? m[1]! : null
}

const BLOCK_TAGS = new Set([
  'paragraph',
  'heading',
  'code_block',
  'blockquote',
  'user_message', // 子块靠块级换行分隔，搜索 / 摘要 / 提及快照口径同其它容器块
  'agent_reply', // 同上
  'entry', // 过程页时间线的一行：行与行之间要换行，别粘成一串
  'bullet_list',
  'ordered_list',
  'list_item',
  // 表格的行 / 单元格都是容器块（单元格里还包着一个 paragraph），逐格换行才不让相邻格粘成一串
  'table',
  'table_header_row',
  'table_row',
  'table_header',
  'table_cell',
  // 集合块 / 链接视图块各占一行（read_page 按行读，两个集合块相邻时引用不能粘成一行）
  'collection_inline',
  'collection_link',
])

/** 原子节点的另一种文字（提示词口径用，见 agents/refs.ts）：返回字符串则代替默认文字（不再下钻子节点），
 *  undefined 走默认。搜索索引 / 摘要 / 提及快照 / read_page 行文本 / edit_page 匹配宽度都只用默认口径，
 *  提示词怎么写引用影响不到它们。 */
export type AtomText = (el: Y.XmlElement) => string | undefined

/** Y.XmlText 转纯文字。不能用 toString()：带格式的文本会被渲染成 `<strong marker="*">…</strong>` 这类 markup，
 *  agent 回复的 markdown 落成格式后这种噪声会进搜索索引与 agent 上下文。
 *  delta 里的 insert 才是文字本身，非字符串 insert 是内嵌节点，递归取它的文字。 */
function xmlTextOfText(node: Y.XmlText, atoms?: AtomText): string {
  let out = ''
  for (const op of node.toDelta() as Array<{ insert?: unknown }>) {
    const insert = op.insert
    if (typeof insert === 'string') out += insert
    else if (insert instanceof Y.XmlElement) out += textOf(insert, atoms)
  }
  return out
}

export function textOf(node: Y.XmlFragment | Y.XmlElement | Y.XmlText, atoms?: AtomText): string {
  if (node instanceof Y.XmlText) return xmlTextOfText(node, atoms)
  let own = ''
  if (node instanceof Y.XmlElement) {
    const custom = atoms?.(node)
    if (custom !== undefined) return custom
    for (const key of ATTR_TEXT[node.nodeName] ?? []) {
      const v = node.getAttribute(key)
      if (v) {
        own += v
      }
    }
    // @ 页面引用 chip（editor/page-mention.ts）：喂 AI 的文本要的是页面 id（read_page 的入参），不是画面上的标题。
    // 可见芯片与给 AI 的文本是两回事，所以不看 title，只按 pageId 派生（搜索索引与摘要共用本口径）。
    // @agent 点名 chip：提示词里就是 `@名字`（agentId 是 catalog id，给机器看的，不进文字）
    if (node.nodeName === 'agent_mention') {
      const label = node.getAttribute('label')
      if (label) own += `@${label}`
    }
    // @ 成员 chip（editor/user-mention.ts）：同 agent 点名，文本就是 `@用户名`
    if (node.nodeName === 'user_mention') {
      const name = node.getAttribute('name')
      if (name) own += `@${name}`
    }
    // 行内公式（web/src/editor/math.ts）：给读者 / AI 的是 LaTeX 原文，带 `$` 定界，与 markdown 写法一致
    if (node.nodeName === 'math_inline') {
      const latex = node.getAttribute('latex')
      if (latex) own += `$${latex}$`
    }
    if (node.nodeName === 'page_mention') {
      const id = node.getAttribute('pageId')
      if (id) own += `page:${id}`
    }
    // 集合块 / 链接视图块：读得见的是集合名（attrs.title 是快照，同 page_ref），引用记号同 page_mention 的 page:<id>。
    // 只是一行引用，不带集合里的数据（属性与行不进正文的文字）
    if (node.nodeName === 'collection_inline' || node.nodeName === 'collection_link') {
      const title: unknown = node.getAttribute('title')
      const id: unknown = node.getAttribute('collectionId')
      own += `集合「${typeof title === 'string' ? title : ''}」`
      if (typeof id === 'string' && id) own += ` collection:${id}`
    }
    // 图片：提示 / 索引里只给编号（本站文件是文件 id，AI 要看图自己调 read_image），
    // 绝不把字节或 base64 塞进 content_text。外链原样给 src，不下载。
    // alt 是同一行的补充，换行压成空格（摘要 / 索引都是一行一条）
    if (node.nodeName === 'image') {
      const src = node.getAttribute('src') ?? ''
      const id = imageFileId(src)
      own += id ? `image:${id}` : `image:${src}`
      const alt = node.getAttribute('alt') ?? ''
      if (id && alt) own += ` ${alt.replace(/[\r\n]+/g, ' ')}`
    }
  }
  return own + walkChildren(node, undefined, atoms)
}

/** 子节点转文字：块级子节点之间（以及前一个子节点是块级时）补一个 '\n'，hardbreak 自己
 *  恰好占一个 '\n'，空内容的子节点不留痕。textOf 与 fragmentSpans 共用这一条循环，
 *  整篇文字和按字符区间定位子节点必须是同一套规则，分头实现迟早会漂。
 *  onChild 拿到每个有文字的子节点、它在父节点里的下标（forEach 位置，跳过已删项，
 *  拿它去 delete / 替换父节点的子项才对得上）、以及它在返回字符串里的 [start, end)。 */
function walkChildren(
  node: Y.XmlFragment | Y.XmlElement,
  onChild?: (child: Y.XmlElement | Y.XmlText, index: number, start: number, end: number) => void,
  atoms?: AtomText,
): string {
  let out = ''
  let prevWasBlock = false
  let index = 0
  node.forEach((child) => {
    const at = index++
    if (child instanceof Y.XmlElement && child.nodeName === HARD_BREAK) {
      out += '\n'
      return
    }
    const isBlock = child instanceof Y.XmlElement && BLOCK_TAGS.has(child.nodeName)
    const t = textOf(child as Y.XmlElement | Y.XmlText, atoms)
    if (!t) return
    if (out && (isBlock || prevWasBlock)) out += '\n'
    out += t
    prevWasBlock = isBlock
    onChild?.(child as Y.XmlElement | Y.XmlText, at, out.length - t.length, out.length)
  })
  return out
}

/** 顶层子节点在 `textOf(fragment)` 里的字符区间（`text` 就是那份整篇文字）。
 *  AI 的 read_page 读到的正文就是这份 text（按 '\n' 切行，行号只给人看），edit_page 的 `old` 也在这份字符串里定位，
 *  读与写回匹配的永远是同一份文本。
 *  `spans[i]` 是第 i 个有文字的子节点占的 [start, end)；空块不在其中（它在文本里不占字符）。 */
export type FragmentSpan = { node: Y.XmlElement | Y.XmlText; index: number; start: number; end: number }

export function fragmentSpans(fragment: Y.XmlFragment): { text: string; spans: FragmentSpan[] } {
  const spans: FragmentSpan[] = []
  const text = walkChildren(fragment, (node, index, start, end) => spans.push({ node, index, start, end }))
  return { text, spans }
}

function fragmentTexts(frag: Y.XmlFragment, limit: number): string[] {
  const out: string[] = []
  const n = Math.min(frag.length, limit)
  for (let i = 0; i < n; i++) out.push(textOf(frag.get(i) as Y.XmlElement | Y.XmlText))
  return out
}

// 页面上看得见的块：正文 prosemirror 顶层，一块一条（过程页的步骤也是正文里的块），超 MAX_BLOCKS 截断。
export function blockTexts(doc: Y.Doc): string[] {
  return fragmentTexts(doc.getXmlFragment('prosemirror'), MAX_BLOCKS)
}

// 块级 LCS diff：相等段之外的 del / add 游程按位置就近配对成 'edit'（文字取 cur 侧，
// 语义是编辑成了新内容），落单的为 'del' / 'add'。输出顺序即文档位置顺序。
// 标题变更不在这里管，由 summarizeChange 追加
export function diffBlocks(prev: string[], cur: string[]): BlockSummaryItem[] {
  const n = prev.length
  const m = cur.length
  // dp[i][j] 是 prev[i..] 与 cur[j..] 的 LCS 长度，只用来决定失配时先消耗哪一侧，
  // 保证配对发生在最长公共子序列意义上最合适的位置
  const dp: Uint32Array[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = prev[i] === cur[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const items: BlockSummaryItem[] = []
  const delRun: string[] = []
  const addRun: string[] = []
  // 游程结算：第 k 个删除和第 k 个新增视为同一块被改写成新内容（'edit'），多删少加的尾部是纯删除，反之纯新增。
  // 空块（只有空白）不进摘要也不参与配对：加减空行不是一条读得见的更新，一块的字删光要记成「已删除 原文字」，而不是一条空的「编辑」
  const flush = () => {
    const dels = delRun.filter((t) => t.trim() !== '')
    const adds = addRun.filter((t) => t.trim() !== '')
    const pairs = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairs; k++) items.push({ kind: 'edit', text: clip(adds[k]!) })
    for (let k = pairs; k < dels.length; k++) items.push({ kind: 'del', text: clip(dels[k]!) })
    for (let k = pairs; k < adds.length; k++) items.push({ kind: 'add', text: clip(adds[k]!) })
    delRun.length = 0
    addRun.length = 0
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (prev[i] === cur[j]) {
      flush()
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      delRun.push(prev[i++]!)
    } else {
      addRun.push(cur[j++]!)
    }
  }
  while (i < n) delRun.push(prev[i++]!)
  while (j < m) addRun.push(cur[j++]!)
  flush()
  return items
}

/** 摘要里的属性值：字符串截到 SUMMARY_TEXT_MAX，数组只留前 LIST_MAX 项的标量，
 *  对象（协同连接写进来的脏数据，readValue 读不出）只给一个空对象占位，都是为了让响应有界 */
function clipValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return clip(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .slice(0, LIST_MAX)
      .map((item: unknown) => (typeof item === 'string' ? clip(item) : typeof item === 'number' || typeof item === 'boolean' ? item : null))
  }
  return {}
}

/** 行文档 Y.Map('props') 两版之差：键的并集里 JSON 不同的各出一项（键不存在与 null 同为空）。
 *  按属性 id 排序保证结果确定，前端再按当前属性顺序重排 */
export function propDiff(prev: Record<string, unknown>, cur: Record<string, unknown>): SummaryItem[] {
  const read = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? (record[key] ?? null) : null)
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort()
  const items: SummaryItem[] = []
  for (const key of keys) {
    const from = read(prev, key)
    const to = read(cur, key)
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    items.push({ kind: 'prop', prop: key, from: clipValue(from), to: clipValue(to) })
  }
  return items
}

// 「改了」的口径：属性看名字、类型、位置、选项；视图看名字、布局、位置、筛选、排序、分组、显示属性。
// 列宽不算：拖一下列宽不该在流水里出一条，只改了列宽的版本没有可读摘要，流水不列，历史版本里仍在
const propKey = (p: CollectionProp): string => JSON.stringify([p.name, p.type, p.pos, p.options])
const viewKey = (v: CollectionView): string => JSON.stringify([v.name, v.layout, v.pos, v.filter, v.sorts, v.groupBy, v.shown])

function entityDiff<T extends { id: string; name: string }>(
  prev: readonly T[],
  cur: readonly T[],
  key: (item: T) => string,
  ops: { add: SchemaOp; del: SchemaOp; edit: SchemaOp },
): SummaryItem[] {
  const items: SummaryItem[] = []
  const before = new Map(prev.map((item) => [item.id, item]))
  const after = new Set(cur.map((item) => item.id))
  for (const item of cur) {
    const old = before.get(item.id)
    if (!old) items.push({ kind: 'schema', op: ops.add, text: clip(item.name) })
    else if (key(old) !== key(item)) items.push({ kind: 'schema', op: ops.edit, text: clip(item.name) })
  }
  for (const item of prev) if (!after.has(item.id)) items.push({ kind: 'schema', op: ops.del, text: clip(item.name) })
  return items
}

/** 集合页两版的属性定义 / 视图之差（两边都经 parseCollection，坏条目已跳过）。任一边是 null（不是集合页）则无项 */
export function schemaDiff(prev: CollectionSchema | null, cur: CollectionSchema | null): SummaryItem[] {
  if (!prev || !cur) return []
  return [
    ...entityDiff(prev.props, cur.props, propKey, { add: 'prop_add', del: 'prop_del', edit: 'prop_edit' }),
    ...entityDiff(prev.views, cur.views, viewKey, { add: 'view_add', del: 'view_del', edit: 'view_edit' }),
  ]
}

/** 一个时刻的可摘要状态。props / schema 缺省为空（普通页面的摘要与只看正文 + 标题时逐字节一致） */
export type SummaryState = {
  title: string
  blocks: string[]
  /** 行文档 Y.Map('props') 的 JSON（普通页面恒为空） */
  props?: Record<string, unknown>
  /** 集合页的属性定义与视图；不是集合页 = null */
  schema?: CollectionSchema | null
}

/** 回放到某一时刻的文档转摘要状态（更新流水每步一次）。collection 为 true（页面是集合页）才解析 Y.Map('collection') */
export function summaryState(doc: Y.Doc, title: string, collection: boolean): SummaryState {
  return {
    title,
    blocks: blockTexts(doc),
    props: doc.getMap<unknown>('props').toJSON(),
    schema: collection ? parseCollection(doc.getMap<unknown>('collection').toJSON()) : null,
  }
}

// 单条更新摘要：prev 为 null（首条快照）是 create；否则依次拼属性项（行）、集合定义项（集合页）、
// 正文块 diff，最后是标题（正文摘要是主语，标题变更是补充）
export function summarizeChange(prev: SummaryState | null, cur: SummaryState): SummaryItem[] {
  if (!prev) return CREATE_SUMMARY
  const items: SummaryItem[] = [
    ...propDiff(prev.props ?? {}, cur.props ?? {}),
    ...schemaDiff(prev.schema ?? null, cur.schema ?? null),
    ...diffBlocks(prev.blocks, cur.blocks),
  ]
  if (prev.title !== cur.title) items.push({ kind: 'title', text: clip(cur.title) })
  return items
}
