// ---------- 服务端写合集的定义（属性、选项、视图）：直接改合集文档 page:<cid> 的 Y.Map('collection') ----------
// 形状与并发语义同 init-doc.ts 与前端 web/src/collection/schema-ops.ts：props / 每个属性 / options / views / 每个视图 / widths 是 Y.Map，
// 选项本身、属性配置 cfg、筛选、排序、shown 是普通值，整体替换；顺序写小数 pos。读一律经 parseCollection（坏数据容错）。
// 调用方负责事务与记给谁（关联的 REST 记给用户，agent 的 edit_collection 记给 agent）。

import * as Y from 'yjs'
import { NAME_MAX, newShortId, TITLE_PROP_ID, type CollectionSchema, type OptionJson, type PropType, type ViewJson } from '@ramet/shared/collection-model'

/** 关联没起名时的缺省名 */
export const DEFAULT_RELATION_NAME = '关联'

export type PropWrite = { name: string; type: PropType; cfg?: Record<string, unknown>; options?: Record<string, OptionJson> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clipName(raw: string): string {
  const name = raw.trim()
  return [...name].length > NAME_MAX ? [...name].slice(0, NAME_MAX).join('') : name
}

/** 同一合集里已用的 id（属性 / 选项 / 视图，同客户端 schema-ops 的口径：撞号会覆盖别的条目） */
export function takenIds(schema: CollectionSchema, extra: string[] = []): Set<string> {
  const ids = new Set<string>([TITLE_PROP_ID, ...extra])
  for (const prop of schema.props) {
    ids.add(prop.id)
    for (const option of prop.options) ids.add(option.id)
  }
  for (const view of schema.views) ids.add(view.id)
  return ids
}

/** 取子 map，没有（或被写成了别的东西）就建一个：先挂进父 map 再填，同 init-doc */
function ensureMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const found = parent.get(key)
  if (found instanceof Y.Map) return found as Y.Map<unknown>
  const created = new Y.Map<unknown>()
  parent.set(key, created)
  return created
}

export function propsMap(doc: Y.Doc): Y.Map<unknown> {
  return ensureMap(doc.getMap<unknown>('collection'), 'props')
}

export function propMap(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  const prop = propsMap(doc).get(id)
  return prop instanceof Y.Map ? (prop as Y.Map<unknown>) : undefined
}

/** 一组 Y.Map 条目里最大的 pos + 1（没有 = 0） */
function nextPos(entries: Iterable<unknown>): number {
  let pos = -1
  for (const item of entries) {
    const at = item instanceof Y.Map ? item.get('pos') : isRecord(item) ? item.pos : undefined
    if (typeof at === 'number' && Number.isFinite(at)) pos = Math.max(pos, at)
  }
  return pos + 1
}

/** 加一个属性，排在最后（选项一起写进去） */
export function addPropIn(doc: Y.Doc, id: string, json: PropWrite): void {
  const props = propsMap(doc)
  const pos = nextPos(props.values())
  const prop = new Y.Map<unknown>()
  props.set(id, prop)
  prop.set('name', clipName(json.name))
  prop.set('type', json.type)
  prop.set('pos', pos)
  if (json.cfg) prop.set('cfg', json.cfg)
  if (json.options) addOptionsIn(doc, id, json.options)
}

/** 给属性加选项，接在已有选项后面（pos 按已有的往后排） */
export function addOptionsIn(doc: Y.Doc, propId: string, options: Record<string, OptionJson>): void {
  const prop = propMap(doc, propId)
  if (!prop) return
  const map = ensureMap(prop, 'options')
  let pos = nextPos(map.values())
  for (const [id, option] of Object.entries(options)) map.set(id, { ...option, pos: pos++ })
}

/** 改一个属性的配置：cfg 是普通值，按字段合并后整份写回（改类型前那个类型的配置留着）；drop 里的字段去掉 */
export function patchCfg(doc: Y.Doc, id: string, patch: Record<string, unknown>, drop: string[] = []): void {
  const prop = propMap(doc, id)
  if (!prop) return
  const current = prop.get('cfg')
  const next: Record<string, unknown> = { ...(isRecord(current) ? current : {}), ...patch }
  for (const key of drop) delete next[key]
  prop.set('cfg', next)
}

/** 加一个视图，排在最后（json.pos 不看；widths 是 Y.Map，其余是普通值） */
export function addViewIn(doc: Y.Doc, id: string, json: ViewJson): void {
  const views = ensureMap(doc.getMap<unknown>('collection'), 'views')
  const pos = nextPos(views.values())
  const view = new Y.Map<unknown>()
  views.set(id, view)
  const { widths, ...settings } = json
  for (const [key, value] of Object.entries(settings)) view.set(key, value)
  view.set('pos', pos)
  const widthMap = ensureMap(view, 'widths')
  for (const [propId, width] of Object.entries(widths)) widthMap.set(propId, width)
}

export type RelationSide = { collection: { id: string; title: string }; schema: CollectionSchema }

export type RelationPlan = { propId: string; reverseId: string | null; forward: PropWrite; reverse: PropWrite }

/** 建关联要写的两条属性：正向与反向的 id 预先定好，两侧才能互相记着对方（自关联时两条在同一个合集里，id 不能撞） */
export function relationPlan(
  self: RelationSide,
  target: RelationSide,
  input: { name?: string; twoWay?: boolean; reverseName?: string; single?: boolean },
): RelationPlan {
  const selfRelation = target.collection.id === self.collection.id
  const propId = newShortId(takenIds(self.schema))
  const reverseId = input.twoWay === true ? newShortId(takenIds(target.schema, selfRelation ? [propId] : [])) : null
  return {
    propId,
    reverseId,
    forward: {
      name: clipName(input.name ?? '') || target.collection.title || DEFAULT_RELATION_NAME,
      type: 'relation',
      cfg: { target: target.collection.id, reverse: reverseId, single: input.single === true },
    },
    reverse: { name: clipName(input.reverseName ?? '') || self.collection.title || DEFAULT_RELATION_NAME, type: 'relation', cfg: { target: self.collection.id, mirror: propId } },
  }
}
