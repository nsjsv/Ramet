// ---------- 集合的计算值：关联、反向关联、汇总（服务端唯一算它们的地方） ----------
// 关联要读别的集合的行，客户端没有，所以这三类值只在服务端算好放进 row.computed，两端的筛选 / 排序 / 增量都读它：
//   · 正向关联：行文档里存的对方行 id 列表，去掉已不在目标集合的（进了回收站、挪走了），按目标集合的手动顺序排
//   · 反向关联：不存值。源集合里镜像的那个正向关联含这一行的那些行（由源集合的副本倒排），按源集合的手动顺序排。
//     一对双向关联只有正向那一侧存值：两侧各存一份再互相同步，并发编辑时会分叉（A 侧加、B 侧同时删），倒排没有这个问题
//   · 汇总：沿一个关联，对关联到的行的某个属性做统计（@ramet/shared 的 rollupValue，计算口径只有那一份）
// 有效性（relationOf）：另一端是活集合、与本集合同一个空间；反向关联还要求镜像的正向关联仍指回本集合、且记着自己是它的反向。
// 失效的关联读成空、refs 标 broken；失效时不给对方集合的名字（它可能已挪到看的人进不去的空间）。
// 每次计算里每个依赖集合只读一次（活行 + 副本 + 元数据全量进内存，与窗口查询同一个量级）。

import type { Pool } from 'pg'
import type * as Y from 'yjs'
import {
  idList,
  isReverseRelation,
  isRollupTarget,
  readValue,
  rollupFns,
  rollupValue,
  rowValue,
  TITLE_PROP,
  TITLE_PROP_ID,
  type CollectionProp,
  type CollectionRefs,
  type CollectionRow,
  type CollectionSchema,
  type RollupFn,
} from '@ramet/shared/collection-model'
import { compareRows } from '@ramet/shared/collection-query'
import { ensureNumbers, memberRows, readSchema, selectCollection, type CollectionPage } from './store.js'

export type LiveDoc = (docName: string) => Y.Doc | undefined

/** 关联的一端：本集合的关联属性 + 另一端的集合；反向关联另带它镜像的正向关联（在另一端集合里） */
export type Link = { prop: CollectionProp; other: CollectionPage; mirror?: CollectionProp }
type Roll = { link: Link; target: CollectionProp; fn: RollupFn }
/** 另一端集合的行（按手动顺序排好）：按 id 查、按顺序排 */
type Side = { rows: CollectionRow[]; byId: Map<string, CollectionRow>; rank: Map<string, number> }

const NO_SCHEMA: CollectionSchema = { v: 1, props: [], views: [] }

/** 集合里有没有要服务端算的属性（关联、汇总）。没有的集合不碰任何别的集合，行的形状也与之前一样 */
export function hasComputed(schema: CollectionSchema): boolean {
  return schema.props.some((prop) => prop.type === 'relation' || prop.type === 'rollup')
}

/** 依赖集合的数据：同一次计算里每个集合只取一次（并发的取用共用同一个 Promise） */
class Deps {
  private readonly pages = new Map<string, Promise<CollectionPage | null>>()
  private readonly schemas = new Map<string, Promise<CollectionSchema>>()
  private readonly sides = new Map<string, Promise<Side>>()

  constructor(
    private readonly pool: Pool,
    private readonly getLiveDoc: LiveDoc | undefined,
    self: CollectionPage,
    schema: CollectionSchema,
    /** 本集合的全部活行（窗口查询已经取了），自关联时直接用 */
    all?: CollectionRow[],
  ) {
    this.pages.set(self.id, Promise.resolve(self))
    this.schemas.set(self.id, Promise.resolve(schema))
    if (all) this.sides.set(self.id, Promise.resolve(sideOf(all)))
  }

  page(id: string): Promise<CollectionPage | null> {
    return memo(this.pages, id, () => selectCollection(this.pool, id))
  }

  schema(id: string): Promise<CollectionSchema> {
    return memo(this.schemas, id, () => readSchema(this.pool, id, this.getLiveDoc))
  }

  side(id: string): Promise<Side> {
    return memo(this.sides, id, async () => sideOf(await memberRows(this.pool, id)))
  }
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key)
  if (!hit) {
    hit = load()
    cache.set(key, hit)
  }
  return hit
}

function sideOf(rows: CollectionRow[]): Side {
  // 手动顺序与窗口查询同一个比较（position NULLS LAST、创建时间、id）
  const sorted = [...rows].sort((a, b) => compareRows(a, b, [], NO_SCHEMA))
  return { rows: sorted, byId: new Map(sorted.map((row) => [row.id, row])), rank: new Map(sorted.map((row, i) => [row.id, i])) }
}

async function resolveLink(deps: Deps, self: CollectionPage, prop: CollectionProp): Promise<Link | null> {
  const target = prop.cfg.target
  if (prop.type !== 'relation' || !target || self.space_id === null) return null
  const other = await deps.page(target)
  if (!other || other.space_id !== self.space_id) return null
  if (!isReverseRelation(prop)) return { prop, other }
  // 反向关联：镜像的正向关联还在、仍指回本集合、记着的反向就是自己。只看 mirror 的话，关掉双向时删反向属性那一步
  // 失败留下的旧反向属性会和之后新建的那个显示一模一样的值
  const mirror = (await deps.schema(other.id)).props.find((p) => p.id === prop.cfg.mirror)
  if (!mirror || mirror.type !== 'relation' || isReverseRelation(mirror) || mirror.cfg.target !== self.id || mirror.cfg.reverse !== prop.id) {
    return null
  }
  return { prop, other, mirror }
}

