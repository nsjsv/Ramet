/* ---------- 块手柄点击菜单 ----------
 * 手柄来自 editor/block-handle.ts。浏览器对真实 HTML5 拖拽会抑制后续 click，所以手柄上的 click 就是按下又抬起、没拖，
 * 正是弹菜单的时机，拖拽排序与块选高亮不受影响。只读时手柄本就不出现。
 * 动作全部显式定位到开菜单时快照的 pos（不依赖光标），执行前 nodeAt(pos) 校验块还在，被协同端删掉就只关菜单不执行。
 *
 * 转换面板的语义与实现在 block-turn.ts：块选区是多块且盖住这一块时，转换作用于整个选区。
 * 复制（副本）同理，多块选区整段复制到选区之后（block-ops.ts 的 duplicateBlocks）。
 * 同一 tick 内多笔 dispatch 会被 Yjs UndoManager（captureTimeout 500ms）合并为一条撤销记录。
 * 分隔线下是这一块的最近修改与字数（edit-info.tsx，编辑记录读 edit-marks-store 的缓存，打开即画）。 */

import { copyText } from '../clipboard'
import { renderEditInfo } from '../edit-info'
import { editInfoOf, refreshEditMarks } from '../edit-marks-store'
import { COPY } from '../copy'
import type { IconName } from '../icons'
import { createHandleMenu, type MenuBuilder } from '../handle-menu'
import { countNodeWords } from '../word-count'
import { followersOf, vanish } from '../motion'
import { isFavorite, toggleFavorite } from '../favorites-store'
import { Fragment, type Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { agentStateFor, regenerateReply } from './agent-bar'
import { blockIdAt, findBlockIdPos } from './block-id'
import { draftIdOf, quoteWithFly } from './doc-send'
import type { BlockMenuActive } from './block-handle'
import { canTurn, TURN_INTO_ITEMS, turnInto, type TurnAction, type TurnIcon } from './block-turn'
import { deleteBlockRange, runDelete } from './block-delete'
import { duplicateBlocks } from './block-ops'
import { inlineAsLinks } from './collection-block'
import { unwrapColumns } from './columns'

export type { BlockMenuActive }

/** 打开菜单那一刻的块快照：动作全部按 pos 执行，node 留作上下文（手机端手柄同用） */
export interface BlockMenuSnapshot {
  pos: number
  node: ProsemirrorNode
}

type Snapshot = BlockMenuSnapshot

type Action =
  | { kind: 'delete' }
  | { kind: 'duplicate' }
  | { kind: 'copy-link' }
  | TurnAction

export { TURN_INTO_ITEMS, type TurnAction }

/** 这个块可选的转换项：所有块（含列表项）都能互相转换，原子块（hr / page_ref / 附件）不出转换 */
export function turnItemsFor(node: ProsemirrorNode): typeof TURN_INTO_ITEMS {
  return canTurn(node) ? TURN_INTO_ITEMS : []
}

/** 复制（副本）：深拷贝该块插到其下方。PM 节点不可变，copy 自带 attrs 与子内容；
 * 图片 / 附件副本共享同一文件，page_ref 副本指向同一页。 */
function runDuplicate(view: EditorView, snap: Snapshot, cur: ProsemirrorNode): void {
  // 集合块的副本是链接视图，复制不产生新的所有者（collection-block.ts）
  view.dispatch(view.state.tr.insert(snap.pos + cur.nodeSize, inlineAsLinks(Fragment.from(cur.copy(cur.content)), view.state.schema)))
  view.focus()
}

/** 链接指向的块：同步块显示的是源块，链接就给源块（看到什么指向什么，也不会出现同步块的同步块），其余块给自己。
 * 块还没被补 id 插件补上（协同窗口期）或缺页 id 时返回 null。 */
function linkTarget(view: EditorView, snap: Snapshot, pageId: string | undefined): { pageId: string; blockId: string } | null {
  const node = view.state.doc.nodeAt(snap.pos)
  if (node?.type.name === 'block_sync') {
    const src = { pageId: String(node.attrs.pageId ?? ''), blockId: String(node.attrs.blockId ?? '') }
    return src.pageId && src.blockId ? src : null
  }
  const blockId = blockIdAt(view, snap.pos)
  return blockId && pageId ? { pageId, blockId } : null
}

/** 复制链接：`<origin>/page/<pageId>?block=<块id>`，拿不到目标时静默不动。copyText 全环境可用（HTTP 走 execCommand 兜底）。 */
function runCopyLink(view: EditorView, snap: Snapshot, pageId: string | undefined): void {
  const target = linkTarget(view, snap, pageId)
  if (!target) return
  void copyText(`${location.origin}/page/${target.pageId}?block=${target.blockId}`)
}

function applyAction(view: EditorView, snap: Snapshot, action: Action, pageId: string | undefined): void {
  const cur = view.state.doc.nodeAt(snap.pos) // 执行前重读，为空说明已被协同端删掉
  if (!cur) return
  if (action.kind === 'delete') return runDelete(view, snap, cur)
  if (action.kind === 'duplicate') return runDuplicate(view, snap, cur)
  if (action.kind === 'copy-link') return runCopyLink(view, snap, pageId)
  return turnInto(view, snap.pos, snap.pos + cur.nodeSize, action)
}

const svg = (name: IconName): TurnIcon => ({ svg: name })

/** 菜单本体（不绑任何触发事件）：open 由宿主触发（桌面 = 手柄 click；手机 = 触摸手柄 tap） */
export interface BlockMenu {
  open(snap: BlockMenuSnapshot): void
  close(): void
  destroy(): void
}

/** 造菜单。getAnchorEl 提供定位锚（开菜单那一刻取，也是点外部关闭的豁免目标）。
 * 桌面 / 手机手柄两套触发共用这一份弹层与动作逻辑；弹层外壳（定位、关闭、菜单项、飞出面板）是 handle-menu.ts，
 * 与集合表格的行手柄菜单同一份。getPageId 供复制链接拼 URL，缺省或返回 undefined 时该按钮静默不动。 */
export function createBlockMenu(opts: {
  getView: () => EditorView | undefined
  getAnchorEl: () => Element | null
  getPageId?: () => string | undefined
  /** 当前块选区（多块时删除作用于整个选区），由 Editor.tsx 闭包传入（blockSelectKey 在那边） */
  getRange?: () => { from: number; to: number } | null
}): BlockMenu {
  const { getView, getAnchorEl, getPageId, getRange } = opts
  const shell = createHandleMenu()

  function openMenu(snap: Snapshot): void {
    const anchor = getAnchorEl()
    if (!anchor) {
      shell.close()
      return
    }
    shell.open(anchor, (m) => build(m, snap))
  }

  function build(m: MenuBuilder, snap: Snapshot): void {
    const { el } = m
    const actionBtn = m.item
    const runAction = (action: Action): void => {
      const view = getView()
      if (!view || view.isDestroyed) return
      if (!view.state.doc.nodeAt(snap.pos)) return // 块已被协同端删掉，只关菜单不执行
      // 块选区是多块且盖住这个块时，删除 / 复制 / 转换作用于整个选区（显式选区比鼠标那一下权威）；
      // 单选时 range 恒等于本块，落回单块语义
      const range = getRange?.()
      const end = snap.pos + snap.node.nodeSize
      if (range && range.from <= snap.pos && range.to >= end && (range.from < snap.pos || range.to > end)) {
        if (action.kind === 'delete' && deleteBlockRange(view, range.from, range.to)) return
        if (action.kind === 'duplicate') {
          duplicateBlocks(view.state, view.dispatch)
          view.focus()
          return
        }
        if (action.kind === 'text' || action.kind === 'wrap') {
          turnInto(view, range.from, range.to, action)
          return
        }
      }
      // 单块删除：先淡出、后面补位（motion.ts 的 vanish），再按块 id 重找位置删（动画期间文档可能被协同端改了）。
      // 没有 id 的块（补 id 前的窗口期）定位不了，直接删
      const id: unknown = snap.node.attrs.id
      const dom = action.kind === 'delete' && typeof id === 'string' && id ? view.nodeDOM(snap.pos) : null
      if (dom instanceof HTMLElement && typeof id === 'string') {
        vanish(dom, () => followersOf(dom, view.dom), () => {
          if (view.isDestroyed) return
          const pos = findBlockIdPos(view.state.doc, id)
          if (pos !== null) applyAction(view, { ...snap, pos }, action, getPageId?.())
        })
        return
      }
      applyAction(view, snap, action, getPageId?.())
    }

    // 转换：点击弹出 / 收起飞出面板（默认收起），选中后随主菜单一起关
    const turn = m.flyout('转换', { svg: 'swap' }, () =>
      turnItemsFor(snap.node).map((item) => ({ label: item.label, icon: item.icon, run: () => runAction(item.action) })),
    )

    // AI 回复块：重新生成（与失败条的重试同一个动作），这一页正在生成时禁用，避免 409
    if (snap.node.type.name === 'agent_reply') {
      const pageId = getPageId?.()
      const replyId: unknown = snap.node.attrs.id
      if (pageId && typeof replyId === 'string' && replyId) {
        const regen = actionBtn(COPY.run.regenerate, svg('retry'), () => regenerateReply(pageId, replyId))
        regen.disabled = agentStateFor(pageId).status === 'running'
        el.appendChild(regen)
      }
    }
    if (turnItemsFor(snap.node).length) el.appendChild(turn) // 原子块 / 表格 / 消息块没有可转换的类型
    // 取消分栏：各栏内容按顺序拍平（columns.ts）
    if (snap.node.type.name === 'columns') {
      el.appendChild(
        actionBtn('取消分栏', svg('columns'), () => {
          const v = getView()
          if (v && !v.isDestroyed) unwrapColumns(v, snap.pos)
        }),
      )
    }
    el.appendChild(actionBtn('删除', svg('trash'), () => runAction({ kind: 'delete' })))
    el.appendChild(actionBtn('复制', svg('copy'), () => runAction({ kind: 'duplicate' })))
    el.appendChild(actionBtn('复制链接', svg('link'), () => runAction({ kind: 'copy-link' })))
    // 引用：把这一块作为块引用放进文档末尾正在写的消息（doc-send.ts 的 quoteWithFly，带飞行动画），草稿自己不出
    const quotePage = getPageId?.()
    const quoteView = getView()
    const quoteBlock = quoteView && !quoteView.isDestroyed ? blockIdAt(quoteView, snap.pos) : null
    if (quotePage && quoteView && quoteBlock && quoteBlock !== draftIdOf(quoteView.state.doc)) {
      // 菜单点完就关，飞行起点在按下时记下
      let from: DOMRect | null = null
      const quote = actionBtn(COPY.selection.quote, svg('quote'), () => {
        const v = getView()
        const node = v && !v.isDestroyed ? v.state.doc.nodeAt(snap.pos) : null
        if (!v || !node) return
        const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)
        quoteWithFly(v, { pageId: quotePage, blockId: quoteBlock, text }, from)
      })
      quote.addEventListener('pointerdown', () => {
        from = quote.getBoundingClientRect()
      })
      el.appendChild(quote)
    }
    // 收藏 / 取消收藏：凡是有块 id 的块（AI 回复、过程页步骤、列表项等）都有，块还没被补 id 时不出现
    const favPage = getPageId?.()
    const favView = getView()
    const favBlock = favView && !favView.isDestroyed ? blockIdAt(favView, snap.pos) : null
    if (favPage && favBlock) {
      const on = isFavorite(favPage, favBlock)
      el.appendChild(actionBtn(on ? COPY.fav.remove : COPY.fav.add, svg(on ? 'star-fill' : 'star'), () => void toggleFavorite(favPage, favBlock)))
    }
    // 分隔线下：字数现算，上次编辑读缓存当场画（进页面已预取），后台再刷一次，变了原地更新（菜单已关 / 已换块就丢弃）
    const info = document.createElement('div')
    const words = countNodeWords(snap.node)
    const shown = favPage && favBlock ? editInfoOf(favPage, favBlock) : null
    renderEditInfo(info, words, shown)
    el.appendChild(info)
    if (favPage && favBlock) {
      void refreshEditMarks(favPage).then(() => {
        const fresh = editInfoOf(favPage, favBlock)
        if (!m.alive() || JSON.stringify(fresh) === JSON.stringify(shown)) return
        renderEditInfo(info, words, fresh)
        m.place()
      })
    }
  }

  return { open: openMenu, close: () => shell.close(), destroy: () => shell.destroy() }
}

