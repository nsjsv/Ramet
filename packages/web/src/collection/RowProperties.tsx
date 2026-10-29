// ---------- 行页面的属性区：标题下面、正文上面（父页是集合的 doc 页） ----------
// 值直接绑行文档自己的 Y.Map('props')（EditorPage 那条连接的 doc，不另开连接），改了就是协同写：
// 服务端投影器负责副本与集合增量，进这一行的版本历史。写前过 validateValue，非法输入不写。
// 属性定义来自集合 store，只要 schema，不取行窗口。
// 拆建顺序：组件按页面 id 做 key，换页 / 卸载时同步摘掉 props 观察者；EditorPage 的 provider 在它的
// 串行销毁链里（先 await 正文编辑器销毁）才拆，所以观察者总是在 doc 销毁之前摘掉。
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { validateValue, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import type { Page } from '../api'
import { COPY } from '../copy'
import { editInfoOf, subscribeEditMarks } from '../edit-marks-store'
import { Icon } from '../icons'
import { spaceMembers } from '../people'
import { useCollection, useCollectionSchema } from './collection-store'
import { isComputed, TYPE_ICON } from './prop-meta'
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

const PICKER = new Set(['select', 'multi_select', 'status', 'person'])

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

/** 「编辑时间」：与顶栏「X分钟前编辑」同一个来源（edit-marks-store，属性改动也会落快照） */
function useEditedAt(pageId: string, fallback: string): string {
  const [, setTick] = useState(0)
  useEffect(() => subscribeEditMarks(() => setTick((t) => t + 1)), [])
  return editInfoOf(pageId)?.edited_at ?? fallback
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
  const editedAt = useEditedAt(page.id, page.created_at)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ids = schema?.props.map((p) => p.id) ?? []
  const drag = useReorder(ids, (id, index) => handle && moveProp(handle.doc, id, index), 'y', !readOnly && handle !== null)
  if (!schema || !handle || schema.props.length === 0) return null

  // 表格那一套单元格要的「行」：值来自行文档本身，名称 / 图标 / 时间来自页面列表
  const row: CollectionRow = {
    id: page.id,
    title: page.title,
    icon: page.icon,
    props: values,
    position: null,
    created_at: page.created_at,
    edited_at: editedAt,
    has_body: false,
  }

  const write = (shownProp: CollectionProp, value: PropValue | null): void => {
    if (readOnly || !doc) return
    // 按最新的定义校验：选择器里刚新建的选项已写进集合文档，但这一轮渲染拿到的 prop 里还没有它
    const prop = handle.schema()?.props.find((p) => p.id === shownProp.id)
    if (!prop) return
    // 人员只能选空间成员（选择器的候选就是成员名单；名单没到时选择器里也没有可选的）
    const members = prop.type === 'person' && page.space_id ? new Set((spaceMembers(page.space_id) ?? []).map((m) => m.id)) : undefined
    const checked = validateValue(prop, value, { members })
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

  return (
    <div className="cl-rowprops" aria-label={C.rowProps}>
      {schema.props.map((prop) => {
        const on = editing === prop.id
        const locked = readOnly || isComputed(prop.type)
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
              // 行页面上点一下就编辑（复选框点一下即切换，由单元格自己处理）
              onSelect={() => {
                if (!locked && prop.type !== 'checkbox') setEditing(prop.id)
              }}
              onEdit={() => {
                if (!locked && prop.type !== 'checkbox') setEditing(prop.id)
              }}
              onStop={() => setEditing(null)}
              onCommit={(value) => {
                write(prop, value)
                if (!PICKER.has(prop.type)) setEditing(null)
              }}
              onOpen={() => undefined}
            />
          </div>
        )
      })}
      {error && (
        <div className="cl-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-btn" title={C.dismiss} aria-label={C.dismiss} onClick={() => setError(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
