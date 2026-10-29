// ---------- markdown → mdast（服务端用；编辑器走 milkdown 的 remark 管线 + remark.ts，结果同形） ----------

import { parseMdast } from './extensions.js'
import { transformDialect } from './transform.js'
import type { Md } from './types.js'

export function parseMarkdown(markdown: string): Md {
  const root = parseMdast(markdown)
  transformDialect(root)
  return root
}
