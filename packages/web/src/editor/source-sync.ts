// ---------- 源码模式的同步会话：源码编辑器 ↔ 协同文档 ----------
// 一次源码会话（进入源码模式到退出 / 换页）一个 SourceSession。它持有「上次同步」的基线：
//   baseText   当时源码编辑器里的文本；
//   base       当时文档里进了源码的顶层块（带 id 与全部 attrs）；
//   baseParsed baseText 经同一解析管线的结果，与 base 逐个对应（不对应 = 本会话退回整篇写回，控制台告警）。
// 写回（本地 → 文档）：停止输入 IDLE_MS、失焦、会话结束时，按 source-merge.ts 的块级三方合并只改本端动过的块；
//   写回后基线 = 用户的原文（不把刚打的字重排成规范写法）。
// 回流（文档 → 本地）：sourceWatch 插件报告文档变了（别人 / agent 改的；本会话自己的写回不报）。本端没有未写回的改动、
//   也不在组字时，REMOTE_MS 防抖后把源码换成文档的规范文本（最小行级补丁，光标不跳）；否则等写回之后再回流。
// 宿主能力（视图、序列化器、解析器）在挂载时一次性取出：之后不再碰 milkdown ctx（销毁中的实例会抛），
// 写回前看 view.isDestroyed / view.editable（viewer 永不写共享文档）。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { normalizeTopLevelLists } from './list-blocks'
import { upgradeLinkBlocks } from './page-ref'
import { upgradeMentions } from './mention-upgrade'
import { upgradeMessageBlocks } from './message-blocks'
import { alignBase, applyMerge, applyWhole, hasChanges, planMerge } from './source-merge'
import { sourceOf, visibleParsed } from './source-text'

const IDLE_MS = 1000
const REMOTE_MS = 300

export interface SourceHost {
  view: EditorView
  /** serializerCtx 的值 */
  serialize: (doc: PMNode) => string
  /** parserCtx 的值 */
  parse: (markdown: string) => PMNode | null | undefined
}

/** 源码编辑器那一侧（source-editor.tsx 实现） */
export interface SourcePort {
  getText(): string
  /** 换成规范文本：最小补丁、不进撤销栈、不算本地编辑 */
  replaceText(next: string): void
  composing(): boolean
}

// 文档变化通知，注册进正文编辑器（editor-session.ts）。本会话正在派发写回时（writing）不报：自己的改动不需要回流。
const watchers = new Map<EditorView, Set<() => void>>()
let writing: EditorView | null = null

export const sourceWatch = $prose(
  () =>
    new Plugin({
      key: new PluginKey('sourceWatch'),
      view: (view) => ({
        update(v, prev) {
          if (prev.doc === v.state.doc || writing === v) return
          watchers.get(v)?.forEach((fn) => fn())
        },
        destroy() {
          watchers.delete(view)
        },
      }),
    }),
)

