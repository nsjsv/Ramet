// ---------- 集合页的历史版本：版本 = 属性定义、视图与名称 ----------
// 列表 / 分页 / 跳转 / 手动存版与文档页共用 useSnapshotList；当前已没有的属性 / 视图标「已删除」。
// 恢复 = 写回属性定义、视图和名称（由 CollectionPage 执行），行里的值不动；恢复按钮只给可写成员。
import { useCallback, useRef, useState } from 'react'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { parseCollection, type CollectionSchema } from '@ramet/shared/collection-model'
import { api, type PageSnapshot, type PageSnapshotDetail } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { snapshotDoc, useSnapshotList } from '../snapshot-list'
import SnapshotListView from '../SnapshotListView'
import { titleSchema } from '../title-schema'
import { OptionChip } from './cells/CellView'
import { useCollection, useCollectionSchema } from './collection-store'
import { TYPE_ICON } from './prop-meta'
import { LAYOUT_ICON } from './ViewTabs'

const C = COPY.collection
const H = C.history

type Props = {
  pageId: string
  readOnly: boolean
  onClose: () => void
  /** snapshot = 那个版本 Y.Map('collection') 的 JSON（不可信，恢复方再过 parseCollection），title = 那个版本的标题 */
  onRestore: (snapshot: unknown, title: ProsemirrorNode) => void
  jumpToId?: string | null
  onJumped?: () => void
}

type Loaded = {
  meta: PageSnapshotDetail
  json: unknown
  schema: CollectionSchema
  title: ProsemirrorNode
}

export default function CollectionHistory({ pageId, readOnly, onClose, onRestore, jumpToId, onJumped }: Props) {
  const current = useCollectionSchema(useCollection(pageId))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const cache = useRef<Map<string, Loaded>>(new Map())
  /** 选中请求令牌：仅最后一次点击的结果可落地（同 VersionHistory） */
  const selectToken = useRef(0)
  const setErrorRef = useRef<(error: string | null) => void>(() => undefined)

  const select = useCallback(
    async (meta: PageSnapshot) => {
      const token = ++selectToken.current
      setSelectedId(meta.id)
      try {
        let entry = cache.current.get(meta.id)
        if (!entry) {
          const detail = await api.getSnapshot(pageId, meta.id)
          const doc = snapshotDoc(detail)
          const json: unknown = doc.getMap<unknown>('collection').toJSON()
          entry = {
            meta: detail,
            json,
            schema: parseCollection(json),
            title: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('title'), titleSchema),
          }
          cache.current.set(meta.id, entry)
        }
        if (token !== selectToken.current) return
        setLoaded(entry)
        setErrorRef.current(null)
      } catch (err) {
        if (token !== selectToken.current) return
        setSelectedId(null)
        setErrorRef.current(err instanceof Error ? err.message : String(err))
      }
    },
    [pageId],
  )

  const list = useSnapshotList(pageId, select, {
    jumpToId,
    onJumped,
    onReset: () => {
      selectToken.current++
      setLoaded(null)
      setSelectedId(null)
      cache.current.clear()
    },
  })
  setErrorRef.current = list.setError

  const restore = (): void => {
    if (!loaded) return
    onRestore(loaded.json, loaded.title)
    onClose()
  }

  const liveProps = new Set(current?.props.map((p) => p.id) ?? [])
  const liveViews = new Set(current?.views.map((v) => v.id) ?? [])
  return (
    <div className="vh-body">
      {list.error && <div className="vh-error">{list.error}</div>}
      <SnapshotListView list={list} selectedId={selectedId} onPick={(meta) => void select(meta)} />
      {loaded && (
        <div className="vh-detail">
          <div className="vh-actions">
            <span className="vh-hint">{H.restoreHint}</span>
            {!readOnly && (
              <span className="vh-write-actions">
                <button type="button" className="vh-restore" onClick={restore}>
                  {H.restore}
                </button>
                <button type="button" className="vh-save" onClick={() => void list.saveManual()} disabled={list.saving}>
                  {list.saving ? '保存中…' : '保存版本'}
                </button>
              </span>
            )}
          </div>
          <div className="vh-preview-title">{loaded.meta.title || '无标题'}</div>
          <div className="vh-view">
            <div className="vh-section">{H.props}</div>
            {loaded.schema.props.length === 0 && <div className="vh-empty">{H.noProps}</div>}
            {loaded.schema.props.map((prop) => (
              <div key={prop.id} className="vh-entity">
                <span className="vh-prop-name">
                  <Icon name={TYPE_ICON[prop.type]} size={14} />
                  <span>{prop.name || C.types[prop.type]}</span>
                </span>
                <span className="vh-entity-meta">{C.types[prop.type]}</span>
                {current && !liveProps.has(prop.id) && <span className="vh-badge">{H.deleted}</span>}
                {prop.options.length > 0 && (
                  <span className="cl-chips vh-entity-options">
                    {prop.options.map((option) => (
                      <OptionChip key={option.id} option={option} status={prop.type === 'status'} />
                    ))}
                  </span>
                )}
              </div>
            ))}
            <div className="vh-section">{H.views}</div>
            {loaded.schema.views.map((view) => (
              <div key={view.id} className="vh-entity">
                <span className="vh-prop-name">
                  <Icon name={LAYOUT_ICON[view.layout]} size={14} />
                  <span>{view.name || C.views.layouts[view.layout]}</span>
                </span>
                <span className="vh-entity-meta">
                  {[
                    C.views.layouts[view.layout],
                    view.filter.all.length > 0 ? H.filters(view.filter.all.length) : '',
                    view.sorts.length > 0 ? H.sorts(view.sorts.length) : '',
                    view.groupBy ? H.grouped : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {current && !liveViews.has(view.id) && <span className="vh-badge">{H.deleted}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
