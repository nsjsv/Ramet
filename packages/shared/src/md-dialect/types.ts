// ---------- mdast 的窄化视图 + 方言节点类型 ----------
// 不引 @types/mdast：解析与识别只用到下面这些字段。方言节点（rametXxx）是 transformDialect 产出的自定义类型，
// 只活在解析到转成文档结构这一段；序列化方向（PM 到 markdown）各节点自己产出标准 mdast，remark-stringify 不认识它们也无妨。

export type Md = {
  type: string
  value?: unknown
  url?: unknown
  alt?: unknown
  title?: unknown
  lang?: unknown
  depth?: unknown
  ordered?: unknown
  start?: unknown
  spread?: unknown
  checked?: unknown
  label?: unknown
  identifier?: unknown
  /** gfm table 的列对齐（元素为 'left'|'center'|'right'|null） */
  align?: unknown
  children?: Md[]
  [key: string]: unknown
}

/** 行内成对 HTML 标签升出来的 mark：下划线、文字颜色、高亮 */
export const RAMET_MARK = 'rametMark'
export type MarkName = 'underline' | 'text_color' | 'highlight'
export type RametMark = Md & { type: typeof RAMET_MARK; mark: MarkName; color?: string; children: Md[] }

export function isRametMark(node: Md): node is RametMark {
  return node.type === RAMET_MARK && typeof node.mark === 'string'
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
