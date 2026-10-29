import { useCallback, useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, EditorView } from '@milkdown/kit/prose/view'
import { DOMSerializer, type Node as ProsemirrorNode, type Schema } from '@milkdown/kit/prose/model'
import { computeDocDiff } from '@milkdown/plugin-diff'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { api, type PageSnapshot, type PageSnapshotDetail } from './api'
import { COPY } from './copy'
import { snapshotDoc, useSnapshotList } from './snapshot-list'
import SnapshotListView from './SnapshotListView'
import SnapshotProps from './collection/SnapshotProps'
import { titleSchema } from './title-schema'
import { createCodeView } from './editor/code-view'
import { createCodeHighlightPlugin } from './editor/code-highlight'
import { createMathBlockView, createMathInlineView } from './editor/math-view'
import { createCalloutView } from './editor/callout'
import { createToggleView } from './editor/toggle'
import { createTocView } from './editor/toc'

type DiffChanges = ReturnType<typeof computeDocDiff>

/** 快照解码出的 PM 节点与差异（快照→PM 节点的构建收在本组件，EditorPage 只负责 dispatch） */
interface LoadedSnapshot {
  meta: PageSnapshotDetail
  /** 所选版本正文（Milkdown schema 的 PM 根节点，恢复/预览/对比展示都用它） */
  body: ProsemirrorNode
  /** 所选版本标题（titleSchema 的 PM 根节点） */
  title: ProsemirrorNode
  /** 所选版本的行属性（Y.Map('props') 的 JSON；普通页面恒为空） */
  props: Record<string, unknown>
  /** 上一版本正文（diff 的 oldDoc；列表里所选的下一个 = 更旧一条；最旧一条 = 空 doc） */
  prevBody: ProsemirrorNode
  /** 是否存在上一版本（仅一条快照时为 false，对比基准退化为空 doc） */
  hasPrev: boolean
  /** 所选版本 vs 上一版本：inserted=该版本新增，deleted=相对上一版被删 */
  changes: DiffChanges
}

/** 集合的行页面：版本预览带属性、恢复带属性（HistoryDrawer 从 EditorPage 透传） */
export interface RowHistory {
  collectionId: string
  spaceId: string | null
  /** 这一行当前的文档（预览里标出与当前不同的属性） */
  getDoc: () => Y.Doc | undefined
}

interface Props {
  pageId: string
  /** viewer：隐藏恢复与手动存版（服务端 POST 本就 403，这里只锁入口） */
  readOnly: boolean
  /** 仅用于取正文视图的 schema（解码快照用）；恢复由 EditorPage 对两个视图 dispatch */
  getViews: () => { body: EditorView | undefined; title: EditorView | undefined }
  /** 恢复后关抽屉（壳在 HistoryDrawer，这里只透传） */
  onClose: () => void
  /** props 只在行页面给（写回行文档的 Y.Map('props')）；普通页面不给，不碰 props */
  onRestore: (body: ProsemirrorNode, title: ProsemirrorNode, props?: Record<string, unknown>) => void
  /** 集合的行页面才有 */
  row?: RowHistory | null
  /** 把历史版本里的一个顶层块单独放回当前页面（插在 afterId 那块之后，null = 页首）；成功 = true */
  onRestoreBlock: (node: ProsemirrorNode, afterId: string | null) => boolean
  /** 更新面板时钟跳转的目标快照 id（HistoryDrawer 持有）；选中后经 onJumped 复位 */
  jumpToId?: string | null
  onJumped?: () => void
}

/** 单条快照的解码结果（正文用 Milkdown schema，标题用 titleSchema） */
interface DecodedSnapshot {
  meta: PageSnapshotDetail
  body: ProsemirrorNode
  title: ProsemirrorNode
  props: Record<string, unknown>
}

/** 拉详情，灌进临时 Y.Doc，再取出正文 / 标题 PM 根节点 */
async function decodeSnapshot(pageId: string, id: string, schema: Schema): Promise<DecodedSnapshot> {
  const detail = await api.getSnapshot(pageId, id)
  const doc = snapshotDoc(detail)
  return {
    meta: detail,
    body: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), schema),
    title: yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('title'), titleSchema),
    props: doc.getMap<unknown>('props').toJSON(),
  }
}

