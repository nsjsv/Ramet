/* ---------- 属性定义与视图的写：直接改集合文档 page:<cid> 的 Y.Map('collection') ----------
 * 形状与并发语义见 @ramet/shared/collection-model 的 PropJson / ViewJson 与服务端 collections/init-doc.ts：
 * props / 每个属性 / options / views / 每个视图 / widths 是 Y.Map（各字段各自后写为准、两人同时加选项能合并），
 * 选项本身、筛选、排序、shown 是普通值，整体替换。顺序一律写小数 pos，不用 Y.Array 搬移（并发重排会复制条目）。
 * 读一律经 parseCollection（坏数据容错），这里只负责写；每个操作一个事务（一次撤销 / 一条协同增量）。
 * viewer 的连接服务端只读，写了也不会生效，入口的禁用在界面上做。 */
import * as Y from 'yjs'
import {
  COLLECTION_VERSION,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  NAME_MAX,
  newShortId,
  newStatusOptions,
  newView,
  parseCollection,
  pickView,
  TITLE_PROP_ID,
  typeHasOptions,
  type CollectionLayout,
  type CollectionProp,
  type CollectionSchema,
  type CollectionView,
  type Filter,
  type OptionJson,
  type PropType,
  type Sort,
  type StatusGroup,
} from '@ramet/shared/collection-model'
import type { ColorName } from '@ramet/shared/md-dialect'

type YMap = Y.Map<unknown>

function rootOf(doc: Y.Doc): YMap {
  return doc.getMap<unknown>('collection')
}

function mapAt(parent: YMap | null, key: string): YMap | null {
  const value = parent?.get(key)
  return value instanceof Y.Map ? (value as YMap) : null
}

/** 取子 map，没有（或被写成了别的东西）就建一个：先挂进父 map 再填，同 init-doc */
function ensureMap(parent: YMap, key: string): YMap {
  const found = mapAt(parent, key)
  if (found) return found
  const map = new Y.Map<unknown>()
  parent.set(key, map)
  return map
}

function readSchema(doc: Y.Doc): CollectionSchema {
  return parseCollection(rootOf(doc).toJSON())
}

function clipName(name: string): string {
  const trimmed = name.trim()
  return [...trimmed].length > NAME_MAX ? [...trimmed].slice(0, NAME_MAX).join('') : trimmed
}

/** 所有 id（属性 / 选项 / 视图）都从这里取：同一集合里避开已有的，撞号会覆盖别的条目 */
function takenIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>([TITLE_PROP_ID])
  const schema = readSchema(doc)
  for (const prop of schema.props) {
    ids.add(prop.id)
    for (const option of prop.options) ids.add(option.id)
  }
  for (const view of schema.views) ids.add(view.id)
  return ids
}

/** 把一项排到「其余各项排好序后的第 index 个」：取前后两项 pos 的中点（两端各外扩 1） */
export function posAt(sorted: readonly number[], index: number): number {
  const i = Math.max(0, Math.min(index, sorted.length))
  const lo = sorted[i - 1]
  const hi = sorted[i]
  if (lo === undefined) return hi === undefined ? 0 : hi - 1
  if (hi === undefined) return lo + 1
  return lo + (hi - lo) / 2
}

const nextPos = (positions: readonly number[]): number => (positions.length === 0 ? 0 : Math.max(...positions) + 1)

function tx(doc: Y.Doc, fn: () => void): void {
  doc.transact(() => {
    const root = rootOf(doc)
    if (root.get('v') === undefined) root.set('v', COLLECTION_VERSION)
    fn()
  })
}

// ---------- 属性 ----------

/** 加一个属性，排在最后；状态带三个默认选项（同组名），单选 / 多选是空选项表。返回新属性 id */
export function addProp(doc: Y.Doc, name: string, type: PropType): string {
  const id = newShortId(takenIds(doc))
  const pos = nextPos(readSchema(doc).props.map((p) => p.pos))
  tx(doc, () => {
    const prop = new Y.Map<unknown>()
    ensureMap(rootOf(doc), 'props').set(id, prop)
    prop.set('name', clipName(name))
    prop.set('type', type)
    prop.set('pos', pos)
    if (typeHasOptions(type)) fillOptions(ensureMap(prop, 'options'), type)
  })
  return id
}

