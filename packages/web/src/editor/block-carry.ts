// ---------- 块 id 跟着内容走：整段 / 整篇重新解析时把旧块的 id 带到新块上 ----------
// 块 id 是引用 / 收藏 / 反链 / 同步块的锚（见 block-id.ts）。源码模式这类「导出 markdown、用户改、重新解析、写回」的
// 边界，解析出来的节点天生没有 id（markdown 里没有它），直接写回会让每个块换新身份，已有的引用全部悬空。
// 写回之前把旧块的 id 抄给新块，规则是身份跟着内容走：
//   1. 内容完全相同（忽略 id）的块按最长公共子序列对上，id（含嵌套的列表项 id）原样带过去；
//   2. 夹在两处对上的块之间、数量和类型都一一对应的「改了几个字」的块，按位置对上；
//   3. 其余是真正的新内容，不给 id，由补 id 插件发新的。
// 每个旧 id 最多用一次，所以不会制造重复。纯函数，不碰文档。
// AI 回复块的计划清单（`plan` 属性）和带队的团队进度（`team` 属性）只进节点 attrs，不在 markdown 的标记段里，
// 和 id 同理，对上了就一起带过去；否则源码模式里改一个字，整页回复上的计划卡 / 团队卡全丢。

import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'

const hasId = (node: PMNode): boolean => node.type.spec.attrs?.id !== undefined

/** 内容键：类型 + 文本。LCS 先用它快速判等，再递归确认（键相同不等于结构相同） */
function keyOf(node: PMNode): string {
  return `${node.type.name}|${node.textContent}`
}

/** 同一内容：类型、子节点结构、文字逐个相同。不比 attrs 与 marks：重新解析出来的节点 attrs 常有无关差异
 * （列表的 spread / label、代码块语言的空串等），改个标题级别、加粗一个词也还是同一个块 */
function sameIgnoringIds(a: PMNode, b: PMNode): boolean {
  if (a.type !== b.type || a.childCount !== b.childCount) return false
  if (a.isText) return a.text === b.text
  for (let i = 0; i < a.childCount; i++) if (!sameIgnoringIds(a.child(i), b.child(i))) return false
  return true
}

/** 把 old 的 id 抄到同位置同类型的 fresh 节点上（递归；结构对不上的子树原样保留 fresh 的） */
function withIdsFrom(old: PMNode, fresh: PMNode, force = false): PMNode {
  const children: PMNode[] = []
  fresh.forEach((child, _offset, i) => {
    const counterpart = i < old.childCount ? old.child(i) : null
    children.push(counterpart && counterpart.type === child.type ? withIdsFrom(counterpart, child) : child)
  })
  const id = hasId(fresh) && (force || old.type === fresh.type) && typeof old.attrs.id === 'string' ? old.attrs.id : ''
  const reply = old.type === fresh.type && fresh.type.name === 'agent_reply'
  const plan = reply && !fresh.attrs.plan ? old.attrs.plan : ''
  const team = reply && !fresh.attrs.team ? old.attrs.team : ''
  const attrs = id || plan || team ? { ...fresh.attrs, ...(id ? { id } : {}), ...(plan ? { plan } : {}), ...(team ? { team } : {}) } : fresh.attrs
  return fresh.isText ? fresh : fresh.type.create(attrs, Fragment.fromArray(children), fresh.marks)
}

/** old（被替换的那段顶层块）和 fresh（新解析出来的顶层块）配对，返回带上 old 的 id 的 fresh。
 *  forceFirst：只替换了一个块时（源码模式写回里配对上的改动块）它就是同一个块，新内容的第一块无条件继承旧块的 id（标题改成正文也是它） */
export function carryBlockIds(old: Fragment, fresh: Fragment, opts: { forceFirst?: boolean } = {}): Fragment {
  const a: PMNode[] = []
  const b: PMNode[] = []
  old.forEach((n) => a.push(n))
  fresh.forEach((n) => b.push(n))
  const out = [...b]
  const used = new Set<number>()

  // 1) LCS：内容相同的块对上
  const ka = a.map(keyOf)
  const kb = b.map(keyOf)
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = ka[i] === kb[j] && sameIgnoringIds(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (ka[i] === kb[j] && sameIgnoringIds(a[i]!, b[j]!)) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  for (const [i, j] of pairs) {
    out[j] = withIdsFrom(a[i]!, b[j]!)
    used.add(j)
  }

  // 2) 夹在锚点之间、数量与类型都一一对应的空隙（改了几个字的块），按位置接上
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [a.length, b.length]]
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [ai, bi] = anchors[k]!
    const [aj, bj] = anchors[k + 1]!
    const oldGap = a.slice(ai + 1, aj)
    const newGap = b.slice(bi + 1, bj)
    if (oldGap.length === 0 || oldGap.length !== newGap.length) continue
    if (!oldGap.every((n, x) => n.type === newGap[x]!.type)) continue
    oldGap.forEach((n, x) => {
      const j = bi + 1 + x
      out[j] = withIdsFrom(n, b[j]!)
      used.add(j)
    })
  }

  // 3) 单块替换：第一块无条件继承旧块的 id
  if (opts.forceFirst && a.length === 1 && b.length > 0 && !used.has(0)) out[0] = withIdsFrom(a[0]!, b[0]!, true)
  return Fragment.fromArray(out)
}
