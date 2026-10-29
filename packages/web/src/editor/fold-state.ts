// 折叠状态只在本机：折叠块 / 可折叠提示框的展开与否是看的人自己的事，不写进共享文档（否则一个人收起，所有人都收起）。
// 按块 id 记在 localStorage（`ramet-folds`：id → 是否收起），上限 1000 条（最旧的先丢）。
// 没记录 = 用调用方给的默认值（折叠块默认展开、Obsidian `-` 标记的提示框默认收起）。块还没 id（刚插入、补 id 之前）也用默认值。

const KEY = 'ramet-folds'
const LIMIT = 1000

let folds: Map<string, boolean> | null = null

function load(): Map<string, boolean> {
  if (folds) return folds
  folds = new Map()
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) for (const entry of parsed) if (Array.isArray(entry) && typeof entry[0] === 'string') folds.set(entry[0], Boolean(entry[1]))
  } catch {
    // 隐私模式 / 坏数据：从空开始
  }
  return folds
}

function save(map: Map<string, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...map].slice(-LIMIT)))
  } catch {
    // 存不下就只在这次会话里记
  }
}

export function isFolded(id: string, fallback: boolean): boolean {
  if (!id) return fallback
  return load().get(id) ?? fallback
}

/** 记住收起 / 展开；与默认值相同就删掉记录（省地方） */
export function setFolded(id: string, folded: boolean, fallback: boolean): void {
  if (!id) return
  const map = load()
  map.delete(id)
  if (folded !== fallback) map.set(id, folded)
  save(map)
}
