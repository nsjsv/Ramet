/* ---------- 块稳定 ID ----------
 * 可寻址块（判定见 @ramet/shared/block-address）带随机 UUID attr `id`。服务端建块时就写（agents/markdown.ts 的 materialize），
 * 本端新建的块与老数据由补 id 插件在同一次 dispatch 里补齐，y-prosemirror 同步的是补完后的状态。
 * id 只进节点 attrs，toDOM 不输出：剪贴板 / 快照 / markdown 序列化都不带，粘贴进来的块重新发 id。
 *
 * 不变量（补 id 插件独占维护，别处不手动清 / 抄 id）：
 *  1. 每个可寻址块都有非空 id；
 *  2. 一页之内 id 唯一。重复来自 PM 的 split 把原节点 attrs 整份抄给后半段（段落中间回车、splitListItem…）。
 *     重复时身份跟着内容走：文档序第一个有文字的保留，都没文字就第一个保留；其余可寻址的换新 id、不可寻址的清空。
 * 不可寻址节点上残留的 id 保留：按 id 找块是任意深度，旧链接照样能到。
 *
 * 标题的 `id` 在 commonmark 预设里是 slug 锚点，与块 id 是两个概念：预设里去掉了 syncHeadingIdPlugin，
 * 标题 toDOM / parseDOM 不带 id。老文档里已是 slug 的标题 id 非空且唯一，原样当块 id 用。
 *
 * Yjs 存的是节点 attrs，多端同时补 id 时属性 last-writer-wins 收敛为同一 id。公开页不挂补 id 插件，只读文档里已存的 id。
 * schema 覆盖走 milkdown 的 extendSchema：同名 $nodeSchema 在预设之后 .use() 即原位替换（列表项扩的是 gfm 的任务版，保住 checked）。 */

import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  commonmark,
  headingSchema,
  hrSchema,
  insertHrInputRule,
  orderedListSchema,
  paragraphSchema,
  syncHeadingIdPlugin,
} from '@milkdown/kit/preset/commonmark'
import { extendListItemSchemaForTask, footnoteDefinitionSchema, tableSchema } from '@milkdown/kit/preset/gfm'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import type { NodeSchema } from '@milkdown/kit/transformer'
import { $prose, type $NodeSchema } from '@milkdown/kit/utils'
import type { DOMOutputSpec, Node as PMNode, Fragment, TagParseRule } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ySyncPluginKey } from 'y-prosemirror'
import { isAddressable } from '@ramet/shared/block-address'
import { formatColWidths, usableWidths } from './table-widths'
import { presetHeadingEntries } from './heading-level'
import { randomUuid } from '../uuid'

type SpecFactory = (ctx: Ctx) => NodeSchema

/** commonmark 预设去掉 syncHeadingIdPlugin、预设自带的标题键位 / 输入规则（放得到 6 级，由 heading-level.ts 按 1–3 级接手），
 * 以及 `---` 输入规则（会把整段换成被选中的 hr，由 markdown.ts 的 insertHrBefore 接手）。编辑器与公开页都 .use 这一份 */
export const commonmarkPreset: MilkdownPlugin[] = commonmark.filter(
  (p) => p !== syncHeadingIdPlugin && p !== insertHrInputRule && !presetHeadingEntries.has(p),
)

/** 在原 spec 上追加 `id: { default: '' }`（及 extraAttrs），其余原样透传。原 spec 自带的同名 attr（heading 的 id）以原 spec 为准。 */
function withBlockId<T extends string>(
  exported: $NodeSchema<T>,
  extraAttrs: Record<string, { default: string | boolean }> = {},
  patch: (spec: NodeSchema) => Partial<NodeSchema> = () => ({}),
): $NodeSchema<T> {
  return exported.extendSchema((prev: SpecFactory) => (ctx: Ctx) => {
    const spec = prev(ctx)
    return { ...spec, attrs: { ...extraAttrs, id: { default: '' }, ...spec.attrs }, ...patch(spec) }
  })
}

/** 标题：DOM 上不带 id（剪贴板往返不复制块身份，同其它块）；读 DOM 只取 level */
function headingWithoutDomId(spec: NodeSchema): Partial<NodeSchema> {
  const toDOM = spec.toDOM
  return {
    toDOM: (node) => {
      const [tag, attrs, hole] = toDOM!(node) as [string, Record<string, unknown>, 0]
      const { id: _slug, ...rest } = attrs
      return [tag, rest, hole]
    },
    parseDOM: (spec.parseDOM ?? []).map(
      (rule): TagParseRule => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs ? rule.getAttrs(dom) : null
          return attrs ? { level: attrs.level } : attrs
        },
      }),
    ),
  }
}