/** 历史版本面板内容（壳在 HistoryDrawer）：上列表（时间/标题/自动|手动徽标），下操作区（预览|对比切换、恢复、手动存版） */
export default function VersionHistory({
  pageId,
  readOnly,
  getViews,
  onClose,
  onRestore,
  onRestoreBlock,
  jumpToId,
  onJumped,
  row = null,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null)
  const [mode, setMode] = useState<'preview' | 'diff'>('diff')
  /** 本次已单独恢复的块 id（按钮变「已恢复」；不再重复插入） */
  const [restoredBlocks, setRestoredBlocks] = useState<Set<string>>(new Set())
  const viewPlace = useRef<HTMLDivElement | null>(null)
  /** 快照正文缓存：id 不可变，选中时只补拉缺失详情（最多 2 个：自己 + 上一版） */
  const bodyCache = useRef<Map<string, DecodedSnapshot>>(new Map())
  /** 选中请求令牌：缓存命中的快选与未命中的慢请求并发时，仅最后一次点击的结果可落地 */
  const selectToken = useRef(0)
  /** 选中失败的提示写进列表 hook 的 error（hook 在 select 之后才建，经 ref 拿它的 setter） */
  const setErrorRef = useRef<(error: string | null) => void>(() => undefined)

  // 选中快照：列表 DESC 中 prevMeta 是所选的下一个（更旧一条），为 undefined 则对比空 doc
  const select = useCallback(
    async (meta: PageSnapshot, prevMeta?: PageSnapshot) => {
      const token = ++selectToken.current
      setSelectedId(meta.id)
      try {
        const schema = getViews().body?.state.schema
        if (!schema) throw new Error('编辑器未就绪')
        const cache = bodyCache.current
        const loadOne = async (id: string): Promise<DecodedSnapshot> => {
          const hit = cache.get(id)
          if (hit) return hit
          const entry = await decodeSnapshot(pageId, id, schema)
          cache.set(id, entry)
          return entry
        }
        const self = await loadOne(meta.id)
        const prev = prevMeta && prevMeta.id !== meta.id ? await loadOne(prevMeta.id) : undefined
        // 最旧一条/仅一条快照：上一版 = 空 doc（doc 需 block+ 内容，createAndFill 补默认空段落）
        const prevBody = prev?.body ?? schema.topNodeType.createAndFill() ?? schema.topNodeType.create()
        // 慢请求后到时不得覆盖更新的选中（高亮 selectedId 与详情必须同源）
        if (token !== selectToken.current) return
        setRestoredBlocks(new Set())
        setLoaded({
          meta: self.meta,
          body: self.body,
          title: self.title,
          props: self.props,
          prevBody,
          hasPrev: !!prev,
          changes: computeDocDiff(prevBody, self.body),
        })
        setErrorRef.current(null)
      } catch (err) {
        if (token !== selectToken.current) return
        setSelectedId(null)
        setErrorRef.current(err instanceof Error ? err.message : String(err))
      }
    },
    [pageId, getViews],
  )

  // 列表、分页、跳转、手动存版（与集合页历史共用）。换页 / select 换了：作废在途选中（旧页结果不得落进新页的 state），
  // 清正文缓存（快照 id 全局唯一但仍按页清，防潜在脏数据）
  const list = useSnapshotList(pageId, select, {
    jumpToId,
    onJumped,
    onReset: () => {
      selectToken.current++
      setLoaded(null)
      setSelectedId(null)
      bodyCache.current.clear()
    },
  })
  const { error } = list
  setErrorRef.current = list.setError

  // 预览 / 对比共用一个只读 EditorView，模式或所选版本变化时重建。
  // 对比 = 展示所选版本正文 + 装饰（相对上一版新增绿高亮、被删红删除线，未变动不高亮）
  useEffect(() => {
    const place = viewPlace.current
    if (!place || !loaded) return
    const doc = loaded.body
    const decos: Decoration[] = []
    if (mode === 'diff') {
      const serializer = DOMSerializer.fromSchema(doc.type.schema)
      for (const change of loaded.changes) {
        // 绿：所选版本里相对上一版新增的区间（selectedBody = newDoc 坐标）
        if (change.toB > change.fromB) {
          decos.push(Decoration.inline(change.fromB, change.toB, { class: 'snap-ins' }))
        }
        // 红：相对上一版被删的内容（prevBody = oldDoc 坐标）；序列化旧内容塞 widget 挂回插入点，红色删除线
        if (change.toA > change.fromA) {
          const dom = document.createElement('span')
          dom.className = 'snap-del'
          dom.appendChild(serializer.serializeFragment(loaded.prevBody.slice(change.fromA, change.toA).content))
          decos.push(Decoration.widget(change.fromB, dom, { side: 1, marks: [] }))
        }
      }
    }
    // 单块恢复：快照里的顶层块，当前页面里已经找不到它的 id（删了；挪进别的结构的不算）时，块前放「恢复此块」。
    // 位置 = 快照里它前面最近一个仍是当前页顶层块的块之后；一个都没有就放页首。恢复回来的块带着原来的 id，
    // 引用 / 收藏 / 反链随之接回
    if (!readOnly) {
      const body = getViews().body
      if (body) {
        const anyIds = new Set<string>()
        const topIds = new Set<string>()
        body.state.doc.forEach((child) => {
          const id = typeof child.attrs.id === 'string' ? child.attrs.id : ''
          if (id) topIds.add(id)
        })
        body.state.doc.descendants((node) => {
          const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
          if (id) anyIds.add(id)
          return true
        })
        let anchor: string | null = null
        doc.forEach((child, offset) => {
          const id = typeof child.attrs.id === 'string' ? child.attrs.id : ''
          if (id && !anyIds.has(id)) {
            const after = anchor
            const done = restoredBlocks.has(id)
            const box = document.createElement('div')
            box.className = 'vh-block-restore'
            const hint = document.createElement('span')
            hint.textContent = COPY.restoreBlock.hint
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.textContent = done ? COPY.restoreBlock.done : COPY.restoreBlock.action
            btn.disabled = done
            btn.addEventListener('click', () => {
              if (onRestoreBlock(child, after)) setRestoredBlocks((prev) => new Set(prev).add(id))
            })
            box.append(hint, btn)
            decos.push(Decoration.widget(offset, box, { side: -1, key: `restore:${id}:${done}`, marks: [] }))
          } else if (id && topIds.has(id)) anchor = id
        })
      }
    }
    const view = new EditorView(place, {
      // 代码块 / 公式与编辑器同一个外壳和画法（静态只读）
      state: EditorState.create({ doc, plugins: [createCodeHighlightPlugin()] }),
      nodeViews: { code_block: createCodeView, math_inline: createMathInlineView, math_block: createMathBlockView, callout: createCalloutView, toggle: createToggleView, toc: createTocView },
      // 静态只读视图：装饰集直接绑定本 doc，不参与后续事务映射
      decorations: () => DecorationSet.create(doc, decos),
      editable: () => false,
    })
    return () => {
      view.destroy()
    }
  }, [loaded, mode, readOnly, getViews, onRestoreBlock, restoredBlocks])

  function restore() {
    if (!loaded) return
    onRestore(loaded.body, loaded.title, row ? loaded.props : undefined)
    onClose()
  }

  return (
    <div className="vh-body">
      {error && <div className="vh-error">{error}</div>}
      <SnapshotListView list={list} selectedId={selectedId} onPick={(meta, prev) => void select(meta, prev)} />
      {loaded && (
        <div className="vh-detail">
          <div className="vh-actions">
            <div className="vh-mode">
              <button type="button" className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
                对比更改
              </button>
              <button type="button" className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
                预览
              </button>
            </div>
            {!readOnly && (
              <span className="vh-write-actions">
                <button type="button" className="vh-restore" onClick={restore}>
                  恢复此版本
                </button>
                <button type="button" className="vh-save" onClick={() => void list.saveManual()} disabled={list.saving}>
                  {list.saving ? '保存中…' : '保存版本'}
                </button>
              </span>
            )}
          </div>
          <div className="vh-preview-title">{loaded.meta.title || '无标题'}</div>
          {row && <SnapshotProps collectionId={row.collectionId} spaceId={row.spaceId} props={loaded.props} getDoc={row.getDoc} />}
          {mode === 'diff' && loaded.hasPrev && loaded.changes.length === 0 && (
            <div className="vh-diff-empty">与上一版本无差异</div>
          )}
          <div className="vh-view">
            <div ref={viewPlace} />
          </div>
        </div>
      )}
    </div>
  )
}
