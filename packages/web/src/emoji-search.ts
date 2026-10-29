/* ---------- emoji 选择器的中文搜索 ----------
 * @emoji-mart/data 的名字 / 关键词全是英文，搜「火箭」什么都搜不到。这里把中文词表（emoji-zh.json，
 * scripts/build-emoji-zh.mjs 从 emojibase-data 生成）在选择器加载数据时并进每个 emoji 的 keywords。
 *
 * emoji-mart 的匹配是逗号分隔词的前缀：`search.indexOf(',' + 查询词)`，所以光并入整词不够，
 * 搜「箭」命中不了「火箭」。每个词因此再展开它的所有后缀（火箭展开成火箭、箭），搜词落在词中间也能命中；
 * 词表里的名字带空格 / 冒号的（「区域指标 A」）先拆成片再展开。 */

export interface EmojiMartData {
  emojis: Record<string, { keywords?: string[]; skins: Array<{ unified?: string }> }>
}

/** 中文词表：{ 码点（hexKey 规则）: [中文名, ...标签] } */
export type ZhKeywords = Record<string, string[]>

/** 码点键：小写，去掉 fe0f（变体选择符）。与 scripts/build-emoji-zh.mjs 同一规则 */
export function hexKey(unified: string): string {
  return unified
    .toLowerCase()
    .split('-')
    .filter((part) => part !== 'fe0f')
    .join('-')
}

/** 一个词的本身加它的所有后缀（去重由调用方的 Set 负责） */
export function suffixes(term: string): string[] {
  const chars = Array.from(term)
  return chars.map((_, i) => chars.slice(i).join(''))
}

/** 原地把中文词并进 data.emojis[*].keywords 并返回 data。词表里没有的 emoji 原样不动 */
export function addZhKeywords<T extends EmojiMartData>(data: T, zh: ZhKeywords): T {
  for (const emoji of Object.values(data.emojis)) {
    const unified = emoji.skins[0]?.unified
    const terms = unified ? zh[hexKey(unified)] : undefined
    if (!terms) continue
    const added = new Set<string>()
    for (const term of terms) {
      for (const piece of term.split(/[\s,:：，、]+/)) {
        if (piece) for (const s of suffixes(piece)) added.add(s)
      }
    }
    emoji.keywords = [...(emoji.keywords ?? []), ...added]
  }
  return data
}
