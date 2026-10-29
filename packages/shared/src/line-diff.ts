/* ---------- 行级 diff（过程页「修改」步骤的渲染、run-tally 的增减行数） ----------
 * 旧文 / 新文按行做 LCS，得到未变 / 删除 / 新增三种行；长段未变的行折成上下文 + 「… N 行未变」。
 * 行数乘积超过 MAX_CELLS 不跑 LCS（O(n·m) 会卡页面），退化成整段删加整段增，照样能看，只是不对齐。 */

export type DiffLine = { t: ' ' | '+' | '-'; s: string } | { t: '…'; n: number }

const MAX_CELLS = 4_000_000

/** 折叠时每段未变区保留的上下文行数 */
export const DIFF_CONTEXT = 3

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop() // 结尾换行不算一行
  return lines
}

/** 原始逐行 diff（不折叠） */
export function lineDiff(oldText: string, newText: string): Array<{ t: ' ' | '+' | '-'; s: string }> {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // 掐头去尾的相同行不进 LCS 表：常见的小改动只算中间一小块
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out: Array<{ t: ' ' | '+' | '-'; s: string }> = a.slice(0, head).map((s) => ({ t: ' ', s }))
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length * y.length > MAX_CELLS) {
    for (const s of x) out.push({ t: '-', s })
    for (const s of y) out.push({ t: '+', s })
  } else {
    // dp[i][j] = x[i..] 与 y[j..] 的 LCS 长度（一维滚动不好回溯，这里块已经掐过头尾，直接二维）
    const w = y.length + 1
    const dp = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        out.push({ t: ' ', s: x[i]! })
        i++
        j++
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        out.push({ t: '-', s: x[i++]! })
      } else {
        out.push({ t: '+', s: y[j++]! })
      }
    }
    while (i < x.length) out.push({ t: '-', s: x[i++]! })
    while (j < y.length) out.push({ t: '+', s: y[j++]! })
  }
  for (const s of a.slice(a.length - tail)) out.push({ t: ' ', s })
  return out
}

/** 折叠长段未变行：每段改动前后各留 DIFF_CONTEXT 行，其余折成一条「… N 行未变」 */
export function foldDiff(lines: ReadonlyArray<{ t: ' ' | '+' | '-'; s: string }>, context = DIFF_CONTEXT): DiffLine[] {
  const keep = lines.map(() => false)
  lines.forEach((line, i) => {
    if (line.t === ' ') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: DiffLine[] = []
  let skipped = 0
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: '…', n: skipped })
      skipped = 0
      out.push(line)
    } else {
      skipped++
    }
  })
  if (skipped) out.push({ t: '…', n: skipped })
  return out
}
