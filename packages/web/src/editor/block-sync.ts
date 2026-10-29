/* ---------- block_sync：同步块（实时跟随源块内容的块级节点） ----------
 * 粘贴三选弹窗（editor/block-link-paste.ts）选同步块时插入。atom 块级节点，
 * attrs { id, pageId, blockId }，内容永不落本页文档，实时从源页 Y.Doc 拉取渲染。
 *
 * attrs.id 是同步块自己的块 id（可寻址块不变量，见 block-id.ts），blockId 是它显示的源块，两者无关。
 * 复制同步块的链接给的是源块链接（block-menu.ts），所以不会出现同步块的同步块。
 *
 * 渲染（nodeView，仅编辑器挂）：
 * - 自持第二个 HocuspocusProvider 连源页（`page:<pageId>`）；服务端 collab 鉴权（非成员 4403）
 *   天然闸住越权引用，close(4401 / 4403) 时切占位「无法加载」并停连；
 * - synced / doc.observeDeep 时 yXmlFragmentToProseMirrorFragment 全量转 fragment，findBlock 任意深度找
 *   attrs.id === blockId（源块是列表项时套一层同类型父列表，否则 <li> 没有列表外壳，标记 / 勾选框画不出），
 *   再用 DOMSerializer 全量重画（块级内容小，毫秒级，不做增量 diff；同页多个同步块各自开一条 ws）；
 * - 源页里没有该 id（源块已删 / 老文档未补 id）时占位「源块不存在」；
 * - destroy：摘 observer 并 provider.destroy()；渲染中标志 + view.isDestroyed 门闩防重入。
 *
 * 无 nodeView 的场景（PublicPage 只读渲染 / 快照面板）：toDOM 输出 .block-sync-static 占位。
 * parseDOM 用 data-sync-page-id / data-sync-block-id 专有属性：避开 page_ref 的
 * div[data-page-id] 规则（PM 按注册序取第一个命中的规则，粘贴往返不能串成 page_ref）。 */

import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { mdLink } from './md-link'
import { schemaCtx } from '@milkdown/kit/core'
import { hydrateRich } from './rich-render'
import { DOMSerializer, Fragment } from '@milkdown/kit/prose/model'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Ctx } from '@milkdown/kit/ctx'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorFragment } from 'y-prosemirror'
import { collabUrl } from './collab-url'
import { findBlock, type FoundBlock } from './block-id'

export const blockSyncSchema = $nodeSchema('block_sync', () => ({
  group: 'block',
  atom: true, // 原子块：内容自持，光标进不去，删除整块
  attrs: {
    id: { default: '' }, // 自己的块 id（block-id.ts 补齐）
    pageId: { default: '' }, // 源页
    blockId: { default: '' }, // 源块
  },
  parseDOM: [
    {
      tag: 'div[data-sync-block-id]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          pageId: el.getAttribute('data-sync-page-id') ?? '',
          blockId: el.getAttribute('data-sync-block-id') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'block-sync block-sync-static',
      'data-sync-page-id': node.attrs.pageId,
      'data-sync-block-id': node.attrs.blockId,
    },
    ['span', { class: 'block-sync-hint' }, '同步块'],
  ],
  parseMarkdown: {
    // 不接 markdown 解析路径：toMarkdown 导出的链接由 upgradeLinkBlocks 升回块级降级形态
    // （?block= 链接统一升 block_ref chip，markdown 表达不了实时同步）
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node) => node.type.name === 'block_sync',
    runner: (state, node) => {
      mdLink(state, '同步块', `/page/${node.attrs.pageId}?block=${node.attrs.blockId}`, true)
    },
  },
}))

/** 源块单独拿出来渲染的形态：列表项套一层只含它的父列表（同类型、同 attrs），其余原样 */
function standalone({ node, parent }: FoundBlock): PMNode {
  return node.type.name === 'list_item' && parent ? parent.type.create(parent.attrs, node) : node
}

/** 同步块 nodeView（$view 注册进 nodeViewCtx，同 @milkdown/components code-block 的挂法）。
 * 工厂在 SchemaReady 后才被调，直接读最终 schema（含 blockIdSchemas 覆盖后的节点）。 */
export const blockSyncView = $view(blockSyncSchema.node, (ctx: Ctx) => {
  const serializer = DOMSerializer.fromSchema(ctx.get(schemaCtx))
  return (node: PMNode, view: EditorView) => {
    const dom = document.createElement('div')
    dom.className = 'block-sync'
    dom.textContent = '加载中…'

    const pageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : ''
    const blockId = typeof node.attrs.blockId === 'string' ? node.attrs.blockId : ''
    let destroyed = false
    let rendering = false
    let provider: HocuspocusProvider | null = null
    let fragment: Y.XmlFragment | null = null

    const placeholder = (text: string): void => {
      dom.className = 'block-sync block-sync-static'
      dom.textContent = text
    }

    const teardownProvider = (): void => {
      if (fragment) {
        fragment.unobserveDeep(render)
        fragment = null
      }
      provider?.destroy()
      provider = null
    }

    // 全量重画：synced 和源页任何变更（observeDeep）都会走到这里。防重入 + 销毁门闩。
    const render = (): void => {
      if (destroyed || rendering || !fragment || view.isDestroyed) return
      rendering = true
      try {
        const frag = yXmlFragmentToProseMirrorFragment(fragment, view.state.schema)
        const found = findBlock(frag, blockId)
        if (!found) {
          placeholder('源块不存在')
          return
        }
        const content = document.createElement('div')
        content.className = 'block-sync-content'
        // 用外层编辑器 schema 的 serializer 输出源块节点（含 p / h1 等包装标签，排版跟随本页样式）
        serializer.serializeFragment(Fragment.from(standalone(found)), { document }, content)
        dom.className = 'block-sync'
        dom.replaceChildren(content)
        hydrateRich(dom) // 代码高亮 / mermaid（静态序列化的内容，见 rich-render.ts）
      } catch (err) {
        console.error('block_sync 渲染失败:', err)
        placeholder('无法加载')
      } finally {
        rendering = false
      }
    }

    if (pageId && blockId) {
      provider = new HocuspocusProvider({ url: collabUrl(), name: `page:${pageId}` })
      fragment = provider.document.getXmlFragment('prosemirror')
      fragment.observeDeep(render)
      provider.on('synced', render)
      provider.on('close', (payload: { event?: { code?: number } }) => {
        if (destroyed) return
        const code = payload?.event?.code
        // 4401 / 4403 是服务端 collab 鉴权拒绝（非成员 / 页面不存在）：切占位并停连
        // （provider 会自动重连，越权引用不该无限重试）。普通断线不清，重连后照常渲染。
        // 停连推迟到微任务：不能在 provider 自身 close 事件回调里同步 destroy（emit 迭代中摘监听器）
        if (code === 4403 || code === 4401) {
          placeholder('无法加载')
          queueMicrotask(() => {
            if (!destroyed) teardownProvider()
          })
        }
      })
    } else {
      placeholder('无法加载')
    }

    return {
      dom,
      destroy() {
        destroyed = true
        teardownProvider()
      },
    }
  }
})
