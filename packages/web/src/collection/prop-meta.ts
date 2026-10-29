/* ---------- 属性类型的界面元数据与输入解析（纯函数，表格 / 行页面属性区 / 工具栏共用） ----------
 * 值的解读与校验不在这里（唯一入口是 @ramet/shared/collection-model 的 readValue / validateValue）；
 * 这里只管「人敲的字 → 要写的值」与「值 → 显示的字」，以及类型的图标与缺省列宽。 */
import { COLOR_NAMES, type ColorName } from '@ramet/shared/md-dialect'
import { isUnsafeUrl, timeMs, TITLE_PROP_ID, type CollectionProp, type CollectionView, type PropType } from '@ramet/shared/collection-model'
import type { IconName } from '../icons'

/** 新建属性菜单里的类型顺序 */
export const TYPE_ORDER: readonly PropType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'person',
  'created_time',
  'edited_time',
]

export const TYPE_ICON: Record<PropType, IconName> = {
  text: 'text',
  number: 'hash',
  select: 'select-one',
  multi_select: 'tags',
  status: 'status',
  date: 'calendar',
  checkbox: 'checkbox',
  url: 'link',
  person: 'user',
  created_time: 'clock',
  edited_time: 'clock',
}

/** 「名称」列的图标 */
export const TITLE_ICON: IconName = 'text'

/** 值由系统生成、不能编辑的类型 */
export function isComputed(type: PropType): boolean {
  return type === 'created_time' || type === 'edited_time'
}

/** 列宽：视图里存过就用它，否则按类型给缺省 */
export function columnWidth(view: CollectionView, prop: CollectionProp): number {
  const saved = view.widths[prop.id]
  if (saved !== undefined) return saved
  if (prop.id === TITLE_PROP_ID) return 280
  if (prop.type === 'checkbox') return 100
  if (prop.type === 'text' || prop.type === 'url' || prop.type === 'multi_select' || prop.type === 'person') return 200
  return 160
}

/** 数字输入：空 = 清空（null）；认不出 = undefined（不写）。允许千分位逗号与首尾空白 */
export function parseNumberInput(text: string): number | null | undefined {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return null
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 链接值 → 可点的地址：没写协议的补 https://；危险协议（javascript: 等）不给链接 */
export function hrefOf(url: string): string | null {
  const t = url.trim()
  if (!t || isUnsafeUrl(t)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t
  return `https://${t}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 创建 / 编辑时间的显示：本地时区的「YYYY-MM-DD HH:mm」；认不出原样显示 */
export function formatStamp(stamp: string): string {
  const ms = timeMs(stamp)
  if (!Number.isFinite(ms)) return stamp
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 新选项的颜色：挑一个这个属性还没用过的（都用过就按个数轮转） */
export function nextColor(used: readonly ColorName[]): ColorName {
  const free = COLOR_NAMES.find((c) => c !== 'gray' && !used.includes(c))
  return free ?? COLOR_NAMES[used.length % COLOR_NAMES.length] ?? 'gray'
}

/** 把 id 插到列表（已去掉它）的第 index 位：显示顺序 / 排序条件的重排共用 */
export function moveTo<T>(list: readonly T[], item: T, index: number): T[] {
  const rest = list.filter((x) => x !== item)
  const i = Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, i), item, ...rest.slice(i)]
}
