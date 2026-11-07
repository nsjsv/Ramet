/* ---------- AI 块 ai_gen（界面叫「AI 块」；ai-block.ts 是对话回复的顶栏，名字避开） ----------
 * attrs：prompt（要 AI 做什么）、rule（自动更新的规则 id，空 = 不自动）、state（'' / running / failed）、note（上次更新的 ISO 时刻或失败原因）。
 * content block+：块身是普通正文块（能改、能搜、agent 读得到）；生成 = 服务端整段替换块身（server/src/ai-gen.ts）。
 * 编辑器（aiGenView）：块头（提示词输入、生成按钮、状态、自动更新下拉）+ 块身（contentDOM）。生成 = POST /api/pages/:id/ai-gen/:block；
 *   自动更新 = 建一条挂在这一页上的规则（定时 / 盯这一页），动作是「刷新 AI 块」，规则 id 写回 rule；改选项先删旧的再建新的。
 * 静态宿主（公开页、历史预览）只装 schema：toDOM 画提示词 + 内容，没有按钮。
 * markdown：`<!-- ai prompt="…" rule="…" -->` … `<!-- /ai -->`（方言 AI_GEN）；state / note 不进 markdown。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { AI_GEN } from '@ramet/shared/md-dialect'
import { request } from '../api'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { toast } from '../ui/toast'

const G = COPY.ai.aiGen

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const RULE_ID = /^[0-9a-f-]{36}$/

export const aiGenSchema = $nodeSchema('ai_gen', () => ({
  group: 'block',
  content: 'block+',
  defining: true,
  attrs: { id: { default: '' }, prompt: { default: '' }, rule: { default: '' }, state: { default: '' }, note: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-ai-gen]',
      contentElement: '.ai-gen-body',
      getAttrs: (dom) => (dom instanceof HTMLElement ? { prompt: dom.dataset.prompt ?? '', rule: dom.dataset.rule ?? '' } : {}),
    },
  ],
  toDOM: (node) => [
    'div',
    { 'data-ai-gen': '', 'data-prompt': str(node.attrs.prompt), 'data-rule': str(node.attrs.rule), class: 'ai-gen' },
    ['div', { class: 'ai-gen-head', contenteditable: 'false' }, ['span', { class: 'ai-gen-prompt-text' }, str(node.attrs.prompt) || G.label]],
    ['div', { class: 'ai-gen-body' }, 0],
  ],
  parseMarkdown: {
    match: (node) => node.type === AI_GEN,
    runner: (state, node, type) => {
      state.openNode(type, { prompt: str(node.prompt), rule: str(node.rule) })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'ai_gen',
    runner: (state, node) => {
      const rule = str(node.attrs.rule)
      state.addNode('html', undefined, `<!-- ai prompt="${escapeAttr(str(node.attrs.prompt))}"${RULE_ID.test(rule) ? ` rule="${rule}"` : ''} -->`)
      state.next(node.content)
      state.addNode('html', undefined, '<!-- /ai -->')
    },
  },
}))

type Auto = 'off' | 'daily' | 'watch'
type Ctx = { pageId: string; editable: boolean }

const AUTO_LABEL: Record<Auto, string> = { off: G.autoOff, daily: G.autoDaily, watch: G.autoWatch }

let closeAutoMenu: (() => void) | null = null

/** 自动更新的三个选项（贴着按钮的小菜单，同提示框的类型菜单） */
function openAutoMenu(anchor: HTMLElement, current: Auto, pick: (auto: Auto) => void): void {
  closeAutoMenu?.()
  const box = document.createElement('div')
  box.className = 'pop-card ai-gen-auto-menu'
  for (const value of Object.keys(AUTO_LABEL) as Auto[]) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'pop-row' + (value === current ? ' is-current' : '')
    row.textContent = AUTO_LABEL[value]
    row.addEventListener('mousedown', (e) => e.preventDefault())
    row.addEventListener('click', () => {
      close()
      if (value !== current) pick(value)
    })
    box.append(row)
  }
  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    if (closeAutoMenu === close) closeAutoMenu = null
  }
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
  }
  document.body.append(box)
  const rect = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${rect.bottom + 4 + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 4) : rect.bottom + 4}px`
  document.addEventListener('mousedown', onOutside, true)
  closeAutoMenu = close
}

/** 「更新于 09:42」/「更新于 11 月 7 日 09:42」 */
function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${time}`
}