function watch(view: EditorView, fn: () => void): () => void {
  let set = watchers.get(view)
  if (!set) watchers.set(view, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

/** 单块序列化（包一层 doc：非 doc 节点直接序列化会栈溢出），按节点对象缓存，远端回流时没变的块不重算
 * （y-prosemirror 对没变的 Y 类型复用同一个 PM 节点）。序列化失败的块当看不见：源码里没有它，写回也不碰它 */
function blockSerializer(host: SourceHost): (node: PMNode) => string {
  const cache = new WeakMap<PMNode, string>()
  const docType = host.view.state.schema.topNodeType
  return (node) => {
    let md = cache.get(node)
    if (md === undefined) {
      try {
        md = host.serialize(docType.create(null, node)).trimEnd()
      } catch (err) {
        console.warn('[source] 块序列化失败，源码里不显示它', node.type.name, err)
        md = ''
      }
      cache.set(node, md)
    }
    return md
  }
}

/** markdown → 顶层块：解析 + 顶层列表拆条目 + 降级形态升块（页面块 / 消息块 / 提及），在一笔不派发的草稿事务上做，
 * 与打开页、粘贴同一套边界。所有解析（基线与用户文本）都走这里，保证同样的噪声 */
export function parseSource(host: SourceHost, markdown: string): PMNode[] {
  const parsed = host.parse(markdown)
  if (!parsed) return []
  const fresh = normalizeTopLevelLists(parsed)
  if (fresh.childCount === 0) return []
  const state = host.view.state
  const tr = state.tr.replaceWith(0, state.doc.content.size, fresh)
  upgradeLinkBlocks(tr)
  upgradeMessageBlocks(tr)
  upgradeMentions(tr)
  return visibleParsed(tr.doc.content.content)
}

export class SourceSession {
  private readonly serializeBlock: (node: PMNode) => string
  private port: SourcePort | null = null
  private unwatch: (() => void) | null = null
  private baseText = ''
  private base: PMNode[] = []
  private baseParsed: PMNode[] = []
  private whole = false
  /** 本地有没写回的编辑 */
  private dirty = false
  /** 文档有没回流进来的改动 */
  private remotePending = false
  private idleTimer = 0
  private remoteTimer = 0

  constructor(
    private readonly host: SourceHost,
    private readonly onApplied: () => void,
  ) {
    this.serializeBlock = blockSerializer(host)
  }

  /** 当前文档的源码文本（建编辑器之前调），同时立好基线 */
  open(): string {
    const { text, blocks } = sourceOf(this.host.view.state.doc, this.serializeBlock)
    this.rebase(text, blocks, parseSource(this.host, text))
    return text
  }

  attach(port: SourcePort): void {
    this.port = port
    this.unwatch = watch(this.host.view, () => this.docChanged())
  }

  /** 源码编辑器里的本地编辑 */
  localEdit(): void {
    this.dirty = true
    window.clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => this.flush(), IDLE_MS)
  }

  /** 立即写回（失焦 / 空闲到点 / 会话结束）。force：会话结束时不等组字 */
  flush(force = false): void {
    window.clearTimeout(this.idleTimer)
    const port = this.port
    if (!port) return
    if (!force && port.composing()) {
      this.idleTimer = window.setTimeout(() => this.flush(), IDLE_MS)
      return
    }
    if (this.dirty) {
      this.dirty = false
      const text = port.getText()
      if (text !== this.baseText) this.write(text)
    }
    if (this.remotePending && !force) this.resync()
  }

  destroy(): void {
    this.flush(true)
    window.clearTimeout(this.remoteTimer)
    this.unwatch?.()
    this.unwatch = null
    this.port = null
  }

  private rebase(text: string, blocks: PMNode[], parsed: PMNode[]): void {
    this.baseText = text
    this.base = blocks
    this.baseParsed = parsed
    const at = alignBase(blocks, parsed)
    if (at !== -1 && !this.whole) {
      console.warn('[source] 文档与它的 markdown 对不上，本次源码会话退回整篇写回', {
        blocks: blocks.length,
        parsed: parsed.length,
        firstMismatch: at,
        block: blocks[at]?.type.name,
        parsedBlock: parsed[at]?.type.name,
      })
    }
    this.whole = at !== -1
  }

  private write(text: string): void {
    const view = this.host.view
    if (view.isDestroyed || !view.editable) return
    const user = parseSource(this.host, text)
    const tr = view.state.tr
    if (this.whole) applyWhole(tr, user)
    else {
      const ops = planMerge(this.base, this.baseParsed, user)
      if (!hasChanges(ops)) {
        // 只是写法变了（结构与内容一样）：基线跟着用户的原文走，文档不动
        this.baseText = text
        return
      }
      applyMerge(tr, ops)
    }
    if (tr.docChanged) {
      writing = view
      try {
        view.dispatch(tr)
      } finally {
        writing = null
      }
      this.onApplied()
    }
    if (this.remotePending) {
      this.resync()
      return
    }
    // 基线 = 用户的原文；文档里的块与它对不上（例如别的插件刚改了结构）就回流规范文本重立基线
    const { blocks } = sourceOf(view.state.doc, this.serializeBlock)
    if (alignBase(blocks, user) === -1) this.rebase(text, blocks, user)
    else this.resync()
  }

  private docChanged(): void {
    this.remotePending = true
    if (this.dirty) return // 写回之后再回流
    window.clearTimeout(this.remoteTimer)
    this.remoteTimer = window.setTimeout(() => {
      if (this.dirty) return
      if (this.port?.composing()) this.docChanged()
      else this.resync()
    }, REMOTE_MS)
  }

  /** 文档 → 源码：换成规范文本并重立基线 */
  private resync(): void {
    this.remotePending = false
    const view = this.host.view
    const port = this.port
    if (view.isDestroyed || !port) return
    const { text, blocks } = sourceOf(view.state.doc, this.serializeBlock)
    if (text !== port.getText()) port.replaceText(text)
    this.rebase(text, blocks, parseSource(this.host, text))
  }
}
