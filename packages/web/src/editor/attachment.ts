// ---------- attachment：附件块节点 ----------
// 同 page_ref.ts 的原子卡片：整行一块，光标进不去，点卡片上的链接即下载。
// - attrs { src, name, size }：src 是 /api/files/<uuid> 原文件地址。
//   节点名与 attrs 由 y-prosemirror 存成 Y.XmlElement('attachment')，
//   能看到该节点的 Milkdown 实例（Editor 与 PublicPage）必须 .use(attachmentSchema)，否则解析直接失败。
// - parseDOM 吃 div[data-attachment-src]，剪贴板往返和快照 DOM 反解不丢块。
// - parseMarkdown 不匹配任何 token：块只能由 slash / 粘贴 / 拖拽上传产生。
// - toMarkdown 降级成 `[name](src)` 链接（md-link，合法 mdast），重新打开由 upgradeLinkBlocks
//   归一化回附件卡（size 标签不落地，其余 attrs 无损）。
// VersionHistory 复用正文编辑器的 schema 渲染，无需单独注册。

import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'
/** 字节数转人读尺寸（B/KB/MB），给附件卡片右下角的辅助文字用；未知 / 非法给空串（调用方不渲染该 span） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const attachmentSchema = $nodeSchema('attachment', () => ({
  group: 'block',
  atom: true, // 原子块：无内容，光标进不去，删除只能整块
  attrs: {
    id: { default: '' }, // 块稳定 ID（editor/block-id.ts 补齐），区块链接体系用
    src: { default: '' },
    name: { default: '' },
    size: { default: 0 },
  },
  parseDOM: [
    {
      tag: 'div[data-attachment-src]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          src: el.getAttribute('data-attachment-src') ?? '',
          name: el.getAttribute('data-attachment-name') ?? '',
          size: Number(el.getAttribute('data-attachment-size')) || 0,
        }
      },
    },
  ],
  toDOM: (node) => {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const name = typeof node.attrs.name === 'string' ? node.attrs.name : '附件'
    const size = typeof node.attrs.size === 'number' ? node.attrs.size : Number(node.attrs.size) || 0
    const children: Array<readonly [string, Record<string, string>] | readonly [string, Record<string, string>, string]> = [
      // 图标由 CSS mask 画（styles.css）：span 保持空，剪贴板反解 textContent 才不会混进图标字符
      ['span', { class: 'attachment-icon' }],
      ['span', { class: 'attachment-name' }, name],
    ]
    const label = formatSize(size)
    if (label) children.push(['span', { class: 'attachment-size' }, label])
    // download 属性：公开页（非 contenteditable）点击即走原生下载；编辑器内的下载由
    // media.ts lightboxPlugin 的 handleDOMEvents.click 手动接管（contenteditable 会吞掉链接点击）
    return [
      'div',
      {
        class: 'attachment',
        'data-attachment-src': src,
        'data-attachment-name': name,
        'data-attachment-size': String(size),
      },
      ['a', { href: src, download: name }, ...children],
    ]
  },
  parseMarkdown: {
    // 不接 markdown 解析路径：toMarkdown 导出的链接语法重新打开时是行内链接（可接受的一跳降级）
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node) => node.type.name === 'attachment',
    runner: (state, node) => {
      const name = typeof node.attrs.name === 'string' && node.attrs.name ? node.attrs.name : '附件'
      const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
      mdLink(state, name, src, true)
    },
  },
}))
