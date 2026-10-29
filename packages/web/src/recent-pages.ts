// 本机最近打开的页面（`@` 大菜单的「最近」分组）。页面表没有「最近编辑」时间，这里记这台浏览器最近打开过哪些页
// （Editor 换页时记一笔）。丢了（隐私模式 / 清站点数据）菜单只是少一组「最近」，所以读写都 try/catch、不进服务端。

const KEY = 'ramet:recent-pages'
const MAX = 20

function read(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 最近打开的页面 id，新的在前 */
export function recentPageIds(): string[] {
  return read()
}

/** 记一次打开：挪到最前，去重，截到 MAX */
export function recordRecentPage(pageId: string): void {
  if (!pageId) return
  const next = [pageId, ...read().filter((id) => id !== pageId)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 存不下就算了：只影响「最近」分组
  }
}
