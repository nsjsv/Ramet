// ---------- 跨集合的增量扇出 ----------
// 集合 S 的行属性变了，依赖 S 的集合 D 里有些行的计算值（computed.ts）跟着变：
//   · D 有指向 S 的正向关联 P：D 里 P 含被改行的那些行 —— 被改的键里有挂在 P 上的汇总的目标属性时（汇总变了），
//     或这次改动说不清改了什么（prev 为空：手动顺序变了，关联的排列跟着变）
//   · D 有镜像 S 的正向关联 P' 的反向关联 Q：被改行的 P' 新旧两份 id 表的并集；P' 没改、但挂在 Q 上的汇总的目标属性改了 /
//     说不清改了什么时，是它现在指向的那些行
//   · 自关联时 D 就是 S：受影响的行并进 S 这一批一起重算
// 只对此刻加载着集合文档（有人在看）、且与 S 同一个空间的 D 做，依赖关系现扫这些文档的定义，不建依赖索引表：
// 没人看就不算，下次打开重新查询。
// 扇出只登记 D 的哪些行要重算（RowsDeltas.touch），由 D 的批次发出前读当时的行再算（读早了的行会把更新的改动盖回去）。
// 计算值变化不进 prev（旧值要按旧数据重算一遍，换来的只是窗口外计数少偏一），按 prev: {} 发。
//
// 集合文档的定义（Y.Map('collection')）变了、且变的是依赖方关心的部分（属性的类型 / 配置 / 选项，不含名字与位置、视图），
// 给加载着的、依赖它的同空间集合发 reset：它们的 refs 与计算值都可能变了，观看者重取。集合自己的观看者靠客户端的查询签名重取。

import type { Extension } from '@hocuspocus/server'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { isReverseRelation, parseCollection, type CollectionSchema, type PropType, type RowUpdate } from '@ramet/shared/collection-model'
import { PAGE_DOC_NAME } from '../collab.js'
import { computeRows, hasComputed, type LiveDoc } from './computed.js'
import type { BatchEnrich } from './delta.js'
import { memberRowsAmong, readSchema, selectCollection } from './store.js'

/** 扇出要往别的集合的批次里登记重算 / 重取 */
export type FanoutSink = { touch(collectionId: string, rowIds: Iterable<string>): void; reset(collectionId: string): void }

export type Fanout = {
  /** 挂进 createHocuspocus 的扩展：登记加载着的集合文档，观察它们的定义 */
  extension: Extension
  /** 交给增量批次（RowsDeltas）的 enrich */
  enrich: BatchEnrich
}

type Entry = { doc: Y.Doc; map: Y.Map<unknown>; schema: CollectionSchema; sig: string; observer: () => void }

// 正向关联 P 含这些行的那些行（只看副本里那个键是不是含着其中之一；多算几行无妨，重算出来的值不变）
const SELECT_LINKING = `SELECT p.id FROM live_pages p JOIN collection_rows r ON r.page_id = p.id
  WHERE p.parent_id = $1 AND p.kind = 'doc' AND (r.props -> $2::text) ?| $3::text[]`
// 候选依赖方里与集合 $1 同一个空间的活集合（含它自己）。跨了空间的关联算出来恒为已失效，没什么可重算；
// 也不能让那边的观看者从增量 / reset 的节奏里看出这边的行什么时候改了（集合文档里的关联谁都能经协同连接写进去）
const SELECT_SAME_SPACE = `SELECT d.id FROM live_pages d JOIN live_pages s ON s.id = $1 AND s.kind = 'collection' AND s.space_id = d.space_id
  WHERE d.id = ANY($2::text[]) AND d.kind = 'collection'`

/** 改了任何属性值，这两类元数据都跟着变（编辑时间、最后编辑者） */
const EDIT_STAMPS: ReadonlySet<PropType> = new Set(['edited_time', 'edited_by'])

/** 依赖方关心的定义：每个属性的类型、配置、选项（名字、位置、视图的改动不影响别的集合算出来的值） */
function depSig(schema: CollectionSchema): string {
  return JSON.stringify(schema.props.map((prop) => [prop.id, prop.type, prop.cfg, prop.options]))
}

