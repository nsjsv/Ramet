// ---------- markdown → 文档块结构（AI 回复：前端实时渲染与服务端收尾落块共用这一份） ----------
// agent 吐的是 markdown 文本，文档要的是块结构。服务端收尾时把它落成 Yjs（server agents/markdown.ts 的 materialize），
// 前端运行中把它转成 ProseMirror 节点实时渲染：同一份输入、同一个解析器、同一个 schema，收尾那一刻外观不跳。
//
// 形状必须与前端 schema 逐字对齐（名字和 attr 默认值都抄 @milkdown/preset-commonmark）：
//   · 块 / 原子节点：paragraph / heading{level,id} / code_block{language} / blockquote / hr /
//     bullet_list{spread} / ordered_list{order,spread} / list_item{label,listType,spread} /
//     image{src,alt,title} / hardbreak{isInline}
//   · 表格（GFM）：table / table_header_row(table_header*) / table_row(table_cell*)，
//     cell attrs 带 alignment（'left'|'center'|'right'），cell 内恰一个 paragraph（preset-gfm 的形状）
//   · 行内 mark：strong/emphasis（带 marker）、inlineCode、link（带 href/title）、strike_through、underline
//   · 待办：list_item 的 checked（true / false；普通条目不写，取 schema 默认 null）
//   · 公式：math_inline（行内原子，attrs.latex）/ math_block（text 是 LaTeX 原文）
//   · 方言块：callout{kind,fold,title} / toggle（首段是摘要）/ columns > column / toc / embed{kind,src,height}；
//     方言 mark：underline、text_color{color}、highlight{color}
//   · 换行：markdown 的软换行落成 hardbreak 节点（文本抽取会把它还原成 '\n'，搜索 / 摘要 / agent 上下文都不丢行）
//
// 解析走方言层（md-dialect 的 parseMarkdown），与编辑器的 remark 管线同一套 GFM 参数与方言识别，
// 这里只把（标准 + 方言）mdast 映射成 Block。
//
// 前端不会来改这些结构：list 拆分和有序续号只扫顶层 list（list-blocks.ts 的 appendTransaction
// 与 renumberOrderedRuns 都是 doc.forEach），而这里写出的结构都在 agent_reply 内部。

import { BOOKMARK, CALLOUT, COLUMN, COLUMNS, EMBED, LINK_MENTION, isRametMark, parseMarkdown, TOC, TOGGLE, type Md } from './md-dialect/index.js'

export type Attrs = Record<string, unknown>
export type MarkSpec = { name: string; attrs: Attrs }
export type Inline =
  | { text: string; marks: MarkSpec[] }
  | { br: true }
  | { atom: string; attrs: Attrs }
export type Block = {
  name: string
  attrs: Attrs
  inlines?: Inline[]
  /** code_block 的正文（content: text*），单独给：它不是行内内容 */
  text?: string
  blocks?: Block[]
}

/** 可变标记：任何一个节点被判定为「富结构」就置真 */
type Rich = { value: boolean }

const HEADING_MAX = 6

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 行内内容转 Inline 列表（marks 沿树累积；嵌套同型 mark 不会出现，markdown 表达不了） */
function inlineNodes(nodes: Md[], marks: MarkSpec[], out: Inline[], rich: Rich): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        // 软换行（段内单个 '\n'）落成 hardbreak：与 markdown 渲染口径一致，且让文本抽取能还原行
        pushText(text(node.value), marks, out)
        break
      case 'strong':
      case 'emphasis':
        rich.value = true
        inlineNodes(node.children ?? [], [...marks, { name: node.type, attrs: { marker: '*' } }], out, rich)
        break
      case 'inlineCode':
        rich.value = true
        pushText(text(node.value), [...marks, { name: 'inlineCode', attrs: {} }], out)
        break
      case 'link':
        rich.value = true
        inlineNodes(
          node.children ?? [],
          [...marks, { name: 'link', attrs: { href: text(node.url), title: typeof node.title === 'string' ? node.title : null } }],
          out,
          rich,
        )
        break
      case 'image':
        rich.value = true
        out.push({
          atom: 'image',
          attrs: { src: text(node.url), alt: text(node.alt), title: text(node.title) },
        })
        break
      case 'break': // 显式硬换行（行尾两个空格）
        out.push({ br: true })
        break
      case 'delete': // GFM 删除线
        rich.value = true
        inlineNodes(node.children ?? [], [...marks, { name: 'strike_through', attrs: {} }], out, rich)
        break
      case LINK_MENTION: // 网页提及：原子节点，只存地址（标题 / 图标渲染时现取）
        rich.value = true
        out.push({ atom: 'link_mention', attrs: { url: text(node.url) } })
        break
      case 'inlineMath': // 行内公式：原子节点，LaTeX 原文在 attrs.latex
        rich.value = true
        out.push({ atom: 'math_inline', attrs: { latex: text(node.value) } })
        break
      case 'footnoteReference': // 文档没有脚注节点：保留原文记号
        pushText(`[^${text(node.label) || text(node.identifier)}]`, marks, out)
        break
      default:
        if (isRametMark(node)) {
          rich.value = true
          const attrs = node.color ? { color: node.color } : {}
          inlineNodes(node.children, [...marks, { name: node.mark, attrs }], out, rich)
          break
        }
        if (node.children) inlineNodes(node.children, marks, out, rich)
        else if (text(node.value)) pushText(text(node.value), marks, out)
    }
  }
}