export const paragraphIdSchema = withBlockId(paragraphSchema)
export const headingIdSchema = withBlockId(headingSchema, {}, headingWithoutDomId)
/** 代码块：另带 `wrap`（自动换行，默认开；code-view.ts 顶栏的「换行」按钮切换，markdown 不带）。toDOM 只在关掉时
 *  写 `data-wrap="false"`（静态宿主 / 剪贴板认它，样式见 code.css），parseDOM 读回 */
function codeBlockWithWrap(spec: NodeSchema): Partial<NodeSchema> {
  const toDOM = spec.toDOM
  return {
    toDOM: (node) => {
      const [tag, attrs, hole] = toDOM!(node) as [string, Record<string, unknown>, DOMOutputSpec]
      return [tag, node.attrs.wrap === false ? { ...attrs, 'data-wrap': 'false' } : attrs, hole]
    },
    parseDOM: (spec.parseDOM ?? []).map(
      (rule): TagParseRule => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs ? rule.getAttrs(dom) : null
          return attrs && dom instanceof HTMLElement ? { ...attrs, wrap: dom.dataset.wrap !== 'false' } : attrs
        },
      }),
    ),
  }
}
export const codeBlockIdSchema = withBlockId(codeBlockSchema, { wrap: { default: true } }, codeBlockWithWrap)
/** 引用块是用户的普通引用（`> `）。另带 `agent`，只作旧数据迁移输入：旧数据里 AI 回复是带 agent 属性的单层引用块，
 * 打开页时由 message-blocks.ts 的 upgradeMessageBlocks 升成 agent_reply 块。声明不能撤，否则 y-prosemirror 先把属性丢掉，
 * 旧页面就认不出自己的 AI 回复了。 */
export const blockquoteIdSchema = withBlockId(blockquoteSchema, { agent: { default: '' } })
export const hrIdSchema = withBlockId(hrSchema)
export const bulletListIdSchema = withBlockId(bulletListSchema)
export const orderedListIdSchema = withBlockId(orderedListSchema)
export const listItemIdSchema = withBlockId(extendListItemSchemaForTask)
/** 表格：另带 `colwidths`（列宽串，见 table-widths.ts）；toDOM 按它画 colgroup（静态宿主 / 公开页 / 剪贴板同样带宽度），
 *  parseDOM 读回（剪贴板往返） */
function tableWithColWidths(): Partial<NodeSchema> {
  return {
    toDOM: (node) => {
      const widths = usableWidths(node.attrs.colwidths, node.firstChild?.childCount ?? 0)
      if (!widths.length) return ['table', ['tbody', 0]]
      const total = widths.reduce((a, b) => a + b, 0)
      return [
        'table',
        { class: 'has-colwidths', style: `width: ${total}px` },
        ['colgroup', ...widths.map((w) => ['col', { style: `width: ${w}px` }])],
        ['tbody', 0],
      ]
    },
    parseDOM: [
      {
        tag: 'table',
        getAttrs: (dom) => {
          const cols = dom instanceof HTMLElement ? [...dom.querySelectorAll(':scope > colgroup > col')] : []
          const widths = cols.map((c) => parseFloat((c as HTMLElement).style.width) || 0)
          return { colwidths: widths.length && widths.every((w) => w > 0) ? formatColWidths(widths) : '' }
        },
      },
    ],
  }
}
export const tableIdSchema = withBlockId(tableSchema, { colwidths: { default: '' } }, tableWithColWidths)
export const footnoteDefinitionIdSchema = withBlockId(footnoteDefinitionSchema)

/** Editor / PublicPage 一起 .use 的数组（必须排在 commonmark 与 gfm 之后，同名原位替换）。
 * 要拍平成单个插件再给 use：$NodeSchema 元组不能直接当 MilkdownPlugin 数组元素。
 * 自有块（page_ref / attachment / block_sync / 消息块）在各自 schema 里声明 id。 */
export const blockIdSchemas: MilkdownPlugin[] = [
  paragraphIdSchema,
  headingIdSchema,
  codeBlockIdSchema,
  blockquoteIdSchema,
  hrIdSchema,
  bulletListIdSchema,
  orderedListIdSchema,
  listItemIdSchema,
  tableIdSchema,
  footnoteDefinitionIdSchema,
].flat()

/* ---------- 补 id：补缺 + 去重（纯函数，插件与单测共用） ---------- */

export type BlockIdPatch = { pos: number; id: string }

type Holder = { pos: number; node: PMNode; addressable: boolean }

/** 算出让文档满足不变量所需的 id 改写（全合规返回空数组）。只走块级节点，文本块与原子块不再下钻。
 * 改写只动 attrs、不改尺寸，返回的 pos 对同一份 doc 依次 setNodeMarkup 都有效。 */
