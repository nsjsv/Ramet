/* ---------- unified diff → 可画的行 ----------
 * 输入是 `git diff` 的原样输出（connector 只读取，不加工）。只留读 diff 要看的东西：
 *   - hunk 头（@@ -a,b +c,d @@ 上下文）→ 一行淡色分隔，并重置新旧行号；
 *   - 上下文 / 新增 / 删除行 → 带旧、新行号；
 *   - 文件级的说明（new file mode / deleted file mode / rename / Binary files … differ / \ No newline）→ note 行；
 *   - diff --git / index / --- / +++ 这些头不画（路径面板标题里已经有）。
 * 多个文件拼在一起的 diff 也能解析：每遇到 `diff --git` 就回到「文件头」状态。 */

export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx' | 'add' | 'del'; text: string; old?: number; new?: number }
  | { kind: 'note'; text: string }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

const NOTES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^new file mode/, () => '新文件'],
  [/^deleted file mode/, () => '已删除的文件'],
  [/^rename from (.*)$/, (m) => `重命名自 ${m[1]}`],
  [/^Binary files .* differ$/, () => '二进制文件有改动，不显示内容'],
  [/^old mode (\d+)$/, (m) => `权限 ${m[1]} →`],
  [/^new mode (\d+)$/, (m) => `${m[1]}`],
]

export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  if (!text) return out
  let inHunk = false
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    const hunk = HUNK.exec(raw)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      out.push({ kind: 'hunk', text: raw.replace(/^@@ [^@]*@@ ?/, '').trim() })
      continue
    }
    if (!inHunk) {
      for (const [re, label] of NOTES) {
        const m = re.exec(raw)
        if (m) {
          out.push({ kind: 'note', text: label(m) })
          break
        }
      }
      continue
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), new: newNo++ })
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: oldNo++ })
    else if (raw.startsWith('\\')) out.push({ kind: 'note', text: '文件末尾没有换行' })
    else if (raw.startsWith(' ')) out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ })
    else if (raw === '') continue // 结尾的空行（split 的产物）
  }
  return out
}

/** 增 / 删行数（改动列表和 diff 头的摘要用） */
export function diffStat(lines: readonly DiffLine[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of lines) {
    if (l.kind === 'add') add++
    else if (l.kind === 'del') del++
  }
  return { add, del }
}
