// ---------- 行页面的属性区：标题下面、正文上面（父页是集合的 doc 页） ----------
// 值直接绑行文档自己的 Y.Map('props')（EditorPage 那条连接的 doc，不另开连接），改了就是协同写：
// 服务端投影器负责副本与集合增量，进这一行的版本历史。写前过 validateValue，非法输入不写。
// 属性定义来自集合 store，不取行窗口；创建者来自页面列表，最后编辑者 / 编辑时间来自顶栏同一份编辑记录。
// 反向关联与汇总要读别的集合，只有服务端算得出：单独取这一行（GET rows/:rowId，带 refs，跟着本集合的增量更新），
// 自动编号也从那一行来。正向关联照常协同直写（服务端投影器与扇出让对方集合跟上）；反向关联不存值，改它经 store 走 REST。
// 公式在这里按本机时区现算（单行响应不带公式值）。
// 拆建顺序：组件按页面 id 做 key，换页 / 卸载时同步摘掉 props 观察者；EditorPage 的 provider 在它的
// 串行销毁链里（先 await 正文编辑器销毁）才拆，所以观察者总是在 doc 销毁之前摘掉。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type * as Y from 'yjs'
import { isReverseRelation, rowValue, validateValue, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { fillFormulas } from '@ramet/shared/collection-query'
import type { Page } from '../api'
import { COPY } from '../copy'
import { editInfoOf, subscribeEditMarks, type EditInfo } from '../edit-marks-store'
import { Icon } from '../icons'
import { spaceMembers } from '../people'
import { useCollection, useCollectionError, useCollectionSchema } from './collection-store'
import { editorKind } from './cells/editor-kind'
import { TYPE_ICON } from './prop-meta'
import { RelationContext, useCollectionRow, type RelationCtx } from './relation-ctx'
import { withoutForward } from './relation-model'
import { normalizeRelation } from './relation-write'
import { useReorder } from './reorder'
import { moveProp } from './schema-ops'
import TableCell from './table/TableCell'

const C = COPY.collection

type Props = {
  page: Page
  collectionId: string
  /** 这一页的行文档；还没连上（换页的头一帧）= undefined */
  getDoc: () => Y.Doc | undefined
  /** EditorPage 的 editorTick：连接建好 / 同步后 +1，重新取 doc */
  tick: number
  readOnly: boolean
}

/** 行文档 Y.Map('props') 的实时内容（纯 JSON） */
export function useRowProps(doc: Y.Doc | undefined): Record<string, unknown> {
  const [props, setProps] = useState<Record<string, unknown>>({})
  useEffect(() => {
    if (!doc) return
    const map = doc.getMap<unknown>('props')
    const sync = (): void => setProps(map.toJSON())
    sync()
    map.observe(sync)
    return () => map.unobserve(sync)
  }, [doc])
  return props
}

/** 「编辑时间」「最后编辑者」：与顶栏「X分钟前编辑」同一个来源（edit-marks-store，属性改动也会落快照） */
function useEditInfo(pageId: string): EditInfo | null {
  const [, setTick] = useState(0)
  useEffect(() => subscribeEditMarks(() => setTick((t) => t + 1)), [])
  return editInfoOf(pageId)
}

export default function RowProperties({ page, collectionId, getDoc, tick, readOnly }: Props) {
  const handle = useCollection(collectionId)
  const schema = useCollectionSchema(handle)
  const [doc, setDoc] = useState<Y.Doc | undefined>(() => getDoc())
  useEffect(() => {
    const next = getDoc()
    if (next !== doc) setDoc(next)
  }, [tick, getDoc, doc])
  const values = useRowProps(doc)
  const edit = useEditInfo(page.id)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const writeError = useCollectionError(handle)
  // 只有集合里有关联 / 汇总时才单独取这一行（别的属性都在行文档或页面列表里）
  const single = useCollectionRow(handle, schema?.props.some((p) => p.type === 'relation' || p.type === 'rollup') ? page.id : null)
  const navigate = useNavigate()
  const relation = useMemo<RelationCtx>(
    () => ({ cid: collectionId, spaceId: page.space_id, refs: single.refs, open: (id) => navigate(`/page/${id}`) }),
    [collectionId, page.space_id, single.refs, navigate],
  )
  const ids = schema?.props.map((p) => p.id) ?? []
  const drag = useReorder(ids, (id, index) => handle && moveProp(handle.doc, id, index), 'y', !readOnly && handle !== null)
  if (!schema || !handle || schema.props.length === 0) return null

  // 表格那一套单元格要的「行」：值来自行文档本身，名称 / 图标 / 时间 / 创建者来自页面列表，计算值来自 store 里这一行
  // （与改反向关联时换算增删用的是同一份）
  const loaded = single.row ?? handle.findRow(page.id)
  const stored: CollectionRow = {
    id: page.id,
    title: page.title,
    icon: page.icon,
    props: values,
    position: null,
    created_at: page.created_at,
    edited_at: edit?.edited_at ?? page.created_at,
    has_body: false,
    created_by: page.owner_id ?? loaded?.created_by ?? null,
    edited_by: edit ? edit.user_id : (loaded?.edited_by ?? null),
    edited_agent: edit ? (edit.actor === 'agent' ? edit.actor_agent : null) : (loaded?.edited_agent ?? null),
    number: loaded?.number ?? null,
    computed: withoutForward(loaded?.computed, schema),
    ref_titles: loaded?.ref_titles,
  }
  // 公式按这一份现算（与窗口同一个 fillFormulas）：值来自行文档、改了立刻变，单独取的那一行不带公式值
  const row = fillFormulas([stored], schema, handle.queryCtx())[0]!

  const write = (shownProp: CollectionProp, value: PropValue | null): void => {
    if (readOnly || !doc) return
    // 按最新的定义校验：选择器里刚新建的选项已写进集合文档，但这一轮渲染拿到的 prop 里还没有它
    const prop = handle.schema()?.props.find((p) => p.id === shownProp.id)
    if (!prop) return
    // 反向关联不存值：经 store 按现在的值换算成源集合那几行的增删（REST），不写行文档
    if (isReverseRelation(prop)) {
      void handle.setValues(page.id, { [prop.id]: value })
      return
    }
    // 人员只能选空间成员（选择器的候选就是成员名单；名单没到时选择器里也没有可选的）
    const members = prop.type === 'person' && page.space_id ? new Set((spaceMembers(page.space_id) ?? []).map((m) => m.id)) : undefined
    const checked = prop.type === 'relation' ? normalizeRelation(prop, value) : validateValue(prop, value, { members })
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    setError(null)
    const map = doc.getMap<unknown>('props')
    doc.transact(() => {
      if (checked.value === null) map.delete(prop.id)
      else if (JSON.stringify(map.get(prop.id)) !== JSON.stringify(checked.value)) map.set(prop.id, checked.value)
    })
  }

  const shownError = error ?? writeError
  return (
    <RelationContext.Provider value={relation}>
      <div className="cl-rowprops" aria-label={C.rowProps}>
        {schema.props.map((prop) => {
          const on = editing === prop.id
          const kind = editorKind(prop)
          const locked = readOnly || kind === 'none'
          return (
            <div key={prop.id} className="cl-rowprop">
              {/* 拖属性名调顺序（属性的全局顺序，所有行页面同一份）；拖手柄只在名字上，值格里照常选字 */}
              <span className="cl-rowprop-name" title={prop.name || C.types[prop.type]} {...drag(prop.id)}>
                <Icon name={TYPE_ICON[prop.type]} size={14} />
                <span>{prop.name || C.types[prop.type]}</span>
              </span>
              <TableCell
                row={row}
                prop={prop}
                doc={handle.doc}
                spaceId={page.space_id}
                selected={on}
                editing={on}
                readOnly={locked}
                // 行页面上点一下就编辑（复选框点一下即切换）
                onSelect={() => {
                  if (!locked && kind !== 'toggle') setEditing(prop.id)
                }}
                onEdit={() => {
                  if (locked) return
                  if (kind === 'toggle') write(prop, rowValue(row, prop) === true ? null : true)
                  else setEditing(prop.id)
                }}
                onStop={() => setEditing(null)}
                onCommit={(value) => {
                  write(prop, value)
                  if (kind === 'inline') setEditing(null)
                }}
                onOpen={() => undefined}
              />
            </div>
          )
        })}
        {shownError && (
          <div className="cl-error" role="alert">
            <span>{shownError}</span>
            <button
              type="button"
              className="icon-btn"
              title={C.dismiss}
              aria-label={C.dismiss}
              onClick={() => {
                setError(null)
                handle.clearError()
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </div>
    </RelationContext.Provider>
  )
}
