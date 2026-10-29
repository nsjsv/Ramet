/* ---------- 跨页搬块：拖块到 page_ref（子页面块），整块直接进目标页 ----------
 * 三个入口共用一条搬运管线 moveBlockToPage：
 * - 桌面手柄拖拽（HTML5 DnD）：本文件的 createPageDrop 在 handleDrop 拦截（返回 true 同时
 *   挡掉 PM 默认 drop，否则默认 replace 会把 page_ref 原子块替换 / 错位）；
 * - 触屏手柄拖拽（Pointer Events）：block-touch.ts 的 endDrag 命中 page_ref 落点时调用；
 * - 侧栏页面树：BlockHandleProvider 在 dragstart 记 blockDrag 源（本页 id + 块 id），树行
 *   dragover/drop 读它，经桥（Editor 注册的当前编辑器视图）走同一搬运。
 * 语义：整块（顶层块）移动。先 append 到目标页（必须 sync 后才能算末端真位置），成功
 * 才在源页删块（本地事务，可撤销）。任一步失败源块原地不动，不丢数据。
 * li 条目粒度不支持（Y 里条目嵌在 list 元素内部，删壳 / 补壳要复刻 list-drag 全套壳逻辑）：
 * 条目源悬停不给落点高亮，落在 page_ref 上维持 list-drag 现状行为（no-op）。
 * 源页删块可撤销，但目标页的副本不会跟着撤（跨文档移动本就没有单一撤销栈）。
 */

import { HocuspocusProvider } from '@hocuspocus/provider'
import { yXmlFragmentToProseMirrorFragment, updateYFragment } from 'y-prosemirror'
import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { collabUrl } from './collab-url'
import { hasInlineCollection } from './collection-block'
import { COPY } from '../copy'
import { findBlockIdPos } from './block-id'
import { defaultNodeFilter, selectRootNodeByPoint } from './block-handle'
import { topBlockDragSource } from './list-drag'

/* ---------- 拖拽源登记（侧栏树用）----------
 * HTML5 受保护模式下 dragover 读不到 getData，而拖拽只发生在本 SPA 内，所以源信息直接记在
 * 模块级单例，dragend（捕获监听，dragend 不冒泡但捕获路径必经 document）即清，不留陈旧源
 * 误导下一次非块拖拽（如文字选择拖拽）的落点判定。 */

export interface BlockDragSource {
  pageId: string
  blockId: string
}

let blockDrag: BlockDragSource | null = null

export function markBlockDrag(pageId: string, blockId: string): void {
  blockDrag = { pageId, blockId }
  // dragend 不冒泡：必须在捕获层接（目标元素在 document 树内，捕获路径必经）。
  // drop 侧不负责清 —— drop 之后源元素必有 dragend，单点清零
  document.addEventListener(
    'dragend',
    () => {
      blockDrag = null
    },
    { capture: true, once: true },
  )
}

/** 树行 dragover/drop 共用：当前块拖拽源（无 / 已清返回 null）。传 targetId 时源页必须不同
 * （拖回自己返回 null，树行不高亮、drop 不搬运）。 */
export function blockDragTarget(targetId?: string): BlockDragSource | null {
  if (!blockDrag) return null
  if (targetId && blockDrag.pageId === targetId) return null
  return blockDrag
}

export interface PageRefDropTarget {
  node: PMNode
  el: HTMLElement
  pageId: string
}

/** 拖拽悬停 / 落点命中的 page_ref 目标（仅手柄起拖的顶层块源；li 源、外部拖拽、悬停非 page_ref
 * 返回 null）。命中含「拖 page_ref 落回自己」：调用方按原地 no-op 处理（照常高亮、挡默认）。 */
export function pageRefDropTarget(view: EditorView, event: Pick<DragEvent, 'clientY'>): PageRefDropTarget | null {
  if (!topBlockDragSource(view)) return null
  const hit = selectRootNodeByPoint(view, event.clientY, defaultNodeFilter)
  if (!hit || hit.node.type.name !== 'page_ref') return null
  const pageId: unknown = hit.node.attrs.pageId
  if (typeof pageId !== 'string' || !pageId) return null
  return { node: hit.node, el: hit.el, pageId }
}

let highlightEl: HTMLElement | null = null

/** page_ref 落点高亮（进目标页语义不画插入横条，画块高亮；桌面 / 触屏共用） */
export function setPageRefHighlight(el: HTMLElement | null): void {
  if (highlightEl === el) return
  highlightEl?.classList.remove('page-ref-drop-target')
  highlightEl = el
  highlightEl?.classList.add('page-ref-drop-target')
}

/* ---------- 侧栏树桥（侧栏没有编辑器 schema / 视图，跨页搬运统一借用正打开的源编辑器） ---------- */

interface PageDropBridge {
  getPageId: () => string | undefined
  getView: () => EditorView | undefined
}

let bridge: PageDropBridge | null = null

/** Editor 挂载时注册当前编辑器（configBlock，桌面 / 触屏两分支都在）；effect 卸载 / 换页置 null。
 * 不置 null 的旧桥会在换页后把块搬出旧页面（getView 指向已销毁视图还会先炸）。 */
export function setPageDropBridge(next: PageDropBridge | null): void {
  bridge = next
}

const SYNC_TIMEOUT_MS = 4000

/** 目标页 provider 等首笔 sync（超时 / 鉴权拒绝都 reject：宁可不动，绝不把块错写进半同步文档）。
 * 用 executor 形式而非 Promise.withResolvers：web tsconfig 的 lib 还没到 ES2024。
 * 不摘监听：provider 随后必被 destroy（失败分支显式，成功分支由调用方），事件随实例消亡 */
