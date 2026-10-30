/* ---------- 粘贴块链接三选弹窗 ----------
 * 把块链接（/page/:id?block=:bid，含绝对 URL）粘进编辑器时弹出三选浮层：
 * - 提及：取块文本快照（GET /api/pages/:pageId/blocks/:blockId）插 block_ref 行内 chip，
 *   请求失败（无权限 / 源块已删 / 网络）时提示并退回原样粘贴；
 * - 同步块：插 block_sync 块级节点（实时跟随源块，editor/block-sync.ts 渲染）；
 * - 原样粘贴：URL 文本原封不动插入。
 * Esc 或点外部取消，什么都不插。只在 editable 实例接管（公开页只读，没有弹窗）；
 * 与 uploadPlugin（upload.ts）处理的 payload 互斥（文件 vs URL 文本），.use 顺序无所谓。 */

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { api } from '../api'

// 同源相对路径或带任意 host 的绝对 URL 都认（跨端复制的是绝对地址），前后空白容忍
export const BLOCK_LINK_RE = /^(?:https?:\/\/[^/]+)?\/page\/([\w-]+)\?block=([\w-]+)$/

interface BlockLinkTarget {
  pageId: string
  blockId: string
  url: string
}

let openOverlay: HTMLElement | null = null // 单例：连粘两次先关旧层

function closeOverlay(): void {
  if (!openOverlay) return
  const el = openOverlay
  openOverlay = null
  el.remove()
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('touchstart', onDocDown, true)
  document.removeEventListener('keydown', onKeyDown, true)
}

function onDocDown(e: Event): void {
  const target = e.target as Node | null
  if (openOverlay && target && openOverlay.contains(target)) return
  closeOverlay()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  closeOverlay()
}

/** 提及：块文本快照插成 block_ref chip。失败提示后退回原样粘贴 */
async function insertMention(view: EditorView, target: BlockLinkTarget): Promise<void> {
  let text: string
  try {
    text = (await api.fetchBlockText(target.pageId, target.blockId)).text
  } catch (err) {
    console.error(err)
    window.alert('无法读取源块（无权限或已被删除），已按原样粘贴链接')
    insertPlain(view, target)
    return
  }
  const ref = view.state.schema.nodes.block_ref
  if (!ref || view.isDestroyed) return
  replaceSelection(view, ref.create({ pageId: target.pageId, blockId: target.blockId, text }))
}

function insertPlain(view: EditorView, target: BlockLinkTarget): void {
  if (view.isDestroyed) return
  view.dispatch(view.state.tr.insertText(target.url))
  view.focus()
}

function replaceSelection(view: EditorView, node: PMNode): void {
  view.dispatch(view.state.tr.replaceSelectionWith(node))
  view.focus()
}

/** 弹层定位：光标下方左对齐，视口右 / 下缘放不下就往回收 */
function place(el: HTMLElement, view: EditorView): void {
  let x = window.innerWidth / 2
  let y = window.innerHeight / 3
  try {
    const coords = view.coordsAtPos(view.state.selection.head)
    x = coords.left
    y = coords.bottom
  } catch {
    // 光标坐标拿不到（选区在惰性渲染区等），用视口默认位
  }
  const rect = el.getBoundingClientRect()
  el.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - rect.width - 8))}px`
  const below = y + 6
  el.style.top =
    below + rect.height > window.innerHeight - 8
      ? `${Math.max(8, y - rect.height - 6)}px`
      : `${below}px`
}

export type PasteChoice = { label: string; hint: string; run: () => void }

/** 光标下方的单选浮层（块链接三选、空行粘贴网址三选共用）：点一项执行并收起，Esc / 点外面收起什么都不做 */
export function openChoiceOverlay(view: EditorView, choices: PasteChoice[]): void {
  closeOverlay()
  const el = document.createElement('div')
  el.className = 'block-link-choices'
  for (const choice of choices) {
    const btn = document.createElement('button')
    btn.type = 'button'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = choice.label
    const hint = document.createElement('span')
    hint.className = 'hint'
    hint.textContent = choice.hint
    btn.append(label, hint)
    btn.addEventListener('mousedown', (e) => e.preventDefault()) // 不抢编辑器焦点（同 slash 惯例）
    btn.addEventListener('click', () => {
      closeOverlay()
      choice.run()
    })
    el.appendChild(btn)
  }
  document.body.appendChild(el)
  place(el, view)
  openOverlay = el
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('touchstart', onDocDown, true)
  document.addEventListener('keydown', onKeyDown, true)
}

function openChoices(view: EditorView, target: BlockLinkTarget): void {
  const syncType = view.state.schema.nodes.block_sync
  openChoiceOverlay(view, [
    { label: '提及', hint: '插入文本快照（不跟随）', run: () => void insertMention(view, target) },
    syncType
      ? {
          label: '同步块',
          hint: '实时跟随源块内容',
          run: () => {
            if (!view.isDestroyed) replaceSelection(view, syncType.create({ pageId: target.pageId, blockId: target.blockId }))
          },
        }
      : { label: '原样粘贴', hint: '插入链接文本', run: () => insertPlain(view, target) },
    { label: '原样粘贴', hint: '插入链接文本', run: () => insertPlain(view, target) },
  ])
}

export const blockLinkPaste = $prose(
  () =>
    new Plugin({
      props: {
        handlePaste: (view, event) => {
          if (!view.editable) return false
          const text = event.clipboardData?.getData('text/plain') ?? ''
          const m = BLOCK_LINK_RE.exec(text.trim())
          if (!m) return false
          const pageId = m[1]
          const blockId = m[2]
          if (!pageId || !blockId) return false
          openChoices(view, { pageId, blockId, url: text.trim() })
          return true
        },
      },
    }),
)
