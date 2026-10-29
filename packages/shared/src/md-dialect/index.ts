// ---------- Markdown 方言（@ramet/shared/md-dialect） ----------
// markdown 写法与文档结构的对应只在这里定义一次：编辑器解析（milkdown remark 插件）、AI 回复落块与 AI 写页面
// （markdown-blocks.ts 的 parseBlocks）、导入都走它。新块的写法：识别规则登记进 transform.ts 的两张表，
// 序列化方向由节点自己的 toMarkdown 产出标准 mdast。

export { CALLOUT, COLUMN, COLUMNS, EMBED, plainText, safeEmbedSrc, TOC, TOGGLE } from './blocks.js'
export { BG_HEX, COLOR_NAMES, DEFAULT_HIGHLIGHT, isColorName, markCloseTag, markOpenTag, TEXT_HEX, type ColorName } from './colors.js'
export { parseMdast } from './extensions.js'
export { parseMarkdown } from './parse.js'
export { remarkRametDialect } from './remark.js'
export { BLOCK_RULES, INLINE_TAGS, transformBlocks, transformDialect, transformInline, type BlockRule, type InlineTag } from './transform.js'
export { isRametMark, RAMET_MARK, textOf, type MarkName, type Md, type RametMark } from './types.js'
