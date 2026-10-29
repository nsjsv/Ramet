/* ---------- 对话气泡的轻操作：复制 · 引用 · 重新生成 / 重新回复 · 删除 ----------
 * 悬停（触屏常显）出现在气泡下方，反馈由操作本身给出（复制成功图标变对勾 1 秒，不弹提示条）。
 * 这里只画按钮并转发；动作的实现在 ChatView（要主编辑器视图 / 输入框），写路径与文档模式同一条：
 * 删除走 block-menu 的 deleteBlockRange，重新生成走 agent-bar 的 regenerateReply。
 * 用户消息的重新回复：对话模式删掉 AI 回复后不用再切回文档模式发草稿，落点规则在
 * reply-target.ts 的 replyTargetOf（有回复就重新生成它，最后一条且没回复就直接发）。 */
import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { iconSvg, type IconName } from '../icons'
import { followersOf, flyGhost, vanish } from '../motion'
import { isFavorite, toggleFavorite } from '../favorites-store'
import { pageAgent, regenerateReply, runAgent } from './agent-bar'
import { findBlockIdPos } from './block-id'
import { deleteBlockRange } from './block-delete'
import { composerQuote, insertIntoComposer } from './composer-bridge'
import { quoteLabel } from './doc-send'
import { replyTargetOf } from './reply-target'

export interface BubbleActs {
  /** 复制这条消息（Markdown），成功返回 true */
  copy(node: PMNode): Promise<boolean>
  /** btn 是点的按钮（引用飞行的起点） */
  quote(node: PMNode, btn: HTMLElement): void
  regenerate(replyId: string): void
  /** 用户消息：让 agent 再答一次（落点按点击时刻的文档现算，见 replyTargetOf） */
  redo(userId: string): void
  /** 这条消息是否已收藏 / 切换收藏（返回切换后的状态） */
  isFavorite(node: PMNode): boolean
  favorite(node: PMNode): Promise<boolean>
  /** 删除这条消息；el 是要淡出的元素（气泡；文档模式是操作行，实现自己找所在的块） */
  remove(node: PMNode, el: HTMLElement): void
}

/** 气泡下方的操作行，没有任何可用操作返回 null */
export function buildActs(
  kind: 'user' | 'ai',
  node: PMNode,
  acts: BubbleActs,
  /** 能写（viewer 只有复制） */
  canWrite: boolean,
  /** 删除时淡出的元素（气泡），null 交给 acts.remove 从操作行自己找（文档模式的抬头行） */
  bubble: HTMLElement | null,
  /** 用户消息有重新回复落点（reply-target.ts 的 redoableUserIds），只有对话气泡传 */
  redo = false,
): HTMLElement | null {
  const row = document.createElement('div')
  row.className = 'chat-acts'
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
  const add = (act: string, icon: IconName, label: string, run: (btn: HTMLButtonElement) => void, danger = false): void => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `chat-act${danger ? ' is-danger' : ''}`
    btn.dataset.act = act
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.innerHTML = iconSvg(icon, 14)
    btn.addEventListener('click', () => run(btn))
    row.append(btn)
  }
  add('copy', 'copy', COPY.bubble.copy, (btn) => {
    void acts.copy(node).then((ok) => {
      if (!ok) return
      btn.innerHTML = iconSvg('check', 14)
      window.setTimeout(() => {
        btn.innerHTML = iconSvg('copy', 14)
      }, 1000)
    })
  })
  if (canWrite) add('quote', 'quote', COPY.bubble.quote, (btn) => acts.quote(node, btn))
  // 收藏只是读权限就能做的私人书签，viewer 也有。星标弹一下（CSS .is-pop），不弹提示条
  if (id) {
    const on = acts.isFavorite(node)
    add('fav', on ? 'star-fill' : 'star', on ? COPY.fav.remove : COPY.fav.add, (btn) => {
      void acts.favorite(node).then((now) => {
        btn.innerHTML = iconSvg(now ? 'star-fill' : 'star', 14)
        btn.title = now ? COPY.fav.remove : COPY.fav.add
        btn.setAttribute('aria-label', btn.title)
        btn.classList.toggle('is-on', now)
        btn.classList.remove('is-pop')
        void btn.offsetWidth // 重播动画
        if (now) btn.classList.add('is-pop')
      })
    })
    if (on) row.querySelector('[data-act="fav"]')?.classList.add('is-on')
  }
  if (canWrite && kind === 'ai' && id) add('regen', 'retry', COPY.bubble.regen, () => acts.regenerate(id))
  if (canWrite && kind === 'user' && id && redo) add('redo', 'retry', COPY.bubble.redo, () => acts.redo(id))
  if (canWrite && id) add('del', 'trash', COPY.bubble.del, () => acts.remove(node, bubble ?? row), true)
  return row.childElementCount > 0 ? row : null
}

