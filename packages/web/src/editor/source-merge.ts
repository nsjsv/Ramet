// ---------- 源码模式写回：顶层块级三方合并 ----------
// 三份输入：
//   base       上次同步时文档里进了源码的顶层块（带 id 与全部 attrs）；
//   baseParsed 上次同步时的源码文本经同一解析管线的结果，与 base 逐个对应（alignBase 校验）；
//   user       用户现在的源码文本的解析结果。
// baseParsed 与 user 出自同一管线、都没有 id，没改的块严格相等（Node.eq），用 LCS 找出没改的块（锚点）。
// 锚点之间先从左、再从右按「同类型」配对 = 改了的块（保住身份），剩下的旧块 = 删除、新块 = 新增。
// 落到当前文档（可能已含远端同期改动）时一律按块 id 定位（y-prosemirror 远端改动整篇替换，位置映射不可用）：
//   改了的块原位替换（远端删了就插回来）；新块插在用户顺序里上一个落定块之后；没改的块不碰，
//   所以远端同期改的其它块保留，远端删掉而本端没改的块不复活。
// 改了的块：id 与嵌套列表项 id 经 carryBlockIds 带过去；顶层 attrs 以旧块为底，只覆盖用户在 markdown 里真改了的键
// （baseParsed 到 user 之间变了的），markdown 表达不了的属性（发言人、列宽、运行信息……）因此保留。纯函数，不碰视图。

import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'
import { carryBlockIds } from './block-carry'

export type MergeOp =
  | { t: 'keep'; id: string }
  | { t: 'edit'; id: string; node: PMNode }
  | { t: 'insert'; node: PMNode }
  | { t: 'delete'; id: string }

const idOf = (node: PMNode): string => (typeof node.attrs.id === 'string' ? node.attrs.id : '')

/** base 与 baseParsed 是否逐个对应（数量、类型一致，base 每块有唯一 id）。返回第一个对不上的下标，对得上 = -1 */
export function alignBase(base: readonly PMNode[], parsed: readonly PMNode[]): number {
  const seen = new Set<string>()
  const n = Math.max(base.length, parsed.length)
  for (let i = 0; i < n; i++) {
    const a = base[i]
    const b = parsed[i]
    if (!a || !b || a.type !== b.type) return i
    const id = idOf(a)
    if (!id || seen.has(id)) return i
    seen.add(id)
  }
  return -1
}

