// ---------- 待引用队列：「引用」跨页落进输入 ----------
// 过程页点步骤的「引用」要回到所属页面，出现在正在写的消息里。来源页入队后导航，
// 目标页的编辑器同步完（editor-session 的 drainQuotes）再取走插进草稿。只在内存里，刷新即丢。
export type QuoteRef = { pageId: string; blockId: string; text: string }

const pending = new Map<string, QuoteRef[]>()

/** targetPageId = 引用要放进哪一页的输入 */
export function queueQuote(targetPageId: string, ref: QuoteRef): void {
  pending.set(targetPageId, [...(pending.get(targetPageId) ?? []), ref])
}

export function takeQuotes(targetPageId: string): QuoteRef[] {
  const list = pending.get(targetPageId) ?? []
  pending.delete(targetPageId)
  return list
}