function fillOptions(options: YMap, type: PropType): void {
  if (type !== 'status' || options.size > 0) return
  for (const [optionId, option] of Object.entries(newStatusOptions())) options.set(optionId, option)
}

export function renameProp(doc: Y.Doc, propId: string, name: string): void {
  tx(doc, () => mapAt(mapAt(rootOf(doc), 'props'), propId)?.set('name', clipName(name)))
}

/** 改类型只改 type：各行的值不动，按新类型重新解读（读不了的显示为空，改回原类型还在）。
 *  换成有选项的类型时补选项表（状态没有选项就给三个默认的）；原有的选项保留（改回去还在） */
export function setPropType(doc: Y.Doc, propId: string, type: PropType): void {
  tx(doc, () => {
    const prop = mapAt(mapAt(rootOf(doc), 'props'), propId)
    if (!prop) return
    prop.set('type', type)
    if (typeHasOptions(type)) fillOptions(ensureMap(prop, 'options'), type)
  })
}

/** 删属性：只摘定义。各行文档里的值保留，视图里引用它的设置由 parseCollection 忽略 —— 恢复集合页的版本后都回来 */
export function deleteProp(doc: Y.Doc, propId: string): void {
  tx(doc, () => mapAt(rootOf(doc), 'props')?.delete(propId))
}

/** 把属性挪到其余属性里的第 index 位 */
export function moveProp(doc: Y.Doc, propId: string, index: number): void {
  tx(doc, () => {
    const prop = mapAt(mapAt(rootOf(doc), 'props'), propId)
    if (!prop) return
    const others = readSchema(doc).props.filter((p) => p.id !== propId).map((p) => p.pos)
    prop.set('pos', posAt(others, index))
  })
}

// ---------- 选项 ----------

export type OptionPatch = { name?: string; color?: ColorName; group?: StatusGroup }

/** 加一个选项，排在最后（状态的选项排在所给组的最后）。返回新选项 id；属性不存在 = null */
export function addOption(doc: Y.Doc, propId: string, name: string, color: ColorName, group?: StatusGroup): string | null {
  const prop = readSchema(doc).props.find((p) => p.id === propId)
  if (!prop) return null
  const id = newShortId(takenIds(doc))
  const option: OptionJson = { name: clipName(name), color, pos: nextPos(prop.options.map((o) => o.pos)) }
  if (prop.type === 'status') option.group = group ?? 'todo'
  tx(doc, () => {
    const map = mapAt(mapAt(rootOf(doc), 'props'), propId)
    if (map) ensureMap(map, 'options').set(id, option)
  })
  return id
}

/** 改选项的名字 / 颜色 / 状态组（未给的字段沿用） */
export function updateOption(doc: Y.Doc, propId: string, optionId: string, patch: OptionPatch): void {
  const next: Partial<OptionJson> = {}
  if (patch.name !== undefined) next.name = clipName(patch.name)
  if (patch.color !== undefined) next.color = patch.color
  if (patch.group !== undefined) next.group = patch.group
  writeOption(doc, propId, optionId, next)
}

/** 删选项：行里存着它的值读成空（readValue 认不出已删的选项），不去改各行文档 */
export function deleteOption(doc: Y.Doc, propId: string, optionId: string): void {
  tx(doc, () => mapAt(mapAt(mapAt(rootOf(doc), 'props'), propId), 'options')?.delete(optionId))
}