export function planBlockIds(doc: PMNode, newId: () => string): BlockIdPatch[] {
  // 空片段渲染出的占位文档（schema 默认的一个空段落）不是内容，不发 id。y-prosemirror 只在文档与
  // createAndFill() 不同时才把它写进 Yjs：给占位补 id 会让它变成内容被写进共享文档，新设备在服务端内容
  // 到达前建好编辑器时，它与随后到达的正文并发合并，正文首尾就多出一个空段落。
  const placeholder = doc.type.createAndFill()
  if (placeholder && doc.content.findDiffStart(placeholder.content) === null) return []
  const patches: BlockIdPatch[] = []
  const byId = new Map<string, Holder[]>()
  doc.descendants((node, pos, parent) => {
    if (!node.isBlock) return false
    const id: unknown = node.attrs.id
    if (typeof id === 'string') {
      const addressable = isAddressable(node.type.name, !parent || parent === doc ? null : parent.type.name)
      if (id) {
        const list = byId.get(id)
        if (list) list.push({ pos, node, addressable })
        else byId.set(id, [{ pos, node, addressable }])
      } else if (addressable) {
        patches.push({ pos, id: newId() })
      }
    }
    return !node.isTextblock && !node.isAtom
  })
  for (const holders of byId.values()) {
    if (holders.length < 2) continue
    const keeper = holders.find((h) => h.node.textContent !== '') ?? holders[0]!
    for (const h of holders) if (h !== keeper) patches.push({ pos: h.pos, id: h.addressable ? newId() : '' })
  }
  return patches
}

/* 补 id 插件：docChanged 的事务后算一次 planBlockIds，有改写就单事务写回。
 * 老文档打开时 ySyncPlugin 首次灌内容的 transaction 就带 docChanged，所以打开即补齐；
 * 改写本身满足不变量，下一轮返回 null，不会产生无限事务。
 * Yjs 到 PM 方向（首灌 / 远端）触发的改写不进撤销栈：appended tr 不带 addToHistory meta 时 ySyncPlugin
 * 会把它刷回 true（同 list-blocks.ts）。
 * editable 守卫：viewer 实例也不写。 */
export const ensureBlockIds = $prose(() => {
  let editable = true
  return new Plugin({
    key: new PluginKey('MILKDOWN_BLOCK_ID'),
    appendTransaction: (trs, _old, newState) => {
      if (!editable) return null
      if (!trs.some((tr) => tr.docChanged)) return null
      const patches = planBlockIds(newState.doc, randomUuid)
      if (patches.length === 0) return null
      const tr = newState.tr
      for (const { pos, id } of patches) tr.setNodeAttribute(pos, 'id', id)
      if (trs.some((t) => t.getMeta(ySyncPluginKey)?.isChangeOrigin)) tr.setMeta('addToHistory', false)
      return tr
    },
    view: (view) => {
      editable = view.editable
      return {
        update: (v) => {
          editable = v.editable
        },
      }
    },
  })
})

/* ---------- 查询 / 定位 ---------- */

export type FoundBlock = { node: PMNode; pos: number; parent: PMNode | null }

/** 按 id 找块（任意深度；`root` 为 doc 时 pos 是文档位置，为 Fragment 时是片段内偏移），找不到返回 null。
 * 这是按块 id 找块的唯一实现：`?block=` 定位、拖块进页面、同步块渲染都走这里。 */
export function findBlock(root: PMNode | Fragment, id: string): FoundBlock | null {
  if (!id) return null
  let found: FoundBlock | null = null
  root.descendants((node, pos, parent) => {
    if (found) return false
    if (!node.isBlock) return false
    if (node.attrs.id === id) {
      found = { node, pos, parent: parent ?? null } // Fragment 的顶层子节点没有 parent（undefined）
      return false
    }
    return !node.isTextblock && !node.isAtom
  })
  return found
}

/** id 对应块的文档位置（任意深度），找不到返回 null */
export function findBlockIdPos(doc: PMNode, id: string): number | null {
  return findBlock(doc, id)?.pos ?? null
}

/** pos 处块的 id（空串 / 无 id attr / 无节点返回 null），复制链接前校验用 */
export function blockIdAt(view: EditorView, pos: number): string | null {
  const node = view.state.doc.nodeAt(pos)
  const id: unknown = node?.attrs.id
  return typeof id === 'string' && id ? id : null
}

/** 直访定位：滚动到块（视口居中）并闪烁高亮。找到了返回 true，调用方据此结束重试。 */
export function focusBlockById(view: EditorView, id: string): boolean {
  const pos = findBlockIdPos(view.state.doc, id)
  if (pos === null) return false
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return false
  dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // 重入防护：先摘旧类再强制 reflow，让同一块连续定位时动画重跑
  dom.classList.remove('block-link-flash')
  void dom.offsetWidth
  dom.classList.add('block-link-flash')
  const stop = () => dom.classList.remove('block-link-flash')
  dom.addEventListener('animationend', stop, { once: true })
  window.setTimeout(stop, 2200) // 动画被中断（块被协同端删掉等）的兜底摘除
  return true
}
