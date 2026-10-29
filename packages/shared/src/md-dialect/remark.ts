// ---------- 给 milkdown 的 remark 插件：数学扩展 + 解析后跑方言识别 ----------
// milkdown 的解析器是 `remark.runSync(remark.parse(text))`，transformer 在 runSync 里跑；序列化只 stringify、不 run，
// 所以识别只影响解析方向（见 transform.ts 文件头）。GFM 扩展由 milkdown 的 remark-gfm 提供，这里不重复挂；
// 数学（$ / $$）的 micromark / fromMarkdown / toMarkdown 扩展挂在这里（toMarkdown 让序列化认 inlineMath / math 节点），
// 与服务端 parse.ts 同一套。不依赖 unified 的类型：插件就是以处理器为 this、返回 transformer 的函数。

import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import { transformDialect } from './transform.js'
import type { Md } from './types.js'

type ProcessorData = { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[]; toMarkdownExtensions?: unknown[] }

export function remarkRametDialect(this: { data: () => ProcessorData }): (tree: unknown) => void {
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push(math())
  ;(data.fromMarkdownExtensions ??= []).push(mathFromMarkdown())
  ;(data.toMarkdownExtensions ??= []).push(mathToMarkdown())
  return (tree) => transformDialect(tree as Md)
}
