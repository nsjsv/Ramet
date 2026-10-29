/* ---------- page_ref：子页面块节点 ----------
 * 行内 /page/ 链接的块化形态：整行原子卡片。atom 使光标进不去、backspace 一次删整块；
 * 整行可点进子页（handleClickOn，Editor 挂在 configLinkNav，PublicPage 同理跳 /p/）。
 * - attrs { pageId, title, icon }：节点名与 attrs 会被 y-prosemirror 存成 Y.XmlElement('page_ref')，
 *   Editor 与 PublicPage 必须 .use(pageRefSchema)（同名同 attrs），否则公开页解析直接失败；
 *   icon 是目标页面的图标快照（null 表示未设），由 Editor 的同步 effect 从 pages 刷新；
 * - parseDOM 吃 div[data-page-id]：剪贴板往返 / 快照 DOM 反解不丢块；
 * - parseMarkdown 不匹配任何 token：块只能由 slash 创建或由 upgradeLinkBlocks 归一化产生；
 * - toMarkdown 降级成 `[title](/page/pageId)` 链接（md-link，合法 mdast），重新打开时由
 *   upgradeLinkBlocks 归一化回块（见下方共用边界）。
 * 快照面板 VersionHistory 沿用正文 schema（toDOM 渲染），无需单独注册。 */

import { $nodeSchema } from '@milkdown/kit/utils'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { PageIcon } from '../api'
import { twemojiUrl } from '../emoji'
import { pageIconSrc } from '../PageIcon'
import { FILE_URL_RE } from './media'
import { mdLink } from './md-link'
import { COLLECTION_INLINE, COLLECTION_LINK, parseCollectionHref } from './collection-block'

