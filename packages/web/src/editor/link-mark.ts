// link mark 不续接：commonmark 预设的 link mark 没声明 inclusive，ProseMirror 默认 true，光标在链接末尾继续打字、
// 或在链接末尾回车拆段，新内容都会被续上 link mark，链接后面接不了普通文字。
// 设成 false 后链接末尾的输入就是普通文字；只影响编辑行为，不改 attrs / 序列化 / Y.Doc 结构，
// 所以只读的公开页不用同步注册。走 milkdown 公开的 extendSchema（同 block-id.ts），
// 必须排在 commonmark 预设之后，同名原位替换。

import { linkSchema } from '@milkdown/kit/preset/commonmark'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import type { MarkSchema } from '@milkdown/kit/transformer'

export const linkNotInclusive: MilkdownPlugin[] = linkSchema
  .extendSchema((prev: (ctx: Ctx) => MarkSchema) => (ctx: Ctx) => ({ ...prev(ctx), inclusive: false }))
  .flat()
