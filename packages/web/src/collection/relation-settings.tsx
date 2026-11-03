// ---------- 关联与汇总的属性设置（属性编辑弹层里的一段）与「新建关联」 ----------
// 关联的定义跨两份集合文档（反向属性在对方集合里），客户端只连着自己那份、也不该绕过权限去写别人的，
// 所以关联的建 / 改 / 删一律经服务端（collection-api.ts 的 addRelation / patchRelation / deleteRelation）；
// 汇总只改本集合里自己的 cfg，照常直接写集合文档（schema-ops.ts 的 setPropCfg）。
// 对方集合的属性（汇总选目标属性、显示反向属性名）经 GET schema 取，不为此再开一条对方集合的协同连接；自关联直接用本集合的定义。
// 新建关联先选目标集合、再定「在对方显示 / 只能关联一行」，点「添加关联」才建：中途取消不留下没有目标的关联。
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  isReverseRelation,
  isRollupTarget,
  rollupFns,
  TITLE_PROP,
  TITLE_PROP_ID,
  type CollectionProp,
  type CollectionSchema,
} from '@ramet/shared/collection-model'
import type { Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { PageIcon } from '../PageIcon'
import { collectionApi, type RelationPatch } from './collection-api'
import { useCollectionPages } from './collection-store'
import { CollectionChooser, CollectionList } from './CollectionPicker'
import { NameInput } from './name-input'
import { usePopover } from './popover'
import { useRelationCtx } from './relation-ctx'
import { pageIndex, relatableCollections } from './relation-model'
import { setPropCfg } from './schema-ops'

const C = COPY.collection
const R = C.relation
const U = C.rollup

type Remote = { title: string; schema: CollectionSchema }
/** 取过的对方集合定义：再打开设置时先给上次的，同时重取 */
const remoteCache = new Map<string, Remote>()

/** 别的集合的属性定义；cid = null 不取。stamp 变了重取（改了关联之后对方的反向属性跟着变） */
function useRemoteSchema(cid: string | null, stamp = ''): Remote | null {
  const [data, setData] = useState<Remote | null>(() => (cid ? (remoteCache.get(cid) ?? null) : null))
  useEffect(() => {
    if (!cid) {
      setData(null)
      return
    }
    setData(remoteCache.get(cid) ?? null)
    let live = true
    collectionApi.schema(cid).then(
      (got) => {
        remoteCache.set(cid, got)
        if (live) setData(got)
      },
      (err: unknown) => console.error(err),
    )
    return () => {
      live = false
    }
  }, [cid, stamp])
  return data
}

/** 关联另一端集合的定义：自关联用本集合的（实时），别的经 GET schema */
function useOtherSchema(other: string | undefined, own: { cid: string; schema: CollectionSchema } | null, stamp = ''): CollectionSchema | null {
  const remote = useRemoteSchema(other && other !== own?.cid ? other : null, stamp)
  return other && other === own?.cid ? own.schema : (remote?.schema ?? null)
}

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : C.writeFailed)

/** 一次关联端点调用：在途时禁用控件，失败把原因留在设置里 */
function useCall(): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** 集合的显示名（页面列表里取；不在列表里 = 已失效） */
export function collectionName(pages: readonly Page[] | null, cid: string | undefined): string | null {
  const page = cid ? pageIndex(pages).get(cid) : undefined
  return page ? page.title || COPY.untitled : null
}

