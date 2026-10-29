// 主动建的标题只有 1–3 级：斜杠菜单、块转换菜单只给 1–3 级；其余入口（快捷键 Mod-Alt-n、行首 `#…# ` 输入规则）
// 都以 MAX_HEADING_LEVEL 为上限。milkdown 预设自带的标题键位（Mod-Alt-1…6）与输入规则（`#` 个数即级别）
// 从预设里拿掉（block-id.ts 的 commonmarkPreset），由 shortcuts.ts 与这里的 headingInputRule 接手。
// markdown 里来的 4–6 级（agent 回复、导入、粘贴、源码）照常保留：schema 不变，显示不小于正文（prose.css）。

import { headingKeymap, headingSchema, wrapInHeadingInputRule } from '@milkdown/kit/preset/commonmark'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule } from '@milkdown/kit/utils'

export const MAX_HEADING_LEVEL = 3

/** 预设里被替换掉的标题入口（block-id.ts 的 commonmarkPreset 过滤用） */
export const presetHeadingEntries: ReadonlySet<MilkdownPlugin> = new Set<MilkdownPlugin>([wrapInHeadingInputRule, ...headingKeymap])

/** 行首 `# ` … `###### ` → 标题，`#` 多于上限按上限 */
export const headingInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^(#{1,6})\s$/, headingSchema.type(ctx), (match) => ({
    level: Math.min(match[1]?.length ?? 1, MAX_HEADING_LEVEL),
  })),
)
