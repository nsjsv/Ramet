// ---------- markdown → 原始 mdast（只解析、不跑方言识别） ----------
// 扩展与编辑器对齐：GFM 全量（remark-gfm 4 默认参数）+ 数学。parse.ts（再跑识别）与块级规则里的嵌套解析
// （`<details>` 一整块 html 里的正文）共用；嵌套的那段由 transformDialect 的递归顺带识别，这里不跑。

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import type { Md } from './types.js'

export function parseMdast(markdown: string): Md {
  return fromMarkdown(markdown, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as unknown as Md
}
