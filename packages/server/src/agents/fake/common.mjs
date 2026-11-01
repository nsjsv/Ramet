// 假 agent 剧本各部分共用的小工具（一轮的结局常量、可取消的睡眠）。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const END = { stop: 'end_turn' }
export const CANCELLED = { stop: 'cancelled' }

/** 睡 ms 毫秒，认取消；被取消返回 true */
export async function napCancellable(s, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (s.cancelled) return true
    await sleep(25)
  }
  return s.cancelled
}