/** 在手柄上挂 click 菜单（桌面 hover 手柄）。返回 bind() / destroy()：
 * collab 初始化会销毁重建插件视图，destroy 会摘 click，所以工厂每次重建都要调 bind() 重挂，
 * 同一函数引用重复 add 会自动去重。 */
export function attachBlockMenu(opts: {
  handle: HTMLElement
  getView: () => EditorView | undefined
  getActive: () => BlockMenuActive | null
  /** 复制链接拼 /page/:id?block= 用，缺省时按钮静默不动 */
  getPageId?: () => string | undefined
  /** 当前块选区（多块时菜单删除作用于整个选区） */
  getRange?: () => { from: number; to: number } | null
}): { bind(): void; destroy(): void } {
  const { handle, getView, getActive, getPageId, getRange } = opts
  const menu = createBlockMenu({ getView, getAnchorEl: () => handle, getPageId, getRange })

  function onHandleClick(event: MouseEvent): void {
    // Shift 点手柄是扩选手势（Editor.tsx 的 mousedown 分支处理），不弹菜单
    if (event.shiftKey) return
    const view = getView()
    if (!view || view.isDestroyed) return
    const active = getActive()
    if (!active) return
    menu.open({ pos: active.$pos.pos, node: active.node })
  }

  return {
    bind() {
      handle.addEventListener('click', onHandleClick)
    },
    destroy() {
      handle.removeEventListener('click', onHandleClick)
      menu.destroy()
    },
  }
}
