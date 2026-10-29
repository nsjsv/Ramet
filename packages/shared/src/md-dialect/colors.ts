// ---------- 文字颜色 / 背景高亮的调色板（Notion 同款 9 色） ----------
// 文档里只存颜色名（mark attrs.color），显示时按主题取 CSS 变量（web 的 styles/colors.css）；
// 写进 markdown 时带上浅色主题的色值（style），博客 / GitHub 不认 data-color 也能看到颜色。

export const COLOR_NAMES = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const
export type ColorName = (typeof COLOR_NAMES)[number]

export function isColorName(value: unknown): value is ColorName {
  return typeof value === 'string' && (COLOR_NAMES as readonly string[]).includes(value)
}

export const TEXT_HEX: Record<ColorName, string> = {
  gray: '#787774',
  brown: '#9f6b53',
  orange: '#d9730d',
  yellow: '#cb912f',
  green: '#448361',
  blue: '#337ea9',
  purple: '#9065b0',
  pink: '#c14c8a',
  red: '#d44c47',
}

export const BG_HEX: Record<ColorName, string> = {
  gray: '#f1f1ef',
  brown: '#f4eeee',
  orange: '#fbecdd',
  yellow: '#fbf3db',
  green: '#edf3ec',
  blue: '#e7f3f8',
  purple: '#f6f3f9',
  pink: '#faf1f5',
  red: '#fdebec',
}

/** 高亮缺省颜色（`<mark>` 不带 data-color、Obsidian 的 `==…==`） */
export const DEFAULT_HIGHLIGHT: ColorName = 'yellow'

/** html 类 mark 的开 / 闭标签（编辑器 toMarkdown 与服务端 markdown-out 共用；识别见 inline.ts） */
export function markOpenTag(mark: 'underline' | 'text_color' | 'highlight', color?: unknown): string {
  if (mark === 'underline') return '<u>'
  const name = isColorName(color) ? color : mark === 'highlight' ? DEFAULT_HIGHLIGHT : 'gray'
  if (mark === 'text_color') return `<span data-color="${name}" style="color: ${TEXT_HEX[name]}">`
  return name === DEFAULT_HIGHLIGHT ? '<mark>' : `<mark data-color="${name}" style="background: ${BG_HEX[name]}">`
}

export function markCloseTag(mark: 'underline' | 'text_color' | 'highlight'): string {
  return mark === 'underline' ? '</u>' : mark === 'text_color' ? '</span>' : '</mark>'
}
