/* ---------- ⌘P 找文件的模糊匹配 ----------
 * 子序列匹配：查询的每个字符按顺序出现在路径里就算命中（不区分大小写）。排序只看路径本身：
 * 连续命中、落在单词开头（路径分隔 / . _ - 或驼峰）、落在文件名里、路径短，分高。空查询 = 全部，原顺序。 */

export type FuzzyHit = { path: string; score: number; /** 命中的字符下标（高亮用） */ indices: number[] }

const SEP = new Set(['/', '.', '_', '-', ' '])

function boundary(path: string, i: number): boolean {
  if (i === 0) return true
  const prev = path[i - 1]!
  if (SEP.has(prev)) return true
  const ch = path[i]!
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase() // 驼峰：fooBar 的 B
}

/** 单个路径的匹配：贪心找一条得分最高的子序列（对每个起点各走一遍，路径都不长）；没命中 null */
export function fuzzyMatch(query: string, path: string): FuzzyHit | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { path, score: 0, indices: [] }
  const text = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  let best: FuzzyHit | null = null
  for (let start = text.indexOf(q[0]!); start !== -1; start = text.indexOf(q[0]!, start + 1)) {
    const indices = [start]
    let at = start
    let ok = true
    for (let k = 1; k < q.length; k++) {
      // 优先落在单词开头，其次是紧挨着上一个命中的位置，最后才是任意位置
      let next = -1
      for (let j = at + 1; j < text.length; j++) {
        if (text[j] === q[k] && (j === at + 1 || boundary(path, j))) {
          next = j
          break
        }
      }
      if (next === -1) next = text.indexOf(q[k]!, at + 1)
      if (next === -1) {
        ok = false
        break
      }
      indices.push(next)
      at = next
    }
    if (!ok) continue
    let score = 0
    indices.forEach((idx, n) => {
      score += 1
      if (n > 0 && idx === indices[n - 1]! + 1) score += 4 // 连续
      if (boundary(path, idx)) score += 3 // 单词开头
      if (idx >= nameStart) score += 2 // 在文件名里
    })
    if (indices[0]! === nameStart) score += 6 // 文件名以查询开头
    score -= Math.min(path.length, 120) / 40 // 路径越短越靠前
    if (!best || score > best.score) best = { path, score, indices }
  }
  return best
}

/** 过滤并排序：最多 limit 条。空查询原样取前 limit 条 */
export function fuzzyFilter(paths: readonly string[], query: string, limit = 50): FuzzyHit[] {
  if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0, indices: [] }))
  const hits: FuzzyHit[] = []
  for (const path of paths) {
    const hit = fuzzyMatch(query, path)
    if (hit) hits.push(hit)
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return hits.slice(0, limit)
}