/** 把选项挪到第 index 位。状态的选项在组内排（给了 group 就先换组）：index 是目标组里其余选项中的位置 */
export function moveOption(doc: Y.Doc, propId: string, optionId: string, index: number, group?: StatusGroup): void {
  const prop = readSchema(doc).props.find((p) => p.id === propId)
  const self = prop?.options.find((o) => o.id === optionId)
  if (!prop || !self) return
  const targetGroup = prop.type === 'status' ? (group ?? self.group ?? 'todo') : undefined
  const others = prop.options
    .filter((o) => o.id !== optionId && (targetGroup === undefined || o.group === targetGroup))
    .map((o) => o.pos)
  writeOption(doc, propId, optionId, { pos: posAt(others, index), ...(targetGroup ? { group: targetGroup } : {}) })
}

/** 选项是普通值：整体替换（读出现值、合上改动再写回），不存在的选项不建 */
function writeOption(doc: Y.Doc, propId: string, optionId: string, patch: Partial<OptionJson>): void {
  tx(doc, () => {
    const options = mapAt(mapAt(mapAt(rootOf(doc), 'props'), propId), 'options')
    const current = options?.get(optionId)
    if (!options || typeof current !== 'object' || current === null) return
    options.set(optionId, { ...(current as Record<string, unknown>), ...patch })
  })
}

// ---------- 视图 ----------

/** 能用来分组（看板分列）的属性：状态与单选，按属性顺序 */
export function groupChoices(schema: CollectionSchema): CollectionProp[] {
  return schema.props.filter((p) => p.type === 'status' || p.type === 'select')
}

/** 看板缺省按哪个属性分列：第一个状态 / 单选属性；没有 = null（看板画空状态，让人选或去建） */
export function boardGroupBy(schema: CollectionSchema): string | null {
  return groupChoices(schema)[0]?.id ?? null
}

/** 新建视图，排在最后。看板按 boardGroupBy 分组。返回新视图 id */
export function addView(doc: Y.Doc, name: string, layout: CollectionLayout): string {
  const schema = readSchema(doc)
  const id = newShortId(takenIds(doc))
  const groupBy = layout === 'board' ? boardGroupBy(schema) : null
  const json = newView(clipName(name), layout, nextPos(schema.views.map((v) => v.pos)), groupBy)
  tx(doc, () => {
    const view = new Y.Map<unknown>()
    ensureMap(rootOf(doc), 'views').set(id, view)
    const { widths, ...settings } = json
    for (const [key, value] of Object.entries(settings)) view.set(key, value)
    const widthMap = ensureMap(view, 'widths')
    for (const [propId, width] of Object.entries(widths)) widthMap.set(propId, width)
  })
  return id
}

/** 换布局（表格 ↔ 看板）：其余设置原样留着。切到看板而还没分组时补上 boardGroupBy（同 addView） */
export function setLayout(doc: Y.Doc, viewId: string, layout: CollectionLayout): void {
  const schema = readSchema(doc)
  const view = schema.views.find((v) => v.id === viewId)
  // 点的就是当前布局：不写（同值写入也会进集合页的版本历史）
  if (!view || view.layout === layout) return
  const groupBy = layout === 'board' && view.groupBy === null ? boardGroupBy(schema) : null
  tx(doc, () => {
    const map = viewMap(doc, viewId)
    if (!map) return
    map.set('layout', layout)
    if (groupBy !== null) map.set('groupBy', groupBy)
  })
}

export function renameView(doc: Y.Doc, viewId: string, name: string): void {
  tx(doc, () => viewMap(doc, viewId)?.set('name', clipName(name)))
}

/** 删视图：至少留一个（最后一个删不掉，返回 false） */
export function deleteView(doc: Y.Doc, viewId: string): boolean {
  const views = readSchema(doc).views
  if (views.length <= 1 || !views.some((v) => v.id === viewId)) return false
  tx(doc, () => mapAt(rootOf(doc), 'views')?.delete(viewId))
  return true
}

export function moveView(doc: Y.Doc, viewId: string, index: number): void {
  const others = readSchema(doc).views.filter((v) => v.id !== viewId).map((v) => v.pos)
  tx(doc, () => viewMap(doc, viewId)?.set('pos', posAt(others, index)))
}

