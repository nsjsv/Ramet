/** 页面树成员判定（目录树文档与页面树成员是两件事）。
 *
 * `in_page_tree === false` 的页是目录树自建文档：它属于空间（可见、可搜、可回收），
 * 但不进页面树。它的子孙跟着排除，否则父被拿掉后，子页会被当成没有父的顶层页冒出来。
 * 字段缺省（旧缓存）视为在页面树里。父不在这份列表里时当顶层，和组树时的孤儿兜底一致。
 * 环上的页排除，避免沿 parent 走死循环。 */

export function pagesInPageTree<
  T extends { id: string; parent_id: string | null; in_page_tree?: boolean },
>(pages: T[]): T[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const shown = new Map<string, boolean>()
  const visiting = new Set<string>()

  function isShown(page: T): boolean {
    const cached = shown.get(page.id)
    if (cached !== undefined) return cached
    if (page.in_page_tree === false || visiting.has(page.id)) {
      shown.set(page.id, false)
      return false
    }
    visiting.add(page.id)
    const parent = page.parent_id ? byId.get(page.parent_id) : undefined
    const ok = parent ? isShown(parent) : true
    visiting.delete(page.id)
    shown.set(page.id, ok)
    return ok
  }

  return pages.filter((page) => isShown(page))
}

/** 页面列表的排序口径（与服务端 page-sync.ts 的 SELECT_ALL_MINE 同一口径）：
 * position ASC NULLS LAST（侧栏拖拽排序，NULL = 没排过），再 created_at，再 id。
 * 客户端把增量合并进本地列表后按它重排，结果与整表重拉逐项同序。
 * 字符串按码元比较（不用 localeCompare）：服务端那两列是 COLLATE "C"（逐字节）；created_at / id 都是 ASCII，两边一致 */
export function comparePages<T extends { id: string; created_at: string; position?: number | null }>(a: T, b: T): number {
  const pa = a.position ?? null
  const pb = b.position ?? null
  if (pa !== pb) {
    if (pa === null) return 1
    if (pb === null) return -1
    return pa < pb ? -1 : 1
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}