function attrEq(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** 改了的块：带上旧块的 id（含嵌套），顶层 attrs 只覆盖用户真改了的键 */
function editedNode(old: PMNode, oldParsed: PMNode, fresh: PMNode): PMNode {
  const carried = carryBlockIds(Fragment.from(old), Fragment.from(fresh), { forceFirst: true }).firstChild ?? fresh
  const attrs: Record<string, unknown> = { ...old.attrs }
  for (const key of Object.keys(fresh.attrs)) {
    if (key !== 'id' && !attrEq(oldParsed.attrs[key], fresh.attrs[key])) attrs[key] = fresh.attrs[key]
  }
  return fresh.type.create(attrs, carried.content, fresh.marks)
}

/** baseParsed 与 user 的 LCS 锚点（严格相等的块），按顺序。掐头去尾的相同块不进 DP 表 */
function anchorsOf(a: readonly PMNode[], b: readonly PMNode[]): Array<[number, number]> {
  let head = 0
  while (head < a.length && head < b.length && a[head]!.eq(b[head]!)) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.eq(b[b.length - 1 - tail]!)) tail++
  const out: Array<[number, number]> = []
  for (let i = 0; i < head; i++) out.push([i, i])
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i]!.eq(y[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i]!.eq(y[j]!)) {
      out.push([head + i, head + j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  for (let k = tail; k > 0; k--) out.push([a.length - k, b.length - k])
  return out
}

/** 合并计划（用户文本顺序）。前提：alignBase(base, baseParsed) === -1 */
export function planMerge(base: readonly PMNode[], baseParsed: readonly PMNode[], user: readonly PMNode[]): MergeOp[] {
  const ops: MergeOp[] = []
  const anchors: Array<[number, number]> = [...anchorsOf(baseParsed, user), [baseParsed.length, user.length]]
  let i = 0
  let j = 0
  for (const [ai, bj] of anchors) {
    // 空隙 old [i, ai) / new [j, bj)：左右两头同类型的配成「改了的块」，中间剩下的是删除 / 新增
    let lo = i
    let ln = j
    let ro = ai
    let rn = bj
    const left: MergeOp[] = []
    const right: MergeOp[] = []
    while (lo < ro && ln < rn && baseParsed[lo]!.type === user[ln]!.type) {
      left.push({ t: 'edit', id: idOf(base[lo]!), node: editedNode(base[lo]!, baseParsed[lo]!, user[ln]!) })
      lo++
      ln++
    }
    while (lo < ro && ln < rn && baseParsed[ro - 1]!.type === user[rn - 1]!.type) {
      right.unshift({ t: 'edit', id: idOf(base[ro - 1]!), node: editedNode(base[ro - 1]!, baseParsed[ro - 1]!, user[rn - 1]!) })
      ro--
      rn--
    }
    ops.push(...left)
    for (let k = lo; k < ro; k++) ops.push({ t: 'delete', id: idOf(base[k]!) })
    for (let k = ln; k < rn; k++) ops.push({ t: 'insert', node: user[k]! })
    ops.push(...right)
    if (ai < base.length) ops.push({ t: 'keep', id: idOf(base[ai]!) })
    i = ai + 1
    j = bj + 1
  }
  return ops
}

/** 计划里有没有要写的（全是 keep = 用户没改出任何结构 / 内容差异） */
export function hasChanges(ops: readonly MergeOp[]): boolean {
  return ops.some((op) => op.t !== 'keep')
}

function findTop(doc: PMNode, id: string): { pos: number; node: PMNode } | null {
  let hit: { pos: number; node: PMNode } | null = null
  doc.forEach((node, pos) => {
    if (!hit && idOf(node) === id) hit = { pos, node }
  })
  return hit
}

/** 把合并计划落到事务的当前文档上（按 id 定位，见文件头）。删除放最后，中途文档不会被删空（doc 至少要有一个块） */
export function applyMerge(tr: Transaction, ops: readonly MergeOp[]): void {
  const present = new Set<string>()
  tr.doc.forEach((node) => present.add(idOf(node)))
  let anchor: string | null = null // 用户顺序里上一个落定的块（文档里在的）
  let cursor: number | null = null // 刚插入的块的末尾（连续插入直接接着放）
  const insertAt = (): number => {
    if (cursor !== null) return cursor
    const hit = anchor ? findTop(tr.doc, anchor) : null
    return hit ? hit.pos + hit.node.nodeSize : 0
  }
  for (const op of ops) {
    if (op.t === 'keep') {
      if (present.has(op.id)) {
        anchor = op.id
        cursor = null
      }
    } else if (op.t === 'edit') {
      const hit = findTop(tr.doc, op.id)
      if (hit) {
        tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, op.node)
        anchor = op.id
        cursor = null
      } else {
        const pos = insertAt()
        tr.insert(pos, op.node)
        cursor = pos + op.node.nodeSize
      }
    } else if (op.t === 'insert') {
      const pos = insertAt()
      tr.insert(pos, op.node)
      cursor = pos + op.node.nodeSize
    }
  }

  const deletes = new Set(ops.flatMap((op) => (op.t === 'delete' ? [op.id] : [])))
  if (!deletes.size) return
  // 要删光了：先垫一个空段落（源码里看不见，补 id 插件会给它 id）
  let remaining = 0
  tr.doc.forEach((node) => {
    if (!deletes.has(idOf(node))) remaining++
  })
  const paragraph = tr.doc.type.schema.nodes.paragraph
  if (!remaining && paragraph) tr.insert(0, paragraph.create())
  for (const id of deletes) {
    const hit = findTop(tr.doc, id)
    if (hit) tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
  }
}

/** 退路（base 与其 markdown 对不上时）：整篇替换，块 id 尽量跟着内容走 */
export function applyWhole(tr: Transaction, user: readonly PMNode[]): void {
  const paragraph = tr.doc.type.schema.nodes.paragraph
  const fresh = user.length || !paragraph ? Fragment.fromArray([...user]) : Fragment.from(paragraph.create())
  tr.replaceWith(0, tr.doc.content.size, carryBlockIds(tr.doc.content, fresh))
}