function createAiGenView(initial: PMNode, view: EditorView, getPos: () => number | undefined, ctx: Ctx) {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'ai-gen'
  const head = document.createElement('div')
  head.className = 'ai-gen-head'
  head.contentEditable = 'false'
  const icon = document.createElement('span')
  icon.className = 'ai-gen-ic'
  icon.innerHTML = iconSvg('sparkle', 14)
  const prompt = document.createElement('input')
  prompt.className = 'ai-gen-prompt'
  prompt.placeholder = G.placeholder
  prompt.spellcheck = false
  const run = document.createElement('button')
  run.type = 'button'
  run.className = 'ai-gen-run'
  const status = document.createElement('span')
  status.className = 'ai-gen-status'
  const auto = document.createElement('button')
  auto.type = 'button'
  auto.className = 'ai-gen-auto'
  auto.dataset.tip = G.auto
  auto.setAttribute('aria-label', G.auto)
  head.append(icon, prompt, run, status)
  if (ctx.editable) head.append(auto)
  const body = document.createElement('div')
  body.className = 'ai-gen-body'
  dom.append(head, body)

  const setAttrs = (patch: Record<string, string>): void => {
    const pos = getPos()
    if (pos === undefined || !view.editable) return
    const current = view.state.doc.nodeAt(pos)
    if (!current || current.type !== node.type) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }))
  }
  const commitPrompt = (): void => {
    if (prompt.value.trim() !== str(node.attrs.prompt)) setAttrs({ prompt: prompt.value.trim() })
  }

  const paint = (): void => {
    const state = str(node.attrs.state)
    const note = str(node.attrs.note)
    if (document.activeElement !== prompt) prompt.value = str(node.attrs.prompt)
    prompt.readOnly = !ctx.editable
    run.textContent = state === 'running' ? G.running : node.textContent.trim() ? G.regenerate : G.generate
    run.disabled = !ctx.editable || state === 'running'
    run.hidden = !ctx.editable
    status.classList.toggle('is-failed', state === 'failed')
    status.textContent = state === 'failed' ? G.failed(note) : state === 'running' ? '' : note ? G.updated(stamp(note)) : ''
    dom.classList.toggle('is-running', state === 'running')
  }

  // 自动更新的现状：rule 指着的规则是定时还是盯页面（挂在这一页上的规则里找；找不到 = 不自动）
  let autoNow: Auto = 'off'
  const loadAuto = async (): Promise<void> => {
    const rule = str(node.attrs.rule)
    if (!rule || !ctx.editable) return
    try {
      const { automationApi } = await import('../ai/automation-api')
      const found = (await automationApi.scoped(ctx.pageId)).find((r) => r.id === rule)
      autoNow = found?.source === 'timer' ? 'daily' : found?.source === 'page_watch' ? 'watch' : 'off'
    } catch {
      autoNow = 'off'
    }
    paintAuto()
  }
  const paintAuto = (): void => {
    auto.innerHTML = `${iconSvg('clock', 12)}<span>${AUTO_LABEL[autoNow]}</span>`
    auto.classList.toggle('is-on', autoNow !== 'off')
  }

  const setAuto = async (next: Auto): Promise<void> => {
    const block = str(node.attrs.id)
    if (!block) return void toast(G.noId, { kind: 'error' })
    const { automationApi } = await import('../ai/automation-api')
    const old = str(node.attrs.rule)
    try {
      // 别人的规则删不掉（404）：照样换成自己的，原来那条留在他那里
      if (old) await automationApi.remove(old).catch(() => undefined)
      if (next === 'off') {
        setAttrs({ rule: '' })
      } else {
        const name = `${G.ruleName}${[...str(node.attrs.prompt)].slice(0, 20).join('')}`.slice(0, 40)
        const made = await automationApi.create({
          name,
          source: next === 'daily' ? 'timer' : 'page_watch',
          config: next === 'daily' ? { kind: 'daily', time: '09:00' } : { page: ctx.pageId, subtree: false, quiet: 10 },
          actions: [{ type: 'ai_gen', page: ctx.pageId, block }],
          scopePage: ctx.pageId,
        })
        setAttrs({ rule: made.automation.id })
      }
      autoNow = next
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : G.autoFailed, { kind: 'error' })
    }
    paintAuto()
  }

  const generate = async (): Promise<void> => {
    commitPrompt()
    const block = str(node.attrs.id)
    if (!block) return void toast(G.noId, { kind: 'error' })
    if (!prompt.value.trim()) return void toast(G.empty, { kind: 'error' })
    // 提示词刚改：等它经协同到服务端（服务端按文档里的提示词生成）
    await new Promise((r) => setTimeout(r, 200))
    try {
      await request(`/api/pages/${ctx.pageId}/ai-gen/${block}`, { method: 'POST' })
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : G.failedToStart, { kind: 'error' })
    }
  }

  head.addEventListener('mousedown', (e) => {
    if (e.target !== prompt) e.preventDefault()
  })
  let timer: number | undefined
  prompt.addEventListener('input', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(commitPrompt, 500)
  })
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      window.clearTimeout(timer)
      void generate()
    }
  })
  prompt.addEventListener('blur', () => {
    window.clearTimeout(timer)
    commitPrompt()
  })
  run.addEventListener('click', () => void generate())
  auto.addEventListener('click', () => openAutoMenu(auto, autoNow, (next) => void setAuto(next)))
  paint()
  paintAuto()
  void loadAuto()

  return {
    dom,
    contentDOM: body,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      const ruleChanged = str(next.attrs.rule) !== str(node.attrs.rule)
      node = next
      paint()
      if (ruleChanged && str(next.attrs.rule) === '') {
        autoNow = 'off'
        paintAuto()
      }
      return true
    },
    stopEvent: (event: Event) => head.contains(event.target as Node),
    ignoreMutation(mutation: { type: string; target: Node }) {
      if (mutation.type === 'selection') return false
      return !body.contains(mutation.target) || (mutation.target === body && mutation.type === 'attributes')
    },
    destroy() {
      window.clearTimeout(timer)
    },
  }
}

/** 编辑器里的 AI 块视图：pageId = 这一页，editable = 能编辑（只读成员看得到内容与提示词，没有按钮） */
export const aiGenView = (ctx: Ctx) =>
  $view(aiGenSchema.node, () => (node, view, getPos) => createAiGenView(node, view, getPos as () => number | undefined, ctx))