/** 关联属性的设置：正向 = 目标集合、在对方显示（+ 对方的属性名）、只能关联一行；反向 = 由谁维护、只能关联一行 */
export function RelationSettings({ prop, schema }: { prop: CollectionProp; schema: CollectionSchema }) {
  const ctx = useRelationCtx()
  const pages = useCollectionPages()
  const [anchor, open, close] = usePopover()
  const { busy, error, run } = useCall()
  // 对方的定义在关联改了之后要重取（反向属性的名字、只能关联一行存在对方那边）：本集合的 cfg 变了或刚改完一次
  const [tick, setTick] = useState(0)
  const reverse = isReverseRelation(prop)
  const other = useOtherSchema(prop.cfg.target, ctx && { cid: ctx.cid, schema }, `${JSON.stringify(prop.cfg)}:${tick}`)
  if (!ctx) return null
  const target = collectionName(pages, prop.cfg.target)
  const patch = (body: RelationPatch): void =>
    void run(() => collectionApi.patchRelation(ctx.cid, prop.id, body)).then((ok) => ok && setTick((t) => t + 1))
  const counterpart = other?.props.find((p) => p.id === (reverse ? prop.cfg.mirror : prop.cfg.reverse))
  const single = (reverse ? counterpart?.cfg.single : prop.cfg.single) === true
  const singleBox = (
    <label className="cl-check">
      <input type="checkbox" checked={single} disabled={busy || (reverse && !counterpart)} onChange={(e) => patch({ single: e.target.checked })} />
      <span>{R.single}</span>
    </label>
  )
  if (reverse) {
    return (
      <div className="cl-rel-settings">
        <div className="cl-hint">{target ? R.from(target, counterpart?.name ?? '…') : R.broken}</div>
        {singleBox}
        {error && <div className="cl-hint is-error">{error}</div>}
      </div>
    )
  }
  return (
    <div className="cl-rel-settings">
      <div className="cl-field">
        <span>{R.target}</span>
        <button type="button" className={'cl-bar-btn cl-rel-target' + (target ? '' : ' is-dim')} disabled={busy} onClick={(e) => open(e.currentTarget)}>
          {target ?? R.broken}
        </button>
      </div>
      <label className="cl-check">
        <input
          type="checkbox"
          checked={!!prop.cfg.reverse}
          disabled={busy || !target}
          onChange={(e) => {
            if (e.target.checked) patch({ two_way: true })
            else if (window.confirm(R.confirmOneWay(target ?? ''))) patch({ two_way: false })
          }}
        />
        <span>{R.twoWay(target ?? '')}</span>
      </label>
      {prop.cfg.reverse && counterpart && (
        <NameInput value={counterpart.name} placeholder={R.reverseName} onCommit={(name) => patch({ reverse_name: name })} />
      )}
      {singleBox}
      {error && <div className="cl-hint is-error">{error}</div>}
      {anchor && (
        <CollectionChooser
          anchor={anchor}
          collections={relatableCollections(pages, ctx.spaceId)}
          title={R.pickTarget}
          empty={R.noTargets}
          onClose={close}
          onPick={(page) => {
            close()
            if (page.id !== prop.cfg.target && window.confirm(R.confirmRetarget(prop.cfg.reverse ? target : null))) patch({ target: page.id })
          }}
        />
      )}
    </div>
  )
}