function pushText(value: string, marks: MarkSpec[], out: Inline[]): void {
  if (!value) return
  const parts = value.split('\n')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push({ br: true })
    if (parts[i]) out.push({ text: parts[i]!, marks })
  }
}

/** 列表：每个条目落成独立的单条目 list（前端不变式：顶层 list 恰含 1 个 list_item）。
 *  这里嵌在回复块里不受顶层归一化管，但保持同一形状，视觉与行为才一致 */
function listBlocks(node: Md, rich: Rich): Block[] {
  const ordered = node.ordered === true
  const start = typeof node.start === 'number' ? node.start : 1
  const spread = node.spread === true
  return (node.children ?? []).map((item, i) => {
    const index = start + i
    return {
      name: ordered ? 'ordered_list' : 'bullet_list',
      attrs: ordered ? { order: index, spread } : { spread },
      blocks: [
        {
          name: 'list_item',
          attrs: {
            label: ordered ? `${typeof item.label === 'number' ? item.label : index}.` : '•',
            listType: ordered ? 'ordered' : 'bullet',
            spread: item.spread ?? true,
            ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
          },
          blocks: blocksOf(item.children ?? [], rich),
        },
      ],
    }
  })
}

/** 表格：mdast 的 table > tableRow(tableCell*) 转成前端 schema 的
 *  table > table_header_row(table_header*) + table_row+(table_cell*)（见 @milkdown/preset-gfm）。
 *  首行即表头（mdast 不打 isHeader，靠位置）；cell 内必须恰好包一个 paragraph；
 *  alignment 落在每个 cell 的 attrs 上（mdast 的 null 对应前端 schema 默认值 'left'）。 */
function tableBlock(node: Md, rich: Rich): Block[] {
  const rows = node.children ?? []
  if (rows.length < 2) {
    // 前端 schema 是 `table_header_row table_row+`：只有表头（无正文行）的表产不出合法结构，
    // 退回一行纯文本，宁可少个表格，也不写进会让前端建不出文档的块
    const inlines: Inline[] = []
    for (const row of rows) {
      for (const cell of row.children ?? []) {
        if (inlines.length > 0) inlines.push({ text: ' | ', marks: [] })
        inlineNodes(cell.children ?? [], [], inlines, rich)
      }
    }
    return [{ name: 'paragraph', attrs: {}, inlines }]
  }
  rich.value = true
  const align = Array.isArray(node.align) ? (node.align as unknown[]) : []
  const rowBlock = (row: Md, isHeader: boolean): Block => ({
    name: isHeader ? 'table_header_row' : 'table_row',
    attrs: {},
    blocks: (row.children ?? []).map((cell, i) => {
      const inlines: Inline[] = []
      inlineNodes(cell.children ?? [], [], inlines, rich)
      return {
        name: isHeader ? 'table_header' : 'table_cell',
        attrs: { alignment: text(align[i]) || 'left' },
        blocks: [{ name: 'paragraph', attrs: {}, inlines }],
      }
    }),
  })
  return [{ name: 'table', attrs: {}, blocks: rows.map((row, i) => rowBlock(row, i === 0)) }]
}

