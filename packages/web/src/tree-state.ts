import { useCallback, useEffect, useState } from 'react'

/* ---------- 树展开态的跨刷新记忆（页面树 / 目录树共用）----------
 * localStorage 存一组 id（JSON 数组），组件挂载时同步播种（与 App.tsx 的列表缓存同款先渲染、后校准），变更后回写。
 *
 * 不放服务端：展开态是这台浏览器上的阅读位置，不是文档数据，多端各自展开互不干扰，也不产生请求。
 * 失效 id（页面 / 目录已删）留在集合里无害，渲染按当前树取交集，不会凭空展开出东西。
 * 不做过期清理与容量上限，条目数是 KB 级。 */

function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch {
    return new Set() // 隐私模式 / quota / 脏数据：按无记忆，不阻断渲染
  }
}

function write(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]))
  } catch (err) {
    console.error('save tree expansion failed:', err) // 写失败只丢记忆，不影响交互
  }
}

/** 一个可跨刷新保持的 id 集合，返回 [集合, 翻转单个 id, 批量加入]。key 决定记忆归属
 *  （页面树按空间 id 分，目录树共用一条，目录 id 本身全局唯一）。
 *  批量加入用于「新东西落进折叠的目录 / 定位当前页」时展开祖先，全部已在集合里就不产生新 Set */
export function usePersistentSet(
  key: string,
): [Set<string>, (id: string) => void, (ids: readonly string[]) => void] {
  const [ids, setIds] = useState<Set<string>>(() => read(key))

  // 落盘放 effect 而不是 setState updater，updater 必须是纯函数
  useEffect(() => {
    write(key, ids)
  }, [key, ids])

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const add = useCallback((more: readonly string[]) => {
    setIds((prev) => {
      if (more.every((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of more) next.add(id)
      return next
    })
  }, [])

  return [ids, toggle, add]
}
