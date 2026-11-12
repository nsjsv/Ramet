/* ---------- 集合：关联的定义、单行取数、属性定义 ----------
 * GET    /api/collections/:id/rows/:rowId           单行（带 computed）+ refs：行页面属性区只有定义没有窗口，计算值从这里取
 * GET    /api/collections/:id/schema                属性定义与视图（parseCollection 的结果）+ 集合名：建汇总 / 改关联时列对方的属性，
 *                                                   不必为此再开一条对方集合的协同连接
 * POST   /api/collections/:id/relations             建关联：{ name?, target, two_way?, reverse_name?, single? } → 201 { prop, reverse }
 * PATCH  /api/collections/:id/relations/:propId     改关联：{ target?, two_way?, reverse_name?, single? } → 200 { prop, reverse }
 * DELETE /api/collections/:id/relations/:propId     删关联（从任一侧删都删两侧）→ 200 { deleted: { collection, prop }[] }
 *
 * 关联的定义跨两份集合文档（正向在本集合，反向在对方集合），客户端只连着自己的那份、也不该绕过权限去写别人的，
 * 所以定义的增删改走这里：两侧都过闸门（同空间 ⇒ 同一个角色），经 DocWriter 记给发起的用户写进集合文档。
 * 普通的属性操作（改名、改位置、隐藏）仍由客户端直接写自己集合的文档。
 * 两份文档不是一个事务：先写反向那一侧再写正向那一侧。第二步失败时留下的反向属性对不上（computed.ts 的有效性判定），
 * 按「已失效」显示、可删，不会坏数据；删的时候也先删反向，留下的正向就是一个还能用的单向关联。
 * 只碰同一个空间里的对方集合：对方挪到别的空间后，那边留下的属性按已失效显示，由那边的成员自己删。
 * 删关联只摘定义，值留在行文档里（同删属性的口径），恢复集合页版本可找回定义。
 * 每条路由各自挂 requireAuth，不挂 '*' 中间件（见 index.ts 的挂载序注释）。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { isReverseRelation, newShortId, type CollectionProp } from '@ramet/shared/collection-model'
import { requireAuth, type AuthEnv, type AuthUser } from '../auth.js'
import type { DocWriter } from '../collab.js'
import { computeRows, type LiveDoc } from '../collections/computed.js'
import { ensureNumbers, memberRowsAmong, readSchema, type CollectionPage } from '../collections/store.js'
import { collectionGate } from './collections.js'
import { addPropIn, clipName, DEFAULT_RELATION_NAME, patchCfg, propMap, propsMap, relationPlan, takenIds, type RelationSide } from '../collections/schema-write.js'

export type RelationDeps = { pool: Pool; write: DocWriter; getLiveDoc: LiveDoc }

type Side = RelationSide & { collection: CollectionPage }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectionRelationRoutes(deps: RelationDeps) {
  const { pool, write, getLiveDoc } = deps
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  const denied = (c: Context<AuthEnv>, status: 403 | 404) => c.json({ error: status === 404 ? 'collection not found' : 'forbidden' }, status)

  /** 改一份集合文档（记给发起的用户：集合页的版本历史里是他改的） */
  const edit = (user: AuthUser, collectionId: string, fn: (doc: Y.Doc) => void): Promise<void> =>
    write(`page:${collectionId}`, user, (doc, origin) => doc.transact(() => fn(doc), origin), 'user')

  /** 关联的另一端：活集合、可写、与本集合同一个空间。不满足给出响应（不存在 / 非成员 404，只读 403，跨空间 400） */
  async function otherSide(
    user: AuthUser,
    self: CollectionPage,
    id: string,
  ): Promise<{ ok: true; side: Side } | { ok: false; status: 400 | 403 | 404; error: string }> {
    if (id === self.id) return { ok: true, side: { collection: self, schema: await readSchema(pool, id, getLiveDoc) } }
    const g = await collectionGate(pool, user, id, 'write')
    if (!g.ok) return { ok: false, status: g.status, error: g.status === 404 ? 'target collection not found' : 'forbidden' }
    if (g.collection.space_id !== self.space_id) return { ok: false, status: 400, error: 'target must be in the same space' }
    return { ok: true, side: { collection: g.collection, schema: await readSchema(pool, id, getLiveDoc) } }
  }

  /** 关联另一端那个对得上的属性（正向 P 的反向 Q：镜像 P 且指回本集合；反向 Q 的正向 P：指回本集合且记着 Q）。
   *  另一端不可写 / 不在同一个空间 / 对不上 = null（不去碰它） */
  async function counterpart(user: AuthUser, self: CollectionPage, prop: CollectionProp): Promise<{ side: Side; prop: CollectionProp } | null> {
    const target = prop.cfg.target
    const otherId = isReverseRelation(prop) ? prop.cfg.mirror : prop.cfg.reverse
    if (!target || !otherId) return null
    const other = await otherSide(user, self, target)
    if (!other.ok) return null
    const found = other.side.schema.props.find((p) => p.id === otherId)
    if (!found || found.type !== 'relation' || found.cfg.target !== self.id) return null
    const matches = isReverseRelation(prop) ? !isReverseRelation(found) && found.cfg.reverse === prop.id : found.cfg.mirror === prop.id
    return matches ? { side: other.side, prop: found } : null
  }

  async function selfSide(c: Context<AuthEnv>, need: 'read' | 'write'): Promise<{ ok: true; side: Side } | { ok: false; res: Response }> {
    const g = await collectionGate(pool, c.get('user'), c.req.param('id') ?? '', need)
    if (!g.ok) return { ok: false, res: denied(c, g.status) }
    return { ok: true, side: { collection: g.collection, schema: await readSchema(pool, g.collection.id, getLiveDoc) } }
  }

  app.get('/api/collections/:id/rows/:rowId', auth, async (c) => {
    const self = await selfSide(c, 'read')
    if (!self.ok) return self.res
    const { collection, schema } = self.side
    // 编号同窗口查询：没走建行接口进来的行在这里补上
    if (schema.props.some((prop) => prop.type === 'unique_id')) await ensureNumbers(pool, collection.id)
    const row = (await memberRowsAmong(pool, collection.id, [c.req.param('rowId')]))[0]
    if (!row) return c.json({ error: 'row not found' }, 404)
    const refs = await computeRows(pool, getLiveDoc, collection, schema, [row])
    return c.json({ row, refs })
  })

  app.get('/api/collections/:id/schema', auth, async (c) => {
    const self = await selfSide(c, 'read')
    if (!self.ok) return self.res
    return c.json({ title: self.side.collection.title, schema: self.side.schema })
  })

  app.post('/api/collections/:id/relations', auth, async (c) => {
    const user = c.get('user')
    const self = await selfSide(c, 'write')
    if (!self.ok) return self.res
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400)
    const { name, target, two_way: twoWay, reverse_name: reverseName, single } = body
    if (typeof target !== 'string' || target === '') return c.json({ error: 'target must be a collection id' }, 400)
    if (name !== undefined && typeof name !== 'string') return c.json({ error: 'name must be a string' }, 400)
    if (reverseName !== undefined && typeof reverseName !== 'string') return c.json({ error: 'reverse_name must be a string' }, 400)
    if (twoWay !== undefined && typeof twoWay !== 'boolean') return c.json({ error: 'two_way must be a boolean' }, 400)
    if (single !== undefined && typeof single !== 'boolean') return c.json({ error: 'single must be a boolean' }, 400)
    const { collection } = self.side
    const other = await otherSide(user, collection, target)
    if (!other.ok) return c.json({ error: other.error }, other.status)
    const t = other.side
    const { propId, reverseId, forward, reverse } = relationPlan(self.side, t, {
      ...(name !== undefined ? { name } : {}),
      ...(twoWay !== undefined ? { twoWay } : {}),
      ...(reverseName !== undefined ? { reverseName } : {}),
      ...(single !== undefined ? { single } : {}),
    })
    if (t.collection.id === collection.id) {
      await edit(user, collection.id, (doc) => {
        addPropIn(doc, propId, forward)
        if (reverseId) addPropIn(doc, reverseId, reverse)
      })
    } else {
      if (reverseId) await edit(user, t.collection.id, (doc) => addPropIn(doc, reverseId, reverse))
      await edit(user, collection.id, (doc) => addPropIn(doc, propId, forward))
    }
    return c.json({ prop: propId, reverse: reverseId }, 201)
  })

  app.patch('/api/collections/:id/relations/:propId', auth, async (c) => {
    const user = c.get('user')
    const self = await selfSide(c, 'write')
    if (!self.ok) return self.res
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400)
    const { target, two_way: twoWay, reverse_name: reverseName, single } = body
    if (target !== undefined && (typeof target !== 'string' || target === '')) return c.json({ error: 'target must be a collection id' }, 400)
    if (reverseName !== undefined && typeof reverseName !== 'string') return c.json({ error: 'reverse_name must be a string' }, 400)
    if (twoWay !== undefined && typeof twoWay !== 'boolean') return c.json({ error: 'two_way must be a boolean' }, 400)
    if (single !== undefined && typeof single !== 'boolean') return c.json({ error: 'single must be a boolean' }, 400)
    const { collection, schema } = self.side
    const prop = schema.props.find((p) => p.id === c.req.param('propId'))
    if (!prop) return c.json({ error: 'property not found' }, 404)

    if (isReverseRelation(prop)) {
      // 从反向那一侧只能关掉双向（删掉自己、正向那一侧变单向）或改「只能关联一行」（存在正向那一侧）
      if (target !== undefined) return c.json({ error: 'change the target from the forward side' }, 400)
      const pair = await counterpart(user, collection, prop)
      if (twoWay === false) {
        await edit(user, collection.id, (doc) => propsMap(doc).delete(prop.id))
        if (pair) await edit(user, pair.side.collection.id, (doc) => patchCfg(doc, pair.prop.id, { reverse: null }))
        return c.json({ prop: pair?.prop.id ?? null, reverse: null })
      }
      if (single !== undefined && pair) await edit(user, pair.side.collection.id, (doc) => patchCfg(doc, pair.prop.id, { single }))
      return c.json({ prop: pair?.prop.id ?? null, reverse: prop.id })
    }

    // 正向关联（或要改成关联的别的属性）
    const current = prop.type === 'relation' ? prop.cfg.target : undefined
    const nextTarget = typeof target === 'string' ? target : current
    if (!nextTarget) return c.json({ error: 'target required' }, 400)
    const other = await otherSide(user, collection, nextTarget)
    if (!other.ok) return c.json({ error: other.error }, other.status)
    const t = other.side
    const moved = prop.type !== 'relation' || nextTarget !== current
    const pair = prop.type === 'relation' ? await counterpart(user, collection, prop) : null
    const keep = twoWay ?? (pair !== null || (prop.type === 'relation' && !!prop.cfg.reverse))
    let reverseId: string | null = pair && !moved && keep ? pair.prop.id : null
    // 先动反向那一侧：旧的不要了就删，要双向却还没有（或换了目标）就在新目标里建
    if (pair && (moved || !keep)) await edit(user, pair.side.collection.id, (doc) => propsMap(doc).delete(pair.prop.id))
    if (keep && reverseId === null) {
      const id = newShortId(takenIds(t.schema, t.collection.id === collection.id ? [prop.id] : []))
      const name = clipName(typeof reverseName === 'string' ? reverseName : '') || collection.title || DEFAULT_RELATION_NAME
      await edit(user, t.collection.id, (doc) => addPropIn(doc, id, { name, type: 'relation', cfg: { target: collection.id, mirror: prop.id } }))
      reverseId = id
    } else if (reverseId && typeof reverseName === 'string' && clipName(reverseName)) {
      const id = reverseId
      await edit(user, t.collection.id, (doc) => propMap(doc, id)?.set('name', clipName(reverseName)))
    }
    await edit(user, collection.id, (doc) => {
      if (prop.type !== 'relation') propMap(doc, prop.id)?.set('type', 'relation')
      patchCfg(doc, prop.id, { target: t.collection.id, reverse: reverseId, single: single ?? prop.cfg.single === true }, ['mirror'])
    })
    return c.json({ prop: prop.id, reverse: reverseId })
  })

  app.delete('/api/collections/:id/relations/:propId', auth, async (c) => {
    const user = c.get('user')
    const self = await selfSide(c, 'write')
    if (!self.ok) return self.res
    const { collection, schema } = self.side
    const prop = schema.props.find((p) => p.id === c.req.param('propId'))
    if (!prop) return c.json({ error: 'property not found' }, 404)
    if (prop.type !== 'relation') return c.json({ error: 'not a relation' }, 400)
    const pair = await counterpart(user, collection, prop)
    const deleted: { collection: string; prop: string }[] = []
    // 先删反向那一侧：第二步失败时留下的正向关联仍是一个能用的单向关联
    const reverse = isReverseRelation(prop) ? { collection: collection.id, prop: prop.id } : pair && { collection: pair.side.collection.id, prop: pair.prop.id }
    const forward = isReverseRelation(prop) ? pair && { collection: pair.side.collection.id, prop: pair.prop.id } : { collection: collection.id, prop: prop.id }
    for (const item of [reverse, forward]) {
      if (!item) continue
      await edit(user, item.collection, (doc) => propsMap(doc).delete(item.prop))
      deleted.push(item)
    }
    return c.json({ deleted })
  })

  return app
}
