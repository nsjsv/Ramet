/* ---------- page_mention：@ 页面引用（行内原子 chip） ----------
 * 正文里打 @ 选中页面后的样子：一颗只显示标题的小胶囊。uuid 与 `@[…](page:…)` 语法都不画。
 * 与 block_ref（editor/block-ref.ts）同档的行内原子节点，attrs 都是字符串：
 * - pageId：身份唯一来源（标题里带 `]` 也拆不碎 chip）；
 * - title：显示快照（目标页改名不回写 chip，同 block_ref.text 的口径）。
 *
 * 与 page_ref 的区别：这不是子页引用，是「提及」。不进 link-watcher 的级联删页
 * （collectLinkedPageIds 只认 page_ref attr 与 `/page/` 开头的 href mark，本节点 href 是
 * `page:<id>`，天然不在其列），也没有标题 / 图标的改名跟随（快照语义）。
 *
 * 三个进出通道：
 * - toDOM / parseDOM：span.page-mention[data-page-mention]，剪贴板往返与快照 DOM 反解不丢 attrs；
 * - toMarkdown 写成 `[@标题](page:<id>)` 链接（md-link，合法 mdast）：形状与 page_ref 的
 *   `/page/<id>` 天然区分，mention-upgrade.ts 只认这一种；
 * - 点击导航走 configLinkNav 的 handleClickOn（Editor 跳 /page/:id，PublicPage 跳 /p/:id）。
 * 服务端口径见 updates.ts：textOf 对这个节点给 `page:<id>`（AI 要用 read_page 读被提到的页，
 * 标题不必再贴一遍）。 */
import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'
import { mentionLabel } from './mention-query'

/** chip 的 DOM 标记属性（parseDOM 认它；与 block-ref 的 data-block-id 同机制） */
export const PAGE_MENTION_ATTR = 'data-page-mention'

export const pageMentionSchema = $nodeSchema('page_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 原子 chip：光标进不去，backspace 一次删整颗
  attrs: {
    pageId: { default: '' },
    title: { default: '' },
  },
  parseDOM: [
    {
      tag: `span[${PAGE_MENTION_ATTR}]`,
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        // 文本就是显示标题（本 chip 不画图标）
        return { pageId: el.getAttribute(PAGE_MENTION_ATTR) ?? '', title: el.textContent ?? '' }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'page-mention', [PAGE_MENTION_ATTR]: node.attrs.pageId },
    ['span', { class: 'page-mention-title' }, node.attrs.title || '新页面'],
  ],
  parseMarkdown: {
    // 不接 markdown 解析路径：toMarkdown 导出的链接由 mention-upgrade.ts 在 parse 边界升回来
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    // 文本带 '@'、href 带 'page:' 前缀：升级时只认这一种形状，别的链接不会被误升成 chip
    match: (node) => node.type.name === 'page_mention',
    runner: (state, node) => {
      const id = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : ''
      mdLink(state, `@${mentionLabel(node.attrs.title)}`, `page:${id}`, false)
    },
  },
}))