function waitSynced(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSynced = (): void => {
      window.clearTimeout(timer)
      resolve()
    }
    const onClose = (payload: { event?: { code?: number } }): void => {
      const code = payload?.event?.code
      if (code === 4401 || code === 4403) {
        window.clearTimeout(timer)
        reject(new Error(`page-drop: 目标页无权限 (${code})`))
      }
    }
    const timer = window.setTimeout(() => reject(new Error('page-drop: 目标页 sync 超时')), SYNC_TIMEOUT_MS)
    provider.on('synced', onSynced)
    provider.on('close', onClose)
    if (provider.synced) onSynced()
  })
}

/** 把 sourcePageId 页的块 blockId 整块搬进 targetPageId 页（目标页末端 append）。
 * 源块在正打开的编辑器里定位 / 删除（本地 tr，删空文档补空段落保 doc(block+) 合法）。
 * 返回 false 表示什么都没发生（无桥、源编辑器不可用、源块已被协同端删、同步失败、无权限）。 */
export async function moveBlockToPage(sourcePageId: string, blockId: string, targetPageId: string): Promise<boolean> {
  if (!sourcePageId || !blockId || !targetPageId || sourcePageId === targetPageId) return false
  const b = bridge
  const view = b?.getView()
  if (!b || !view || view.isDestroyed) {
    console.error('page-drop: 源编辑器不可用')
    return false
  }
  const pos = findBlockIdPos(view.state.doc, blockId)
  const node = pos != null ? view.state.doc.nodeAt(pos) : null
  if (pos == null || !node) return false // 源块已被协同端删掉：无事可做
  // 含「集合」块（自己或容器里的）一律整块拒绝、原地不动：集合归宿主页的块所有，搬走后原页的块消失，
  // 存储钩子会把集合连同行回收。在任何写入之前判，不会搬一半；链接视图块照常可搬
  if (hasInlineCollection(node)) {
    window.alert(COPY.collection.embed.noMove)
    return false
  }
  const provider = new HocuspocusProvider({ url: collabUrl(), name: `page:${targetPageId}`, quiet: true })
  try {
    await waitSynced(provider)
    const ydoc = provider.document
    // 目标是集合页（文档里有属性定义 / 视图）：集合页没有正文，块写进去谁也看不见，三个入口一律不搬。
    // 判定放在这里（同步后看文档本身）而不是各入口按 kind 查：编辑器里的 page_ref 落点不知道目标页的 kind
    if (ydoc.getMap('collection').size > 0) {
      provider.destroy()
      return false
    }
    const dstFrag = ydoc.getXmlFragment('prosemirror')
    // 目标页现有内容转成 PM fragment，拼上被搬的块，回写：updateYFragment 是 y-prosemirror
    // 的官方 PM→Y 增量写通道（对已有孩子做等值匹配零 diff，只 insert 新块，插在末端正确位置）。
    // 手搓 Y 行不通：yjs 不允许已集成元素跨文档（游离 fragment / tmp doc 元素），
    // 游离 fragment 里 get() 取不到孩子
    const existing = yXmlFragmentToProseMirrorFragment(dstFrag, view.state.schema)
    const merged = view.state.schema.topNodeType.create(
      null,
      existing.append(Fragment.from(node)),
    )
    // mapping / isOMark 是 updateYFragment 的 meta 参数契约
    updateYFragment(ydoc, dstFrag, merged, { mapping: new Map(), isOMark: new Map() })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('page-drop:insert-failed', e.message, e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : '')
    provider.destroy()
    return false
  }
  provider.destroy()
  // 目标写入成功才删源（本地事务，可撤销；删空补空段落，同 block-menu runDelete 语义）
  const tr = view.state.tr
  tr.delete(pos, pos + node.nodeSize)
  if (!tr.doc.childCount) {
    const paragraph = view.state.schema.nodes.paragraph
    if (paragraph) tr.insert(0, paragraph.create())
  }
  view.dispatch(tr)
  return true
}

/** 顶层块拖到 page_ref 上，整块进目标页。PM someProp 按注册顺序咨询 handleDrop：排
 * listDrag 之后注册（Editor .use 链），listDrag 对「块源落非列表 / 非条目」返回 false 后本插件
 * 接住 page_ref 落点；li 源落 page_ref 被 listDrag 提前挡掉（no-op），条目粒度跨页不支持。
 * 落到源块自己 / 源块无 id（老数据未补齐）是 no-op，但照样返回 true 挡默认（防 page_ref 被
 * PM 默认 drop 替换掉）。 */
export function createPageDrop(getPageId: () => string | undefined) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('MILKDOWN_PAGE_DROP'),
        props: {
          handleDrop: (view, event) => {
            if (!view.editable) return false
            const target = pageRefDropTarget(view, event)
            if (!target) return false
            setPageRefHighlight(null)
            const src = topBlockDragSource(view)
            const srcId = src ? (typeof src.node.attrs.id === 'string' ? src.node.attrs.id : '') : ''
            const pageId = getPageId()
            if (!pageId || !srcId || src?.node === target.node) return true // 原地 / 无 id：不搬，只挡默认
            console.log('page-drop:guard', JSON.stringify({ pageId, srcId, targetPageId: target.pageId, self: target.pageId === pageId }))
            if (target.pageId === pageId) return true // page_ref 指回当前页（不该出现）：挡默认，不动
            void moveBlockToPage(pageId, srcId, target.pageId)
            return true
          },
        },
      }),
  )
}
