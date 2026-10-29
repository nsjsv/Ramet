/* ---------- 集合块：collection_inline（「集合」块，块拥有数据）与 collection_link（「链接视图」块） ----------
 * attrs { id, collectionId, viewId, title } 全是字符串（Y.XmlElement 的属性只能是字符串）；id 是块 id（顶层块，
 * 见 shared/block-address.ts，补 id 插件统一处理），title 是集合名快照（Editor 的同步 effect 从页面列表刷新，同 page_ref）。
 * - 两个宿主（editor-session.ts、PublicPage.tsx）都要 .use 两个 schema：Y.Doc 里出现未注册节点会让整页解析失败；
 * - toDOM 是静态占位（公开页 / 快照面板没有 nodeView）：集合名加「集合暂不支持公开查看」；
 * - parseDOM 吃专有的 data-collection-* 属性，避开 page_ref 的 div[data-page-id]（PM 按注册序取第一个命中的规则）；
 * - parseMarkdown 不匹配：toMarkdown 降级成一行专用链接 `[名称](collection:<id>?view=<viewId>)`（链接视图带 `&link=1`），
 *   解析边界由 page-ref.ts 的 upgradeLinkBlocks 升回块（与 page_ref 同一处）。服务端不解析这个记号，md-dialect 不用改；
 * - 粘贴与「复制」副本：collection_inline 一律转成 collection_link（复制不产生新的所有者），块 id 交给 planBlockIds 去重；
 *   编辑器内拖动搬块不转（搬家不是复制）。
 * 编辑器里的渲染（React 根 + CollectionSurface）在 collection/block-view.tsx。 */

import { $nodeSchema, $prose } from '@milkdown/kit/utils'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { COPY } from '../copy'
import { mdLink } from './md-link'

export const COLLECTION_INLINE = 'collection_inline'
export const COLLECTION_LINK = 'collection_link'

export type CollectionBlockAttrs = { id: string; collectionId: string; viewId: string; title: string }

const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '')

/** 节点 attrs 转规范形状（脏数据读成空串，免得渲染炸） */
export function blockAttrs(node: PMNode): CollectionBlockAttrs {
  return { id: str(node.attrs.id), collectionId: str(node.attrs.collectionId), viewId: str(node.attrs.viewId), title: str(node.attrs.title) }
}

export function isCollectionBlock(name: string): boolean {
  return name === COLLECTION_INLINE || name === COLLECTION_LINK
}

/* ---------- 源码模式的链接记号（toMarkdown 与 upgradeLinkBlocks 的唯一定义） ---------- */

/** 集合 id / 视图 id 的字符集：uuid 与 6 位 base36 都在里面，链接里带了别的字符就不认 */
const ID = '[0-9a-zA-Z-]+'
const HREF_RE = new RegExp(`^collection:(${ID})(?:\\?view=(${ID})?)?(&link=1)?$`)

export function collectionHref(collectionId: string, viewId: string, link: boolean): string {
  return `collection:${collectionId}?view=${viewId}${link ? '&link=1' : ''}`
}

/** collectionHref 的逆，认不出返回 null */
export function parseCollectionHref(href: string): { collectionId: string; viewId: string; link: boolean } | null {
  const m = HREF_RE.exec(href)
  if (!m) return null
  return { collectionId: m[1]!, viewId: m[2] ?? '', link: m[3] !== undefined }
}

/* ---------- 节点 ---------- */

const attrs = {
  id: { default: '' },
  collectionId: { default: '' },
  viewId: { default: '' },
  title: { default: '' },
}

function nodeSpec(name: typeof COLLECTION_INLINE | typeof COLLECTION_LINK) {
  const link = name === COLLECTION_LINK
  return () => ({
    group: 'block',
    atom: true, // 数据不在本页文档里，光标进不去，删除整块
    selectable: true,
    attrs,
    parseDOM: [
      {
        tag: link ? 'div[data-collection-id][data-collection-link]' : 'div[data-collection-id]:not([data-collection-link])',
        getAttrs: (dom: HTMLElement | string) => {
          const el = dom as HTMLElement
          return {
            collectionId: el.getAttribute('data-collection-id') ?? '',
            viewId: el.getAttribute('data-collection-view') ?? '',
            title: el.getAttribute('data-collection-title') ?? '',
          }
        },
      },
    ],
    toDOM: (node: PMNode) => {
      const a = blockAttrs(node)
      return [
        'div',
        {
          class: 'cl-block cl-block-static',
          'data-collection-id': a.collectionId,
          'data-collection-view': a.viewId,
          'data-collection-title': a.title,
          ...(link ? { 'data-collection-link': '1' } : {}),
        },
        ['span', { class: 'cl-block-static-title' }, a.title || COPY.untitled],
        ['span', { class: 'cl-block-static-hint' }, COPY.collection.embed.publicHint],
      ] as const
    },
    parseMarkdown: {
      match: () => false,
      runner: () => {},
    },
    toMarkdown: {
      match: (node: PMNode) => node.type.name === name,
      runner: (state: Parameters<typeof mdLink>[0], node: PMNode) => {
        const a = blockAttrs(node)
        mdLink(state, a.title || COPY.untitled, collectionHref(a.collectionId, a.viewId, link), true)
      },
    },
  })
}