/** D 的计算值依赖集合 cid：有关联指向它（正向的目标 / 反向的源） */
function dependsOn(schema: CollectionSchema, cid: string): boolean {
  return schema.props.some((prop) => prop.type === 'relation' && prop.cfg.target === cid)
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

/** 这次改动改了哪些键；null = 说不清（手动顺序、正文有没有字、本批才进集合），当作全都可能变了 */
function changedKeys(update: RowUpdate): Record<string, unknown> | null {
  return update.prev && Object.keys(update.prev).length > 0 ? update.prev : null
}

export function createFanout(pool: Pool, getLiveDoc: LiveDoc, sink: () => FanoutSink): Fanout {
  const loaded = new Map<string, Entry>()

  /** 加载着的、依赖集合 cid、且与它同一个空间的集合（exceptSelf：不含 cid 自己） */
  async function dependents(cid: string, exceptSelf: boolean): Promise<[string, Entry][]> {
    const candidates = [...loaded].filter(([id, entry]) => !(exceptSelf && id === cid) && dependsOn(entry.schema, cid))
    if (candidates.length === 0) return []
    const { rows } = await pool.query<{ id: string }>(SELECT_SAME_SPACE, [cid, candidates.map(([id]) => id)])
    const same = new Set(rows.map((row) => row.id))
    return candidates.filter(([id]) => same.has(id))
  }

  const extension: Extension = {
    extensionName: 'collection-fanout',
    async afterLoadDocument({ documentName, document }) {
      const cid = PAGE_DOC_NAME.exec(documentName)?.[1]
      if (!cid) return
      const map = document.getMap<unknown>('collection')
      // 集合文档由服务端整份建好，加载时就不是空的；普通页面的这张 map 恒为空
      if (map.size === 0) return
      const old = loaded.get(cid)
      if (old && old.doc !== document) old.map.unobserveDeep(old.observer)
      const schema = parseCollection(map.toJSON())
      const entry: Entry = {
        doc: document,
        map,
        schema,
        sig: depSig(schema),
        observer: () => {
          const next = parseCollection(map.toJSON())
          const sig = depSig(next)
          const changed = sig !== entry.sig
          entry.schema = next
          entry.sig = sig
          if (!changed) return
          dependents(cid, true).then(
            (found) => {
              for (const [id] of found) sink().reset(id)
            },
            (err: unknown) => console.error(`[collections] 依赖集合的定义变化通知失败(page:${cid}):`, err),
          )
        },
      }
      map.observeDeep(entry.observer)
      loaded.set(cid, entry)
    },
    async afterUnloadDocument({ documentName, instance }) {
      const cid = PAGE_DOC_NAME.exec(documentName)?.[1]
      const entry = cid ? loaded.get(cid) : undefined
      // 卸载期间同名文档已重新加载：留给新的那份
      if (!cid || !entry || instance.documents.get(documentName) === entry.doc) return
      entry.map.unobserveDeep(entry.observer)
      loaded.delete(cid)
    },
  }

  /** 集合 cid 的这批改动让依赖方 D（定义 schema、id did）的哪些行要重算 */
  async function affected(schema: CollectionSchema, did: string, cid: string, up: RowUpdate[], source: () => Promise<CollectionSchema>): Promise<Set<string>> {
    const out = new Set<string>()
    for (const prop of schema.props) {
      if (prop.type !== 'relation' || prop.cfg.target !== cid) continue
      const rollups = schema.props.filter((r) => r.type === 'rollup' && r.cfg.relation === prop.id && r.cfg.prop !== undefined)
      let stamps: boolean | undefined
      /** 改动碰到了挂在这个关联上的汇总的目标属性 */
      const hitsRollup = async (prev: Record<string, unknown>): Promise<boolean> => {
        if (rollups.some((r) => Object.hasOwn(prev, r.cfg.prop!))) return true
        if (rollups.length === 0) return false
        // 汇总编辑时间 / 最后编辑者的，任何属性一改就变
        stamps ??= (await source()).props.some((p) => EDIT_STAMPS.has(p.type) && rollups.some((r) => r.cfg.prop === p.id))
        return stamps
      }
      if (!isReverseRelation(prop)) {
        const sources: string[] = []
        for (const update of up) {
          const prev = changedKeys(update)
          if (!prev || (await hitsRollup(prev))) sources.push(update.row.id)
        }
        if (sources.length === 0) continue
        const { rows } = await pool.query<{ id: string }>(SELECT_LINKING, [did, prop.id, sources])
        for (const row of rows) out.add(row.id)
        continue
      }
      const mirror = prop.cfg.mirror!
      for (const update of up) {
        const prev = changedKeys(update)
        const now = strings(update.row.props[mirror])
        if (prev && Object.hasOwn(prev, mirror)) for (const id of [...strings(prev[mirror]), ...now]) out.add(id)
        else if (!prev || (await hitsRollup(prev))) for (const id of now) out.add(id)
      }
    }
    return out
  }

  const enrich: BatchEnrich = async (cid, up, touched) => {
    // 扇出只看真的行改动；touched 里的行只是计算值变了，不再往外扇（汇总的目标不能是关联 / 汇总，传不下去）
    const own = new Set<string>()
    if (up.length > 0) {
      let source: Promise<CollectionSchema> | undefined
      const sourceSchema = (): Promise<CollectionSchema> => (source ??= readSchema(pool, cid, getLiveDoc))
      for (const [did, entry] of await dependents(cid, false)) {
        const rows = await affected(entry.schema, did, cid, up, sourceSchema)
        if (did === cid) for (const id of rows) own.add(id)
        else if (rows.size > 0) sink().touch(did, rows)
      }
    }
    // 没加载 = 没人看着这个集合，增量本来就发不出去；没有计算类属性，行原样发
    const entry = loaded.get(cid)
    if (!entry || !hasComputed(entry.schema)) return up
    const collection = await selectCollection(pool, cid)
    if (!collection) return up
    const have = new Set(up.map((update) => update.row.id))
    const extra = await memberRowsAmong(
      pool,
      cid,
      [...new Set([...touched, ...own])].filter((id) => !have.has(id)),
    )
    await computeRows(pool, getLiveDoc, collection, entry.schema, [...up.map((update) => update.row), ...extra])
    return [...up, ...extra.map((row) => ({ row, prev: {} }))]
  }

  return { extension, enrich }
}