/** 气泡操作的实现。写路径与文档模式同一条：删除是主编辑器视图上的 deleteBlockRange（对话视图是只读的，
 *  写要走主视图，同 send），重新生成是 regenerateReply。getEditor 惰性取（换页拆建窗口期为 undefined） */
export function bubbleActsFor(pageId: string, getEditor: () => Editor | undefined): BubbleActs {
  const mainView = (): EditorView | undefined => {
    let view: EditorView | undefined
    getEditor()?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view && !view.isDestroyed ? view : undefined
  }
  return {
    // 复制为 Markdown（走编辑器自己的序列化，代码块 / 列表 / 引用都带记号），序列化失败退回纯文字
    async copy(node) {
      let md = ''
      try {
        getEditor()?.action((ctx) => {
          const doc = ctx.get(schemaCtx).nodes.doc!.create(null, node.content)
          md = ctx.get(serializerCtx)(doc).trim()
        })
      } catch {
        /* 退回纯文字 */
      }
      return copyText(md || node.textBetween(0, node.content.size, '\n\n', '\n'))
    },
    quote(node, btn) {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      if (!id) return
      const from = btn.getBoundingClientRect()
      if (!insertIntoComposer(composerQuote(pageId, id, node.textContent))) return
      // 小胶囊从按钮飞到输入框里刚落下的那颗块引用 chip（飞行期间先藏，落地显现），找不到就落在框内左上后淡掉
      const input = document.querySelector<HTMLElement>('.chat-composer .chat-input')
      const chips = input?.querySelectorAll<HTMLElement>('.block-ref')
      const chip = chips?.[chips.length - 1]
      const label = quoteLabel(node.textContent)
      if (chip) flyGhost(from, chip, label, { reveal: true })
      else if (input) flyGhost(from, input, label, { reveal: false })
    },
    regenerate: (replyId) => regenerateReply(pageId, replyId),
    redo(userId) {
      const view = mainView()
      const target = view ? replyTargetOf(view.state.doc, userId) : null
      if (target?.kind === 'regen') regenerateReply(pageId, target.replyId)
      // 发给这条消息自己指定的来源，失效或没指定就用页面默认（同 sendLast）
      else if (target?.kind === 'send') runAgent(pageId, pageAgent(pageId, target.agent))
    },
    isFavorite: (node) => {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      return Boolean(id) && isFavorite(pageId, id)
    },
    favorite: (node) => {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      return id ? toggleFavorite(pageId, id) : Promise.resolve(false)
    },
    remove(node, bubble) {
      const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
      if (!id) return
      const apply = (): void => {
        const view = mainView()
        const pos = view ? findBlockIdPos(view.state.doc, id) : null
        const target = view && pos !== null ? view.state.doc.nodeAt(pos) : null
        if (view && pos !== null && target) deleteBlockRange(view, pos, pos + target.nodeSize)
      }
      // 先淡出，再让后面的内容补位（motion.ts 的 vanish，减弱动效时直接删）
      vanish(bubble, () => followersOf(bubble, bubble.closest('.ProseMirror') ?? document.body), apply)
    },
  }
}
