// 运行中回复的实时 markdown（文档模式 AI 块、聊天气泡共用）。
// 与服务端收尾落块用同一个解析器（@ramet/shared/markdown-blocks）、同一个 schema：
// 文本 → Block[] → ProseMirror 节点 → DOMSerializer。收尾时真内容替换上来，外观不跳。
// 只换内容变了的顶层块（通常是最后一块）：写完的块 DOM 节点保持同一个对象，不闪、不丢选区。
import { DOMSerializer, type Mark, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { hydrateRich } from './rich-render'
import { parseBlocks, type Block, type Inline } from '@ramet/shared/markdown-blocks'

/** 末尾未闭合的行内标记先按闭合显示（只影响显示，不改数据）：代码围栏补收尾，
 *  行内 `**` / `` ` `` 补一个闭合；刚打出来、后面还没有字的标记先不显示 */
export function closeOpenMarks(text: string): string {
  if ((text.match(/^```/gm) ?? []).length % 2 === 1) return `${text}\n\`\`\``
  const tail = text.slice(text.lastIndexOf('\n\n') + 1)
  if ((tail.match(/`/g) ?? []).length % 2 === 1) return text.endsWith('`') ? text.slice(0, -1) : `${text}\``
  if ((tail.replace(/`[^`]*`/g, '').match(/\*\*/g) ?? []).length % 2 === 1) {
    return text.endsWith('**') ? text.slice(0, -2) : `${text}**`
  }
  return text
}

function inlineNodes(schema: Schema, inlines: Inline[]): PMNode[] {
  const out: PMNode[] = []
  for (const inline of inlines) {
    if ('br' in inline) {
      const br = schema.nodes.hardbreak
      if (br) out.push(br.create({ isInline: false }))
    } else if ('atom' in inline) {
      const type = schema.nodes[inline.atom]
      if (type) out.push(type.create(inline.attrs))
    } else {
      const marks: Mark[] = []
      for (const m of inline.marks) {
        const type = schema.marks[m.name]
        if (type) marks.push(type.create(m.attrs))
      }
      out.push(schema.text(inline.text, marks))
    }
  }
  return out
}

/** Block → PM 节点（名字/attrs 与 schema 逐字对齐，见共享包注释）；schema 里没有的类型跳过 */
export function blockNode(schema: Schema, block: Block): PMNode | null {
  const type = schema.nodes[block.name]
  if (!type) return null
  try {
    if (block.text !== undefined) return type.create(block.attrs, block.text ? schema.text(block.text) : null)
    if (block.inlines) return type.create(block.attrs, inlineNodes(schema, block.inlines))
    return type.create(block.attrs, (block.blocks ?? []).flatMap((b) => blockNode(schema, b) ?? []))
  } catch {
    return null
  }
}

export class LiveMarkdown {
  readonly el: HTMLElement
  private keys: string[] = []
  private serializer: DOMSerializer

  constructor(private schema: Schema) {
    this.el = document.createElement('div')
    this.el.className = 'live-body'
    this.serializer = DOMSerializer.fromSchema(schema)
  }

  render(text: string): void {
    const { blocks } = parseBlocks(closeOpenMarks(text))
    blocks.forEach((block, i) => {
      const key = JSON.stringify(block)
      const current = this.el.children[i]
      if (current && this.keys[i] === key) return
      const node = blockNode(this.schema, block)
      const dom = node ? this.serializer.serializeNode(node) : document.createElement('p')
      if (current) this.el.replaceChild(dom, current)
      else this.el.appendChild(dom)
      // 代码高亮 / mermaid（rich-render.ts）；最后一块还在流式生成，不画图（半截代码每段都重画、还会报错）
      if (dom instanceof HTMLElement) hydrateRich(dom, { mermaid: i < blocks.length - 1 })
      this.keys[i] = key
    })
    while (this.el.children.length > blocks.length) this.el.lastElementChild!.remove()
    this.keys.length = blocks.length
  }

  reset(): void {
    this.el.replaceChildren()
    this.keys = []
  }
}
