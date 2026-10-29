/* ---------- 字数（顶栏 ⋮ 菜单与块手柄菜单共用一个口径） ----------
 * 同 Word / 飞书：汉字、假名、谚文每字算 1；其余连续的字母数字算 1 个词（词内的 ' ’ - . 不断词，如 don't、3.14）；
 * 标点、符号、空白不计。调用方把块之间拼成换行再传进来，英文才不会跨块粘成一个词。 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const WORD = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu

export function countWords(text: string): number {
  let cjk = 0
  const rest = text.replace(CJK, () => {
    cjk++
    return ' '
  })
  return cjk + (rest.match(WORD)?.length ?? 0)
}

/** ProseMirror 节点（整篇文档或一个块）的字数：块之间按换行拼，行内原子节点（提及 / 页面链接）按空格隔开 */
export function countNodeWords(node: { content: { size: number }; textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string }): number {
  return countWords(node.textBetween(0, node.content.size, '\n', ' '))
}