export const pageRefSchema = $nodeSchema('page_ref', () => ({
  group: 'block',
  atom: true, // 原子块：无内容，光标进不去，删除只能整块
  attrs: {
    id: { default: '' }, // 块稳定 ID（editor/block-id.ts 补齐），区块链接体系用
    pageId: { default: '' },
    title: { default: '新页面' },
    // 目标页面的图标快照，与 title 同性质，由 Editor 的同步 effect 从 pages 刷新。
    // 存节点 attrs 而非渲染时查表：toDOM 是纯函数，拿不到 pages；协同 / 公开页读到的也是同一份。
    // 必须是字符串（'emoji:🚀' / 'image:<fileId>'）：Y.XmlElement 的属性是 XML 属性，
    // y-prosemirror 用 setAttribute 原样写入，对象会被 String() 成 '[object Object]' 存进文档。
    // 编解码唯一处：iconAttrOf / iconOfAttr
    icon: { default: null },
  },
  parseDOM: [
    {
      tag: 'div[data-page-id]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        // 图标不进 DOM 文本（emoji / 图片走 <img>，Twemoji 缺图时退回 CSS content），剪贴板反解只拿得到 title
        return { pageId: el.getAttribute('data-page-id') ?? '', title: el.textContent ?? '' }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    { class: 'page-ref', 'data-page-id': node.attrs.pageId },
    pageRefIconDom(iconOfAttr(node.attrs.icon)),
    ['span', { class: 'page-ref-title' }, node.attrs.title || '新页面'],
  ],
  parseMarkdown: {
    // 不接 markdown 解析路径：toMarkdown 导出的链接语法重新打开时是行内链接，由转换 pass 升级为块
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    // 图标不进 markdown（导出格式不变、往返无损）；重新打开后由 Editor 的同步 effect 从 pages 补回
    match: (node) => node.type.name === 'page_ref',
    runner: (state, node) => {
      mdLink(state, node.attrs.title || '新页面', `/page/${node.attrs.pageId}`, true)
    },
  },
}))

/** 图标 attr 编解码（唯一处）：XML 属性只能是字符串，故对象形式在入文档前编码成
 *  'emoji:<字符>' / 'image:<文件 id>'。解码对任何非法 / 历史值返回 null（渲染成通用 glyph），
 *  不让脏数据把编辑器搞崩 */
export function iconAttrOf(icon: PageIcon | null | undefined): string | null {
  if (!icon) return null
  return icon.kind === 'emoji' ? `emoji:${icon.value}` : `image:${icon.value}`
}

export function iconOfAttr(raw: unknown): PageIcon | null {
  if (typeof raw !== 'string') return null
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const kind = raw.slice(0, sep)
  const value = raw.slice(sep + 1)
  if (!value) return null
  if (kind === 'emoji') return { kind: 'emoji', value }
  if (kind === 'image') return { kind: 'image', value }
  return null
}

/** 图标位 DOM（唯一构造处）：emoji 与图片图标都内嵌 <img>（没有 textContent，剪贴板反解 textContent
 *  时才不会把图标字符混进标题）；emoji 是自托管的 Twemoji SVG（emoji.ts），Twemoji 没有的新 emoji
 *  （404）onerror 摘掉 <img>、退回 `content: attr(data-icon)` 画字符（同样不落 DOM 文本）；
 *  未设图标留空 span，CSS 退回通用文档 glyph。
 *  展示 URL 复用 PageIcon / emoji.ts 的唯一入口，不在 schema 里另拼路径 */
function pageRefIconDom(icon: PageIcon | null): HTMLElement {
  const el = document.createElement('span')
  el.className = 'page-ref-icon'
  if (icon?.kind === 'emoji') {
    const img = document.createElement('img')
    img.className = 'page-ref-icon-img is-twemoji'
    img.src = twemojiUrl(icon.value)
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.addEventListener('error', () => {
      img.remove()
      el.setAttribute('data-icon', icon.value)
    })
    el.appendChild(img)
  } else if (icon?.kind === 'image') {
    const img = document.createElement('img')
    img.className = 'page-ref-icon-img'
    img.src = pageIconSrc(icon.value)
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    el.appendChild(img)
  }
  return el
}

/* 降级链接 href 形态（各 toMarkdown 的输出）：与 media.ts 的 FILE_URL_RE 配套 */
const PAGE_REF_HREF_RE = /^\/page\/([^/?#]+)$/
const BLOCK_REF_HREF_RE = /^\/page\/([^/?#]+)\?block=([^&#]+)$/

/* ---------- 降级链接 → 块节点（打开页 migrate pass / 源码模式写回共用） ----------
 * 各自定义块的 toMarkdown 都降级成链接文本（见各 schema），这里是其逆路径，全部形态在
 * 同一边界收敛（源码写回 / 粘贴 markdown / 手写链接，任一入口进来的降级形态都被升回块）：
 * - 顶层段落恰为一个 `/page/<id>` 链接：升成 page_ref（正则带末端锚点，带 ?block= 的不会误吞成 page_ref）；
 * - 顶层段落恰为一个 `/api/files/<uuid>` 链接：升成 attachment（上传卡的降级形态；
 *   size 标签不落地走 0，其余 attrs 无损）；
 * - 顶层段落恰为一个 `collection:<id>?view=<vid>[&link=1]` 链接：升成 collection_inline / collection_link
 *   （集合块的降级形态，记号定义在 collection-block.ts；标题由 Editor 的同步 effect 从页面列表校正）；
 * - 任意文本位的 `/page/<id>?block=<bid>` 链接：升成 block_ref chip（含 block_sync 的降级形态：
 *   markdown 表达不了「实时跟随」，统一落到静态提及，pageId / blockId 无损，重插同步块走
 *   块链接粘贴菜单）。
 * 对 Transaction 原地操作（打开页与源码写回各自组进单事务，即单个撤销步）；先收集后按 pos
 * 降序替换。幂等：升过的节点不再是链接，重跑零 diff；协同多端同时跑也自然收敛。
 * 返回是否真的替换了内容：Editor.tsx 据此 bump editorTick，让升级出的 page_ref 标题
 * 立刻跟随改名（链接文本只是旧 title 的影子）。触发节奏由 Editor.tsx 控制（防抖 500ms，
 * 创建后 + ws synced 后）。 */
export function upgradeLinkBlocks(tr: Transaction): boolean {
  const nodes = tr.doc.type.schema.nodes
  const pageRef = nodes.page_ref
  const attachment = nodes.attachment
  const blockRef = nodes.block_ref
  if (!pageRef || !attachment || !blockRef) return false
  const repls: Array<{ pos: number; size: number; node: ProsemirrorNode }> = []
  tr.doc.descendants((node, pos, parent) => {
    if (node.type.name === 'paragraph') {
      if (parent !== tr.doc || node.childCount !== 1) return
      const child = node.child(0)
      if (!child.isText || child.marks.length !== 1 || child.marks[0]!.type.name !== 'link') return
      const href = child.marks[0]!.attrs.href
      const m = typeof href === 'string' ? PAGE_REF_HREF_RE.exec(href) : null
      if (m) {
        repls.push({ pos, size: node.nodeSize, node: pageRef.create({ pageId: m[1]!, title: child.text || '新页面' }) })
        return
      }
      if (typeof href === 'string' && FILE_URL_RE.test(href)) {
        repls.push({ pos, size: node.nodeSize, node: attachment.create({ src: href, name: child.text || '附件' }) })
        return
      }
      const c = typeof href === 'string' ? parseCollectionHref(href) : null
      const type = c ? nodes[c.link ? COLLECTION_LINK : COLLECTION_INLINE] : undefined
      if (c && type) {
        repls.push({ pos, size: node.nodeSize, node: type.create({ collectionId: c.collectionId, viewId: c.viewId, title: child.text }) })
      }
      return
    }
    // 行内：block_ref chip 的降级形态（与其它文字混排，或独占一段）
    if (!node.isText || node.marks.length !== 1 || node.marks[0]!.type.name !== 'link') return
    const href = node.marks[0]!.attrs.href
    const m = typeof href === 'string' ? BLOCK_REF_HREF_RE.exec(href) : null
    if (m) {
      repls.push({ pos, size: node.nodeSize, node: blockRef.create({ pageId: m[1]!, blockId: m[2]!, text: node.text ?? '' }) })
    }
  })
  for (let i = repls.length - 1; i >= 0; i--) {
    const r = repls[i]! // 降序替换：后面的 pos 不受前面替换影响
    tr.replaceWith(r.pos, r.pos + r.size, r.node)
  }
  return repls.length > 0
}