export const collectionInlineSchema = $nodeSchema(COLLECTION_INLINE, nodeSpec(COLLECTION_INLINE))
export const collectionLinkSchema = $nodeSchema(COLLECTION_LINK, nodeSpec(COLLECTION_LINK))

/* ---------- 粘贴 / 副本：集合块一律变链接视图 ---------- */

/** 内容里的 collection_inline 换成同 attrs 的 collection_link（任意深度，块 id 原样，去重交给 planBlockIds）。
 *  粘贴（transformPasted）与块菜单 / Mod-D 的「复制」（block-menu.ts、block-ops.ts）共用，任何复制都不产生新的所有者 */
export function inlineAsLinks(content: Fragment, schema: Schema): Fragment {
  const link = schema.nodes[COLLECTION_LINK]
  if (!link) return content
  let changed = false
  const map = (fragment: Fragment): Fragment => {
    const out: PMNode[] = []
    fragment.forEach((node) => {
      if (node.type.name === COLLECTION_INLINE) {
        changed = true
        out.push(link.create(node.attrs))
      } else out.push(node.isLeaf ? node : node.copy(map(node.content)))
    })
    return Fragment.fromArray(out)
  }
  const mapped = map(content)
  return changed ? mapped : content
}

export function pastedAsLinks(slice: Slice, schema: Schema): Slice {
  const content = inlineAsLinks(slice.content, schema)
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

export const collectionPaste = $prose(
  () =>
    new Plugin({
      key: new PluginKey('rametCollectionPaste'),
      props: {
        // PM 对编辑器内的拖放（手柄拖起单块，view.dragging.move）同样过 transformPasted：那是搬家不是复制，
        // 转成链接视图的话原块被删，存储钩子随后会把集合回收
        transformPasted: (slice, view) => (view.dragging?.move ? slice : pastedAsLinks(slice, view.state.schema)),
      },
    }),
)

/** markdown 粘贴（markdown.ts 的 configPaste，绕过 transformPasted）：独占一段的集合记号直接变链接视图块。
 *  复制集合块时剪贴板的纯文本是它的源码记号，不在这里拦就会以链接段落进文档，下次打开被升成 collection_inline */
export function pastedMarkdownLinks(content: Fragment, schema: Schema): Fragment {
  const link = schema.nodes[COLLECTION_LINK]
  if (!link) return content
  let changed = false
  const out: PMNode[] = []
  content.forEach((node) => {
    const child = node.type.name === 'paragraph' && node.childCount === 1 ? node.child(0) : null
    const mark = child?.isText && child.marks.length === 1 && child.marks[0]!.type.name === 'link' ? child.marks[0]! : null
    const c = mark && typeof mark.attrs.href === 'string' ? parseCollectionHref(mark.attrs.href) : null
    if (c && child) {
      changed = true
      out.push(link.create({ collectionId: c.collectionId, viewId: c.viewId, title: child.text ?? '' }))
    } else out.push(node)
  })
  return changed ? Fragment.fromArray(out) : content
}

/** 这一块（或它里面任意深度，如分栏、折叠块里）有没有「集合」块。跨页搬块据此整体拒绝（page-drop.ts）：
 *  集合归宿主页的块所有，块搬到别页后原页的块消失，存储钩子会把集合回收；链接视图块不受限 */
export function hasInlineCollection(node: PMNode): boolean {
  if (node.type.name === COLLECTION_INLINE) return true
  let found = false
  node.descendants((child) => {
    if (found) return false
    if (child.type.name === COLLECTION_INLINE) found = true
    return !found
  })
  return found
}
