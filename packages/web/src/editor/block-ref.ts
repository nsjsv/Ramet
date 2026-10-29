/* ---------- block_ref：块提及（行内 chip） ----------
 * 提及形态的区块链接：行内原子 chip，文本是插入时刻的源块快照（不实时跟随，实时走 block_sync 同步块）。
 * 粘贴三选弹窗（editor/block-link-paste.ts）选「提及」时插入。
 * - attrs { pageId, blockId, text }：chip 内容不可编辑，text 只作展示和剪贴板往返；
 * - toDOM 输出 span.block-ref[data-page-id][data-block-id] + 文本，parseDOM 反解同款，剪贴板往返不丢 attrs；
 *   图标由 CSS 画（styles/editor.css）；
 * - 点击导航走 configLinkNav 的 handleClickOn（Editor 跳 /page/:id?block=，PublicPage 跳 /p/:id?block=），
 *   与 page_ref 同机制：行内原子节点是 $pos.nodeAfter，PM 会把它作为上下文调进 handleClickOn；
 * - toMarkdown 降级成 `[text](/page/:id?block=)` 链接（md-link），重新打开由 upgradeLinkBlocks 升回 chip，同 page_ref；
 * - 不进 link-watcher：block_ref / block_sync 不算子页引用，不触发级联删页
 *   （collectLinkedPageIds 只认 page_ref 与 /page/ href mark）。 */
import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'

export const blockRefSchema = $nodeSchema('block_ref', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 原子 chip：光标进不去，backspace 一次删整块
  attrs: {
    pageId: { default: '' },
    blockId: { default: '' },
    text: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span[data-block-id]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          pageId: el.getAttribute('data-page-id') ?? '',
          blockId: el.getAttribute('data-block-id') ?? '',
          text: el.textContent ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'block-ref', 'data-page-id': node.attrs.pageId, 'data-block-id': node.attrs.blockId },
    // 文本直接作为 chip 内容，剪贴板反解 textContent 才拿得到快照（图标由 CSS ::before 画，不进文本）
    typeof node.attrs.text === 'string' && node.attrs.text ? node.attrs.text : '块引用',
  ],
  parseMarkdown: {
    // 不接 markdown 解析路径：toMarkdown 导出的链接语法重新打开时是行内链接（同 page_ref）
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node) => node.type.name === 'block_ref',
    runner: (state, node) => {
      mdLink(
        state,
        typeof node.attrs.text === 'string' && node.attrs.text ? node.attrs.text : '块引用',
        `/page/${node.attrs.pageId}?block=${node.attrs.blockId}`,
        false,
      )
    },
  },
}))
