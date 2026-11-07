/* ---------- 正文按钮块 button_block ----------
 * 原子块（块 id 照常），attrs：label = 按钮上的字，rule = 它指着的「点按钮」规则（挂在这一页上，triggers/sources/button.ts）；rule 空 = 还没设置。
 * 编辑器（buttonBlockView）：点按钮 = POST /api/automations/:rule/press，结果出 Toast；能编辑时悬停出「设置」，
 *   打开 ai/button-setup.tsx（按需加载）新建 / 编辑那条规则，保存后把规则 id 与字写回节点。只读成员按钮灰着。
 * 静态宿主（公开页、历史预览、对话气泡）只装 schema：toDOM 画一个点不了的按钮。
 * markdown：独占一段的 `<button data-rule="<规则 id>">名字</button>`，识别在方言层（@ramet/shared/md-dialect 的 BUTTON）；
 *   规则 id 跟着走：agent 改写这一页后按钮还绑着原来的规则。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { BUTTON } from '@ramet/shared/md-dialect'
import { request } from '../api'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { toast } from '../ui/toast'

const B = COPY.ai.rule.button

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const RULE_ID = /^[0-9a-f-]{36}$/

export const buttonBlockSchema = $nodeSchema('button_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: '' }, label: { default: '' }, rule: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-button]',
      getAttrs: (dom) => (dom instanceof HTMLElement ? { label: dom.dataset.label ?? '', rule: dom.dataset.rule ?? '' } : {}),
    },
  ],
  toDOM: (node) => {
    const label = str(node.attrs.label)
    return [
      'div',
      { 'data-button': '', 'data-label': label, 'data-rule': str(node.attrs.rule), class: 'btn-block', contenteditable: 'false' },
      ['button', { type: 'button', class: 'btn-block-btn', disabled: '' }, label || B.fallback],
    ]
  },
  parseMarkdown: {
    match: (node) => node.type === BUTTON,
    runner: (state, node, type) => {
      state.addNode(type, { label: str(node.label), rule: str(node.rule) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'button_block',
    runner: (state, node) => {
      const rule = str(node.attrs.rule)
      state.addNode('html', undefined, `<button data-rule="${RULE_ID.test(rule) ? rule : ''}">${escapeText(str(node.attrs.label) || B.fallback)}</button>`)
    },
  },
}))

type Ctx = { pageId: string; editable: boolean }

function createButtonView(initial: PMNode, view: EditorView, getPos: () => number | undefined, ctx: Ctx) {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'btn-block'
  dom.contentEditable = 'false'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-block-btn'
  const gear = document.createElement('button')
  gear.type = 'button'
  gear.className = 'btn-block-set'
  gear.innerHTML = iconSvg('cog', 14)
  gear.dataset.tip = B.setup
  gear.setAttribute('aria-label', B.setup)
  dom.append(btn)
  if (ctx.editable) dom.append(gear)
  let busy = false

  const render = (): void => {
    const label = str(node.attrs.label) || B.fallback
    btn.textContent = label
    btn.disabled = !ctx.editable
    btn.classList.toggle('is-unset', !str(node.attrs.rule))
    btn.dataset.tip = str(node.attrs.rule) ? '' : B.unset
  }

  const setup = (): void => {
    void import('../ai/button-setup').then(({ openButtonSetup }) =>
      openButtonSetup({
        pageId: ctx.pageId,
        ruleId: str(node.attrs.rule),
        label: str(node.attrs.label),
        onSaved: (rule, label) => {
          const pos = getPos()
          const cur = pos === undefined ? null : view.state.doc.nodeAt(pos)
          if (pos === undefined || cur?.type.name !== 'button_block') return
          view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, rule, label }))
        },
      }),
    )
  }

  const press = async (): Promise<void> => {
    const rule = str(node.attrs.rule)
    if (!rule) return setup()
    if (busy) return
    busy = true
    btn.classList.add('is-busy')
    try {
      const out = await request<{ name: string }>(`/api/automations/${rule}/press`, { method: 'POST', body: JSON.stringify({ page: ctx.pageId }) })
      toast(B.press(out.name))
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : B.pressFailed, { kind: 'error' })
    } finally {
      busy = false
      btn.classList.remove('is-busy')
    }
  }

  // 按下不让编辑器把它选成节点 / 挪光标；点击各管各的
  dom.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault()
  })
  btn.addEventListener('click', () => void press())
  gear.addEventListener('click', setup)
  render()
  return {
    dom,
    update: (next: PMNode) => {
      if (next.type.name !== 'button_block') return false
      node = next
      render()
      return true
    },
    stopEvent: (event: Event) => event.target instanceof HTMLElement && event.target.closest('button') !== null && event.type !== 'dragstart',
    ignoreMutation: () => true,
  }
}

/** 编辑器里的按钮视图：pageId = 这一页（按钮的规则挂在它上面），editable = 能编辑（只读成员的按钮灰着、没有设置） */
export const buttonBlockView = (ctx: Ctx) =>
  $view(buttonBlockSchema.node, () => (node, view, getPos) => createButtonView(node, view, getPos as () => number | undefined, ctx))