/** 汇总的设置：沿本集合的哪个关联 → 对方的哪个属性（关联 / 汇总不行）→ 计算方式（按目标类型只列能用的） */
export function RollupSettings({ doc, schema, prop }: { doc: Y.Doc; schema: CollectionSchema; prop: CollectionProp }) {
  const ctx = useRelationCtx()
  const relations = schema.props.filter((p) => p.type === 'relation')
  const relation = relations.find((p) => p.id === prop.cfg.relation)
  const other = useOtherSchema(relation?.cfg.target, ctx && { cid: ctx.cid, schema })
  const targets = other ? [TITLE_PROP, ...other.props.filter((p) => isRollupTarget(p.type))] : []
  const target = targets.find((p) => p.id === prop.cfg.prop)
  const fns = target ? rollupFns(target.type) : []
  if (relations.length === 0) return <div className="cl-hint">{U.noRelation}</div>
  return (
    <div className="cl-rollup-settings">
      <label className="cl-field">
        <span>{U.relation}</span>
        <select
          value={relation?.id ?? ''}
          // 换了关联，对方集合也换了：目标属性回到「名称」，计算方式回到「显示原值」（对哪种目标都适用）
          onChange={(e) => setPropCfg(doc, prop.id, { relation: e.target.value, prop: TITLE_PROP_ID, fn: 'show_original' })}
        >
          <option value="" disabled>
            {U.pick}
          </option>
          {relations.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || C.types.relation}
            </option>
          ))}
        </select>
      </label>
      <label className="cl-field">
        <span>{U.prop}</span>
        <select
          value={target?.id ?? ''}
          disabled={!relation || !other}
          onChange={(e) => {
            const next = targets.find((p) => p.id === e.target.value)
            if (!next) return
            const fn = prop.cfg.fn && rollupFns(next.type).includes(prop.cfg.fn) ? prop.cfg.fn : 'show_original'
            setPropCfg(doc, prop.id, { prop: next.id, fn })
          }}
        >
          <option value="" disabled>
            {relation && !other ? U.loading : U.pick}
          </option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === TITLE_PROP_ID ? C.props.title : p.name || C.types[p.type]}
            </option>
          ))}
        </select>
      </label>
      <label className="cl-field">
        <span>{U.fn}</span>
        <select value={prop.cfg.fn && fns.includes(prop.cfg.fn) ? prop.cfg.fn : ''} disabled={!target} onChange={(e) => setPropCfg(doc, prop.id, { fn: e.target.value })}>
          <option value="" disabled>
            {U.pick}
          </option>
          {fns.map((fn) => (
            <option key={fn} value={fn}>
              {U.fns[fn]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** 新建关联：先选目标集合（同空间的活集合，含本集合），再定两个开关，点「添加关联」才经服务端建 */
export function RelationCreate({ onCreated, onBack }: { onCreated: (propId: string) => void; onBack: () => void }) {
  const ctx = useRelationCtx()
  const pages = useCollectionPages()
  const [target, setTarget] = useState<Page | null>(null)
  const [twoWay, setTwoWay] = useState(false)
  const [single, setSingle] = useState(false)
  // 反向属性名缺省是本集合的名字（同服务端的缺省）；空着提交也按缺省
  const [reverseName, setReverseName] = useState<string | null>(null)
  const { busy, error, run } = useCall()
  if (!ctx) return null
  const selfName = pages?.find((p) => p.id === ctx.cid)?.title || COPY.untitled
  const back = (
    <button type="button" className="pop-row cl-back" onClick={target ? () => setTarget(null) : onBack}>
      <Icon name="chevron" size={12} className="cl-rot-back" />
      {C.props.back}
    </button>
  )
  if (!target) {
    return (
      <div className="cl-menu">
        {back}
        <CollectionList
          collections={relatableCollections(pages, ctx.spaceId)}
          title={R.pickTarget}
          empty={R.noTargets}
          note={(page) => (page.id === ctx.cid ? R.self : null)}
          onPick={setTarget}
        />
      </div>
    )
  }
  const name = target.title || COPY.untitled
  const create = (): void =>
    void run(async () => {
      const reverse = (reverseName ?? '').trim()
      const { prop } = await collectionApi.addRelation(ctx.cid, { target: target.id, two_way: twoWay, single, ...(twoWay && reverse ? { reverse_name: reverse } : {}) })
      if (prop) onCreated(prop)
    })
  return (
    <div className="cl-menu cl-rel-create">
      {back}
      <div className="pop-section">{C.types.relation}</div>
      <div className="cl-field">
        <span>{R.target}</span>
        <span className="cl-rel">
          {target.icon ? <PageIcon icon={target.icon} /> : <Icon name="table" size={16} />}
          <span className="cl-rel-name">{name}</span>
        </span>
      </div>
      <label className="cl-check">
        <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />
        <span>{R.twoWay(name)}</span>
      </label>
      {twoWay && (
        <div className="cl-field">
          <span>{R.reverseName}</span>
          <input
            className="cl-input"
            value={reverseName ?? selfName}
            placeholder={selfName}
            onChange={(e) => setReverseName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && create()}
          />
        </div>
      )}
      <label className="cl-check">
        <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
        <span>{R.single}</span>
      </label>
      <button type="button" className="cl-bar-btn is-on cl-rel-add" disabled={busy} onClick={create}>
        {busy ? R.creating : R.create}
      </button>
      {error && <div className="cl-hint is-error">{error}</div>}
    </div>
  )
}