async function resolveRollup(deps: Deps, prop: CollectionProp, links: Map<string, Link | null>): Promise<Roll | null> {
  const { relation, prop: targetId, fn } = prop.cfg
  const link = relation ? links.get(relation) : undefined
  if (!link || !targetId || !fn) return null
  const target = targetId === TITLE_PROP_ID ? TITLE_PROP : (await deps.schema(link.other.id)).props.find((p) => p.id === targetId)
  // 目标不能是关联 / 汇总（不做跨集合的计算链），计算方式要适用于目标的当前类型
  if (!target || !isRollupTarget(target.type) || !rollupFns(target.type).includes(fn)) return null
  return { link, target, fn }
}

/** 一个关联属性此刻有没有效（REST 写关联值、改关联定义时用）。无效 = null */
export async function relationOf(
  pool: Pool,
  getLiveDoc: LiveDoc | undefined,
  collection: CollectionPage,
  schema: CollectionSchema,
  prop: CollectionProp,
): Promise<Link | null> {
  return resolveLink(new Deps(pool, getLiveDoc, collection, schema), collection, prop)
}

/** 正向关联：存的 id 列表里还在目标集合的那些，按目标集合的手动顺序 */
function forwardIds(row: CollectionRow, prop: CollectionProp, side: Side): string[] {
  const ids = (idList(readValue(prop, row.props[prop.id])) ?? []).filter((id) => side.byId.has(id))
  return ids.sort((a, b) => side.rank.get(a)! - side.rank.get(b)!)
}

/** 反向关联的倒排：本集合的行 id → 源集合里正向关联含它的行（按源集合的手动顺序，side.rows 已排好） */
function invert(side: Side, mirror: CollectionProp): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const row of side.rows) {
    for (const id of idList(readValue(mirror, row.props[mirror.id])) ?? []) {
      const list = index.get(id)
      if (list) list.push(row.id)
      else index.set(id, [row.id])
    }
  }
  return index
}

/** 给 rows 填 computed（与集合有关联属性时的 ref_titles），就地改；返回 refs。
 *  all = rows 就是本集合的全部活行（窗口查询），否则自关联时另取全集。集合里没有关联 / 汇总：什么都不动，refs 为空 */
export async function computeRows(
  pool: Pool,
  getLiveDoc: LiveDoc | undefined,
  collection: CollectionPage,
  schema: CollectionSchema,
  rows: CollectionRow[],
  all = false,
): Promise<CollectionRefs> {
  const relations = schema.props.filter((prop) => prop.type === 'relation')
  const rollups = schema.props.filter((prop) => prop.type === 'rollup')
  if (relations.length === 0 && rollups.length === 0) return {}
  const deps = new Deps(pool, getLiveDoc, collection, schema, all ? rows : undefined)
  const links = new Map<string, Link | null>()
  for (const prop of relations) links.set(prop.id, await resolveLink(deps, collection, prop))
  const rolls = new Map<string, Roll | null>()
  for (const prop of rollups) {
    const roll = await resolveRollup(deps, prop, links)
    rolls.set(prop.id, roll)
    // 编号是派生数据：对方集合里没走建行接口进来的行在这里补上，汇总才数得到它们（本集合的由窗口查询补）
    if (roll?.target.type === 'unique_id' && roll.link.other.id !== collection.id) await ensureNumbers(pool, roll.link.other.id)
  }

  const refs: CollectionRefs = {}
  for (const prop of relations) {
    const link = links.get(prop.id)
    refs[prop.id] = link ? { state: 'ok', target: { id: link.other.id, title: link.other.title } } : { state: 'broken' }
  }
  for (const prop of rollups) {
    const roll = rolls.get(prop.id)
    refs[prop.id] = roll
      ? {
          state: 'ok',
          target: { id: roll.link.other.id, title: roll.link.other.title },
          prop: { type: roll.target.type, options: roll.target.options, cfg: roll.target.cfg },
        }
      : { state: 'broken' }
  }

  const sides = new Map<string, Side>()
  const indexes = new Map<string, Map<string, string[]>>()
  for (const link of links.values()) {
    if (!link || sides.has(link.other.id)) continue
    sides.set(link.other.id, await deps.side(link.other.id))
  }
  for (const link of links.values()) {
    if (link?.mirror) indexes.set(link.prop.id, invert(sides.get(link.other.id)!, link.mirror))
  }

  for (const row of rows) {
    const computed: Record<string, unknown> = {}
    const titles: Record<string, string> = {}
    for (const prop of relations) {
      const link = links.get(prop.id)
      const side = link ? sides.get(link.other.id)! : undefined
      // 正向关联恒有这一项（失效 / 空的是 []）：客户端据「有没有这一项」决定要不要退回行文档里存的值
      const ids = !link || !side ? [] : link.mirror ? (indexes.get(prop.id)!.get(row.id) ?? []) : forwardIds(row, prop, side)
      computed[prop.id] = ids
      for (const id of ids) titles[id] = side!.byId.get(id)!.title
    }
    for (const prop of rollups) {
      const roll = rolls.get(prop.id)
      if (!roll) continue
      const side = sides.get(roll.link.other.id)!
      const ids = computed[roll.link.prop.id] as string[]
      const value = rollupValue(
        roll.fn,
        roll.target,
        ids.map((id) => rowValue(side.byId.get(id)!, roll.target)),
      )
      if (value !== undefined) computed[prop.id] = value
    }
    row.computed = computed
    if (relations.length > 0) row.ref_titles = titles
  }
  return refs
}