function viewMap(doc: Y.Doc, viewId: string): YMap | null {
  return mapAt(mapAt(rootOf(doc), 'views'), viewId)
}

export function setFilter(doc: Y.Doc, viewId: string, filter: Filter): void {
  tx(doc, () => viewMap(doc, viewId)?.set('filter', { all: filter.all.map((c) => ({ ...c })) }))
}

export function setSorts(doc: Y.Doc, viewId: string, sorts: Sort[]): void {
  tx(doc, () => viewMap(doc, viewId)?.set('sorts', sorts.map((s) => ({ ...s }))))
}

/** 分组只认状态 / 单选（别的类型写进去 parseCollection 也会忽略）；null = 不分组 */
export function setGroupBy(doc: Y.Doc, viewId: string, propId: string | null): void {
  tx(doc, () => viewMap(doc, viewId)?.set('groupBy', propId))
}

/** 显示哪些属性、按什么顺序（不含恒显示的「名称」）；null = 全部按属性顺序 */
export function setShown(doc: Y.Doc, viewId: string, shown: string[] | null): void {
  tx(doc, () => viewMap(doc, viewId)?.set('shown', shown === null ? null : shown.filter((id) => id !== TITLE_PROP_ID)))
}

/** 表格列宽（含「名称」的 title 列），夹进合法区间 */
export function setWidth(doc: Y.Doc, viewId: string, propId: string, width: number): void {
  if (!Number.isFinite(width)) return
  const clamped = Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, width)))
  tx(doc, () => {
    const view = viewMap(doc, viewId)
    if (view) ensureMap(view, 'widths').set(propId, clamped)
  })
}

/** 视图实际显示的属性（按显示顺序，不含「名称」）：shown 为 null 时是全部属性按 pos */
export function shownProps(schema: CollectionSchema, view: CollectionView): string[] {
  return view.shown ?? schema.props.map((p) => p.id)
}

/** 隐藏 / 显示一列：shown 为 null 时先展开成显式列表；显示的列接在末尾 */
export function toggleShown(doc: Y.Doc, viewId: string, propId: string, on: boolean): void {
  const schema = readSchema(doc)
  const current = shownProps(schema, pickView(schema, viewId))
  if (current.includes(propId) === on) return
  setShown(doc, viewId, on ? [...current, propId] : current.filter((id) => id !== propId))
}

// ---------- 恢复版本（collection-history） ----------

/** 普通值（filter / sorts / shown / 选项…）比较：JSON 相同就算没变 */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Y.Map 的一个字段：值不同才写（没变的字段不写，别人同时改的其他字段不被覆盖，也不白出一条协同增量） */
function setIfChanged(map: YMap, key: string, next: unknown, current: unknown): void {
  // current 为 undefined = 新建的条目（或当前那条解析不出来）：每个字段都写，结构同 addProp / addView
  if (current === undefined || !sameJson(current, next)) map.set(key, next)
}

/** 取子 map；不是 Y.Map（脏数据）就换一个新的 */
function entryMap(parent: YMap, key: string): { map: YMap; fresh: boolean } {
  const found = mapAt(parent, key)
  if (found) return { map: found, fresh: false }
  const map = new Y.Map<unknown>()
  parent.set(key, map)
  return { map, fresh: true }
}

function optionJson(option: CollectionProp['options'][number]): OptionJson {
  return option.group ? { name: option.name, color: option.color, pos: option.pos, group: option.group } : { name: option.name, color: option.color, pos: option.pos }
}

