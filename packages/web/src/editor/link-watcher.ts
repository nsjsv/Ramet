// 正文里删掉子页引用（page_ref 块 / 行内 /page/ 链接）后，防抖 2s 级联删子页的 watcher。
// 状态（linkedChildren set、2s 防抖 timer、destroyed 门闩）收在 createLinkWatcher 工厂里，
// 编辑器会话每次建立调一次，卸载时调 destroy()。
// linkedChildren 记录「本端经 slash 创建过链接的子页」+ 历次扫描到的链接目标：
// 扫描时先比对旧成员再播种新成员（新增永不触发删除），因此只有链接消失过的 id 会被删；
// 侧栏树建的子页从未进过 set，天然不误删；首次扫描（防抖后）只播种不删除。
// 删除带结构守卫：页的 parent_id 已改挂别页（树上拖拽，Sidebar 只做文档镜像摘引用）→ 只清理
// 不删页；仍挂在本页（slash 子页语义：删引用块 = 删页）才删。删除走 REST + onChanged 广播，
// 不 dispatch 事务，不干扰协同；协同端删同一链接时两端都会尝试 deletePage，404（对方已删）
// 静默吞掉。

import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { api, type Page } from '../api'
import { syncPagesNow } from '../page-sync'

// 收集正文里所有指向子页的 id：page_ref 是主形态，扫原子块 attrs.pageId；行内链接仍扫 link mark href。
// 两个通道覆盖同一份「子页被引用」事实，watcher 的播种 / 消失判定逻辑相同
function collectLinkedPageIds(doc: ProsemirrorNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === 'page_ref') {
      const pageId = node.attrs.pageId
      if (typeof pageId === 'string' && pageId) ids.add(pageId)
      return false // 原子块无内容，不再下钻
    }
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') continue
      const href = mark.attrs.href
      if (typeof href !== 'string') continue
      const m = /^\/page\/([^/?#]+)/.exec(href)
      const pageId = m?.[1]
      if (pageId) ids.add(pageId)
    }
  })
  return ids
}

export interface LinkWatcherDeps {
  /** 当前页 id：扫描时 pid === getPageId() 跳过（文档链到当前页自身的场景不自杀，树上另有 navigate('/') 兜底） */
  getPageId: () => string | undefined
  /** 只读端不挂 watcher（viewer 无删页权限）：plugin 为 undefined，调用方不得挂载 */
  isReadOnly: boolean
  /** 删页成功后触发侧栏树刷新 */
  onChanged: () => void
  /** 取正文视图读 doc：经 milkdown editorViewCtx */
  getView: () => EditorView | undefined
  /** 当前页面列表（App 的 pages，经编辑器的 pagesRef）；null = 还没加载 */
  getPages: () => readonly Page[] | null
}

export function createLinkWatcher(deps: LinkWatcherDeps) {
  const linkedChildren = new Set<string>()
  let linkScanTimer: number | undefined
  let destroyed = false

  const scanLinkedChildren = async () => {
    linkScanTimer = undefined
    if (destroyed) return
    const view = deps.getView()
    if (!view) return
    const found = collectLinkedPageIds(view.state.doc)
    const removed: string[] = []
    for (const pid of linkedChildren) if (!found.has(pid)) removed.push(pid)
    for (const pid of found) linkedChildren.add(pid)
    const selfId = deps.getPageId()
    for (const pid of removed) {
      if (pid === selfId) continue // 保险：文档链到当前页自身的场景不自杀（树上另有 navigate('/') 兑底）
      // 结构守卫：引用块消失不等于结构删除。树上拖拽改挂别页（Sidebar 文档镜像摘旧父页引用）时，
      // 页的 parent_id 已指向别页，此时摘引用只是清理镜像，级联删页会删掉刚挪走的页。
      // 仍挂在本页（slash 子页语义：删引用块 = 删页）才删；查不到结构时宁可不删。
      // 先看本地列表：已经知道挪走了就不删，也不发请求。
      // 本地还挂在本页时不能就此删：本地列表可能还没跟上刚才的 PATCH（别的协作者的同步慢于摘引用），
      // 发一次增量同步拿服务端现状再判（PATCH 先于摘引用完成，这次同步必然看得见）。拿不到就不删
      const local = deps.getPages()?.find((p) => p.id === pid)
      if (local && local.parent_id !== selfId) continue
      const list = await syncPagesNow()
      if (!list) continue
      const page = list.find((p) => p.id === pid)
      if (page && page.parent_id !== selfId) continue
      api.deletePage(pid).then(deps.onChanged).catch((err: unknown) => console.error('delete unlinked child failed:', err))
    }
  }
  const scheduleLinkScan = () => {
    if (linkScanTimer !== undefined) window.clearTimeout(linkScanTimer)
    linkScanTimer = window.setTimeout(scanLinkedChildren, 2000)
  }

  // watcher 写成 $prose slice（同 selectBlocks 写法）：插件随 EditorState 一起建，
  // 闭包直接捕获 scheduleLinkScan；prosemirror-view 1.42 已无 registerPlugin，事后挂插件没有官方通道。
  // 只读端为 undefined：调用方不挂（viewer 无删页权限）
  const plugin = deps.isReadOnly
    ? undefined
    : $prose(
        () =>
          new Plugin({
            view: () => ({
              update: (v: EditorView, prevState: EditorState) => {
                // docChanged 判定用引用比较：PM 事务带 step 必产出新 doc 对象、无 step 保持原引用，
                // 免去每次 update 的全树 eq 遍历；真正的扫描在防抖 2s 后跑
                if (v.state.doc === prevState.doc) return
                scheduleLinkScan()
              },
            }),
          }),
      )

  return {
    /** 挂到正文编辑器：`if (watcher.plugin) instance.use(watcher.plugin)`；只读端为 undefined */
    plugin,
    /** slash「创建页面」成功后登记：先登记再插链接，之后此链接消失才会触发删页 */
    onChildLinked(pageId: string): void {
      void linkedChildren.add(pageId)
    },
    /** effect 卸载：置 destroyed 门闩并清防抖 timer */
    destroy(): void {
      destroyed = true
      if (linkScanTimer !== undefined) window.clearTimeout(linkScanTimer)
    },
  }
}
