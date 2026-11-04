/* ---------- 下拉列表的键盘导航（纯函数，ui/Select.tsx 用）----------
 * 下标都是选项数组里的位置；-1 = 没有可落的项。禁用项一律跳过，到头不回绕（同系统下拉）。 */

export interface NavOption {
  label: string
  disabled?: boolean
}

/** 从 from 往 dir 方向找下一个可选项；没有就停在原处（from 本身不可选时退到 -1） */
export function stepIndex(options: readonly NavOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
    if (!options[i]?.disabled) return i
  }
  return from >= 0 && from < options.length && !options[from]?.disabled ? from : -1
}

/** 第一个 / 最后一个可选项 */
export function edgeIndex(options: readonly NavOption[], edge: 'first' | 'last'): number {
  return edge === 'first' ? stepIndex(options, -1, 1) : stepIndex(options, options.length, -1)
}

/** 打开列表时落在哪：当前值可选就是它，否则第一个可选项 */
export function initialIndex(options: readonly NavOption[], current: number): number {
  return current >= 0 && !options[current]?.disabled ? current : edgeIndex(options, 'first')
}

/** 连打字母跳转：query 是 500ms 内敲下的字符累加。
 *  同一个字母连按（「aaa」）= 在以它开头的项之间轮换，从 from 的下一项找起；
 *  否则按前缀找，从 from 本身找起（继续往下打字时，当前项仍匹配就不动）。不分大小写，找不到返回 -1 */
export function matchIndex(options: readonly NavOption[], from: number, query: string): number {
  const q = query.toLocaleLowerCase()
  if (!q) return -1
  const repeated = [...q].every((ch) => ch === q[0])
  const prefix = repeated ? q[0]! : q
  const start = repeated ? from + 1 : Math.max(from, 0)
  const n = options.length
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    const o = options[i]
    if (o && !o.disabled && o.label.toLocaleLowerCase().startsWith(prefix)) return i
  }
  return -1
}