/** 块级内容 → Block 列表 */
function blocksOf(nodes: Md[], rich: Rich): Block[] {
  const out: Block[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph': {
        const inlines: Inline[] = []
        inlineNodes(node.children ?? [], [], inlines, rich)
        out.push({ name: 'paragraph', attrs: {}, inlines })
        break
      }
      case 'heading': {
        rich.value = true
        const inlines: Inline[] = []
        inlineNodes(node.children ?? [], [], inlines, rich)
        const depth = typeof node.depth === 'number' ? node.depth : 1
        out.push({ name: 'heading', attrs: { level: Math.min(Math.max(depth, 1), HEADING_MAX), id: '' }, inlines })
        break
      }
      case 'code':
        rich.value = true
        out.push({ name: 'code_block', attrs: { language: text(node.lang) }, text: text(node.value) })
        break
      case 'blockquote':
        rich.value = true
        out.push({ name: 'blockquote', attrs: {}, blocks: blocksOf(node.children ?? [], rich) })
        break
      case 'math': // 块级公式：代码类块，LaTeX 原文是内容
        rich.value = true
        out.push({ name: 'math_block', attrs: {}, text: text(node.value) })
        break
      case 'thematicBreak':
        rich.value = true
        out.push({ name: 'hr', attrs: {} })
        break
      case 'list':
        rich.value = true
        out.push(...listBlocks(node, rich))
        break
      case 'table':
        out.push(...tableBlock(node, rich))
        break
      case CALLOUT:
        rich.value = true
        out.push({
          name: 'callout',
          attrs: { kind: text(node.kind) || 'note', fold: text(node.fold), title: text(node.title) },
          blocks: blocksOf(node.children ?? [], rich),
        })
        break
      case TOGGLE:
        rich.value = true
        out.push({
          name: 'toggle',
          attrs: {},
          blocks: [{ name: 'paragraph', attrs: {}, inlines: text(node.summary) ? [{ text: text(node.summary), marks: [] }] : [] }, ...blocksOf(node.children ?? [], rich)],
        })
        break
      case COLUMNS:
        rich.value = true
        out.push({
          name: 'columns',
          attrs: {},
          blocks: (node.children ?? []).filter((c) => c.type === COLUMN).map((c) => ({ name: 'column', attrs: {}, blocks: blocksOf(c.children ?? [], rich) })),
        })
        break
      case TOC:
        rich.value = true
        out.push({ name: 'toc', attrs: {} })
        break
      case EMBED:
        rich.value = true
        out.push({ name: 'embed', attrs: { kind: text(node.kind), src: text(node.src), height: text(node.height) } })
        break
      case BOOKMARK:
        rich.value = true
        out.push({ name: 'bookmark', attrs: { url: text(node.url) } })
        break
      case 'footnoteDefinition': {
        // 文档没有脚注节点：定义退成以 `[^名]: ` 开头的正文
        const inner = blocksOf(node.children ?? [], rich)
        const first = inner[0]
        const label = `[^${text(node.label) || text(node.identifier)}]: `
        if (first?.inlines) first.inlines.unshift({ text: label, marks: [] })
        else inner.unshift({ name: 'paragraph', attrs: {}, inlines: [{ text: label, marks: [] }] })
        out.push(...inner)
        break
      }
      case 'html':
        // 原样当文字（不渲染 HTML：文档里塞 HTML 会击穿编辑/撤销/协同）
        out.push({ name: 'paragraph', attrs: {}, inlines: [{ text: text(node.value), marks: [] }] })
        break
      default: {
        const inlines: Inline[] = []
        inlineNodes([node], [], inlines, rich)
        if (inlines.length > 0) out.push({ name: 'paragraph', attrs: {}, inlines })
      }
    }
  }
  return out
}

/** markdown 转块树；rich=false 表示这份文本没有任何 markdown 结构。
 *  解析失败一律 blocks=[] / rich=false（宁可少结构，也不半解析出坏结构）。 */
export function parseBlocks(markdown: string): { blocks: Block[]; rich: boolean } {
  const rich: Rich = { value: false }
  let blocks: Block[] = []
  try {
    blocks = blocksOf(parseMarkdown(markdown).children ?? [], rich)
  } catch {
    return { blocks: [], rich: false }
  }
  return { blocks, rich: rich.value }
}