function syncProp(map: YMap, prop: CollectionProp, current: CollectionProp | undefined): void {
  setIfChanged(map, 'name', prop.name, current?.name)
  setIfChanged(map, 'type', prop.type, current?.type)
  setIfChanged(map, 'pos', prop.pos, current?.pos)
  // 没有选项的类型：解析时不读它的选项表，这里也不动（改类型时留下的旧选项，改回原类型还要用）
  if (!typeHasOptions(prop.type)) return
  // 当前选项按目标类型解析后比（同一个解析器出来的，键序一致）：当前类型没有选项（比如恢复改类型之前的版本）
  // 时选项表仍在，按当前类型解析会读成空、把没变的选项全重写一遍
  const now = new Map(
    (parseCollection({ props: { [prop.id]: { ...map.toJSON(), type: prop.type } } }).props[0]?.options ?? []).map((o) => [o.id, optionJson(o)]),
  )
  const options = ensureMap(map, 'options')
  const keep = new Set(prop.options.map((o) => o.id))
  for (const id of [...options.keys()]) if (!keep.has(id)) options.delete(id)
  for (const option of prop.options) {
    const next = optionJson(option)
    if (!options.has(option.id) || !sameJson(now.get(option.id), next)) options.set(option.id, next)
  }
}

function syncView(map: YMap, view: CollectionView, current: CollectionView | undefined): void {
  const { id: _id, widths, ...settings } = view
  for (const [key, value] of Object.entries(settings)) setIfChanged(map, key, value, current?.[key as keyof typeof settings])
  const widthMap = ensureMap(map, 'widths')
  for (const key of [...widthMap.keys()]) if (!Object.hasOwn(widths, key)) widthMap.delete(key)
  for (const [key, width] of Object.entries(widths)) if (widthMap.get(key) !== width) widthMap.set(key, width)
}

/** 恢复集合页的某个版本：把属性定义与视图同步成快照里的样子（行里的值不动，删属性只删了定义，定义回来值就回来）。
 *  快照 JSON 不可信（成员能往协同文档写任何东西）：先过 parseCollection，坏条目跳过、缺字段补默认。
 *  字段级同步：快照有、当前没有的新建（结构同 addProp / addView）；都有的逐字段比，不同才写；当前有、快照没有的删掉。
 *  一个事务（一次撤销 / 一条协同增量）。标题不在这里（集合页标题编辑器写回，同文档页的恢复） */
export function restoreCollection(doc: Y.Doc, snapshot: unknown): void {
  const target = parseCollection(snapshot)
  const now = readSchema(doc)
  const nowProps = new Map(now.props.map((p) => [p.id, p]))
  const nowViews = new Map(now.views.map((v) => [v.id, v]))
  doc.transact(() => {
    const root = rootOf(doc)
    if (root.get('v') !== target.v) root.set('v', target.v)
    const props = ensureMap(root, 'props')
    const keepProps = new Set(target.props.map((p) => p.id))
    for (const id of [...props.keys()]) if (!keepProps.has(id)) props.delete(id)
    for (const prop of target.props) {
      const { map, fresh } = entryMap(props, prop.id)
      syncProp(map, prop, fresh ? undefined : nowProps.get(prop.id))
    }
    const views = ensureMap(root, 'views')
    const keepViews = new Set(target.views.map((v) => v.id))
    for (const id of [...views.keys()]) if (!keepViews.has(id)) views.delete(id)
    for (const view of target.views) {
      const { map, fresh } = entryMap(views, view.id)
      syncView(map, view, fresh ? undefined : nowViews.get(view.id))
    }
  })
}

/** 恢复行页面的某个版本时写回属性值（行文档的 Y.Map('props')）：快照里有的值不同才写，快照里没有（或为 null）的键删掉。
 *  一个事务，经协同连接记在当前用户名下；副本与集合增量由服务端投影器照常产出，这里不另写 */
export function restoreRowProps(doc: Y.Doc, snapshot: Record<string, unknown>): void {
  const map = doc.getMap<unknown>('props')
  const value = (key: string): unknown => (Object.hasOwn(snapshot, key) ? (snapshot[key] ?? null) : null)
  doc.transact(() => {
    for (const key of [...map.keys()]) if (value(key) === null) map.delete(key)
    for (const key of Object.keys(snapshot)) {
      const next = value(key)
      if (next !== null && !sameJson(map.get(key), next)) map.set(key, next)
    }
  })
}
