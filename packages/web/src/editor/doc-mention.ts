/* ---------- 正文引用菜单（文档模式）：`@` 大菜单（Agent / 页面 / Skill / 成员），`[[` 提及或新建页面 ----------
 * 在正文光标处打字触发，与对话输入框共用候选规则（mention-query.ts 的 mentionQuery / candidatesFor，触发符、过滤、上限都在那里），
 * 列表样式复用 .chat-mention（见 chat.css）。
 * 选中插的是行内原子 chip：page_mention（页面；skill 也是指向 skill 页的 page_mention）、agent_mention、
 * user_mention（成员，editor/user-mention.ts），画面上只有名字，看不见 `@[标题](page:id)` 这段语法与 uuid。
 * 对话输入框插的是那段记号，进文档时由 mention-upgrade.ts 在既有 parse 边界升成同一种 chip。
 * 「新建页面」（`[[新名字` 的最后一项）：建当前页的子页（标题就是打的名字），再插入指向它的提及。建页是异步的，
 * 回来时按当下光标处重新找 `[[…` 的范围再换（这期间文档可能变了，找不到就不插）。
 *
 * 机制（与 slash.ts 同款两件套）：
 *   - docMention(opts)：$prose 插件，持有菜单 DOM 与候选状态（WeakMap 按 view 取用），
 *     每次 PM update 重算查询并重排（无防抖：每次击键最多十来个按钮，成本可忽略）；
 *   - configDocMention(ctx)：走 editorViewOptionsCtx 通道拦 ↑/↓/Enter/Esc（PM 先咨询它再问插件 keymap，
 *     否则 listEnterKeymap 的 splitListItem 会抢先）。委托链保留既有 handleKeyDown（slash 也走这条通道，不能互相覆盖）。
 * 一次性触发（trigger-session.ts）：刚打出 `@`（行首 / 空白后，邮箱里的不算，规则在 mentionQuery）或 `[[` 的那一下开启会话，
 * 之后打字是筛选；光标离开 / 失焦 / Esc / 选中 / 没有候选就结束，光标挪回来不再弹。
 * 行的分组与显示在 mention-rows.ts（与对话输入框同一份），图标在 mention-icon.ts，键位语义在 mention-nav.ts。
 * `@` 的分类导航：控制器持有 category（null 是顶层），会话换了（触发符位置变了）就归零；
 * skill / 成员来自缓存（mention-sources.ts），会话开启时后台补取，到了重画。
 * 输入法组字中的 Enter 一律放行给输入法，不做选中。 */

import { editorViewOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { posToDOMRect } from '@milkdown/kit/prose'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { AgentInfo, Page } from '../api'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { candidateKey, candidatesFor, mentionLabel, mentionQuery, type Candidate, type MentionCategory, type MentionTrigger } from './mention-query'
import { chevronEl, rowIconEl } from './mention-icon'
import { activate, mentionKey, type MentionKeyAction } from './mention-nav'
import { mentionRows } from './mention-rows'
import { mentionSources, warmMentionSources } from './mention-sources'
import { END_SESSION, endSessionSoon, parseAt, sessionField, type Session } from './trigger-session'

export interface DocMentionOptions {
  /** 页面目录（Editor 的 listPages 结果），候选来源 */
  pages: () => Page[] | null
  /** 可点名的 agent 目录（default-agent.ts 的 agentList） */
  agents: () => AgentInfo[]
  /** 当前页：决定空间（skill / 成员候选按它取），「最近」不列它自己 */
  pageId: string
  /** viewer 只读时不弹出、不拦键 */
  enabled: boolean
  /** `[[新名字` 选「新建页面」：建当前页的子页并返回它（失败抛错，菜单只记日志） */
  createPage: (title: string) => Promise<Page>
}

interface DocMentionController {
  view: EditorView
  menu: HTMLElement
  opts: DocMentionOptions
  /** 当前候选（鼠标点击与键盘选中走同一条 pick） */
  matches: Candidate[]
  activeIndex: number
  /** 上一次的查询词：变了（打字筛选）高亮回第一项，没变（协同 / 目录到达重画）保持 */
  lastQuery: string
  /** `@` 进入的分类（null 是顶层） */
  category: MentionCategory | null
  /** 当前会话的触发符位置，变了就是新会话（分类归零、后台补取 skill / 成员） */
  sessionAt: number | null
  /** 当前查询（键位判断要用：空查询退格回顶层） */
  query: string
  trigger: MentionTrigger | null
  /** 上一次真正重建 DOM 时的行签名，没变就只换高亮不重建（见 render） */
  renderedSig: string
}

const docMentionKey = new PluginKey<Session | null>('rametDocMention')

/** handleKeyDown（editorViewOptionsCtx 通道）拿不到 view 工厂闭包，经此表按 view 取用；
 *  destroy 时摘除，换页重建编辑器后旧条目自然失效（同 slash.ts） */
const controllers = new WeakMap<EditorView, DocMentionController>()

const anywhere = (): boolean => true

function hide(c: DocMentionController): void {
  c.menu.style.display = 'none'
  c.renderedSig = ''
}

/** 会话没了：菜单收起、分类导航归零 */
function reset(c: DocMentionController): void {
  hide(c)
  c.category = null
  c.sessionAt = null
}

/** 结束会话（Esc / 选中 / 失焦，事件回调里同步派发） */
function endSession(view: EditorView): void {
  if (docMentionKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(docMentionKey, END_SESSION))
}

/** 光标处的查询，at 是触发符的文档位置。requireSession 为 true 时只认会话开着时的那一段（菜单显示 / 键盘用），
 *  false 时按当下光标现找（「新建页面」异步建好回来时会话已结束，按光标处的 `[[…` 换） */
function queryAt(view: EditorView, requireSession = true): { at: number; trigger: MentionTrigger; query: string } | null {
  const hit = parseAt(view.state, mentionQuery, anywhere)
  if (!hit) return null
  const session = docMentionKey.getState(view.state)
  if (requireSession && (!session || session.at !== hit.at || session.trigger !== hit.trigger)) return null
  return { at: hit.at, trigger: hit.trigger as MentionTrigger, query: hit.query }
}

/** 每次 PM 更新都会走到这里（协同光标、别人的编辑、block-select 在 body 上按下时派的清选事务……），
 *  行没变就不重建 DOM，只换高亮：鼠标按下到松开之间按钮若被换掉，click 落到共同祖先上，菜单项就点不中；
 *  顺带滚动中的列表也不会被拽回高亮项 */
function render(c: DocMentionController): void {
  const rows = mentionRows(c.matches, c.opts.pages(), c.trigger === '@' ? c.category : null)
  const sig = JSON.stringify([c.trigger, rows.map((r) => (r.kind === 'item' ? [r.index, candidateKey(r.cand), r.title, r.aside, r.icon] : [r.kind, r.title]))])
  if (sig === c.renderedSig) {
    for (const btn of c.menu.querySelectorAll<HTMLElement>('.pop-row')) btn.classList.toggle('is-active', btn.dataset.index === String(c.activeIndex))
    return
  }
  c.renderedSig = sig
  const list = document.createElement('div')
  list.className = 'mention-list'
  for (const row of rows) {
    if (row.kind === 'section') {
      const title = document.createElement('div')
      title.className = 'pop-section'
      title.textContent = row.title
      list.appendChild(title)
      continue
    }
    if (row.kind === 'back') {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'mention-back'
      back.title = COPY.mention.back
      back.innerHTML = iconSvg('chevron', 12)
      back.append(row.title)
      back.addEventListener('mousedown', (e) => e.preventDefault())
      back.addEventListener('click', () => act(c, { type: 'back' }))
      list.appendChild(back)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = row.index === c.activeIndex ? 'pop-row is-active' : 'pop-row'
    btn.dataset.index = String(row.index)
    const title = document.createElement('span')
    title.className = 'pop-t'
    title.textContent = row.title
    btn.append(rowIconEl(row.icon), title)
    if (row.aside) {
      const aside = document.createElement('span')
      aside.className = 'pop-aside'
      aside.textContent = row.aside
      btn.appendChild(aside)
    }
    if (row.enter) btn.appendChild(chevronEl())
    // 不能抢编辑器焦点：blur 先于 click 处理完，焦点没了 click 就到不了（slash 菜单同款）
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('mousemove', () => {
      if (c.activeIndex !== row.index) setActive(c, row.index)
    })
    btn.addEventListener('click', () => act(c, activate(row.cand)))
    list.appendChild(btn)
  }
  const children: HTMLElement[] = [list]
  if (c.trigger === '@') {
    const foot = document.createElement('div')
    foot.className = 'mention-foot'
    foot.textContent = COPY.mention.hint
    children.push(foot)
  }
  c.menu.replaceChildren(...children)
  c.menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
}

/** 只换高亮，不重画（鼠标划过 / 方向键） */
function setActive(c: DocMentionController, index: number): void {
  c.activeIndex = index
  for (const btn of c.menu.querySelectorAll<HTMLElement>('.pop-row')) {
    btn.classList.toggle('is-active', btn.dataset.index === String(index))
  }
  c.menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
}

/** 把「触发符..光标」换成 chip，光标落到 chip 之后。范围按当下 state 现算（候选是上一帧渲染的，建页是异步的） */
function insertChip(c: DocMentionController, make: (view: EditorView) => ProsemirrorNode | null, requireSession = true): void {
  const view = c.view
  if (view.isDestroyed) return
  const hit = queryAt(view, requireSession)
  const node = make(view)
  if (!hit || !node) return
  const tr = view.state.tr.replaceWith(hit.at, view.state.selection.from, node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(hit.at + node.nodeSize), 1))
  tr.setMeta(docMentionKey, END_SESSION)
  view.dispatch(tr)
  view.focus()
}

const pageChip = (page: { id: string; title: string }) => (view: EditorView) =>
  view.state.schema.nodes.page_mention?.create({ pageId: page.id, title: mentionLabel(page.title) }) ?? null

/** 菜单动作（键位 / 点击都走这里）：进出分类只改控制器状态再重画，选中走 pick */
function act(c: DocMentionController, action: MentionKeyAction): void {
  switch (action.type) {
    case 'move':
      return move(c, action.delta)
    case 'enter':
    case 'back':
      c.category = action.type === 'enter' ? action.cat : null
      c.activeIndex = 0
      return refresh(c.view, c)
    case 'pick':
      return pick(c, action.cand)
    case 'close':
      reset(c)
      return endSession(c.view)
  }
}

function pick(c: DocMentionController, cand: Candidate): void {
  if (cand.kind === 'category') {
    act(c, { type: 'enter', cat: cand.cat })
  } else if (cand.kind === 'agent') {
    insertChip(c, (view) => view.state.schema.nodes.agent_mention?.create({ agentId: cand.id, label: cand.label }) ?? null)
  } else if (cand.kind === 'page') {
    insertChip(c, pageChip(cand.page))
  } else if (cand.kind === 'skill') {
    // skill 是指向 skill 页的页面提及，标题是 skill 名（斜杠菜单点名同口径，服务端发给 agent 时写成 skill:<名字>）
    insertChip(c, pageChip({ id: cand.skill.id, title: cand.skill.name }))
  } else if (cand.kind === 'person') {
    insertChip(c, (view) => view.state.schema.nodes.user_mention?.create({ userId: cand.person.id, name: cand.person.username }) ?? null)
  } else {
    // 先收起菜单、结束会话（建页要一会儿），建好了再按当下光标处的 `[[…` 换成 chip，失败只记日志
    hide(c)
    endSession(c.view)
    void c.opts
      .createPage(cand.title)
      .then((page) => insertChip(c, pageChip(page), false))
      .catch((err: unknown) => console.error(err))
  }
}

function move(c: DocMentionController, delta: number): void {
  const n = c.matches.length
  if (!n) return
  setActive(c, (((c.activeIndex + delta) % n) + n) % n)
}

/** 每次 PM 更新重算：会话、查询、候选、渲染、定位。没有候选就结束会话 */
function refresh(view: EditorView, c: DocMentionController): void {
  if (!c.opts.enabled || !view.hasFocus() || !view.editable) return reset(c)
  const hit = queryAt(view)
  if (!hit) return reset(c)
  if (c.sessionAt !== hit.at) {
    // 新会话：分类归零，skill / 成员后台补取，到了且还是这个会话就重画
    c.sessionAt = hit.at
    c.category = null
    const at = hit.at
    void warmMentionSources(c.opts.pages(), c.opts.pageId).then(() => {
      if (!view.isDestroyed && c.sessionAt === at) refresh(view, c)
    })
  }
  c.trigger = hit.trigger
  c.query = hit.query
  const sources = mentionSources(c.opts.pages(), c.opts.agents(), c.opts.pageId)
  c.matches = candidatesFor({ trigger: hit.trigger, start: 0, end: 0, query: hit.query }, sources, hit.trigger === '@' ? c.category : null)
  if (c.matches.length === 0) {
    reset(c)
    endSessionSoon(view, (tr) => tr.setMeta(docMentionKey, END_SESSION), () => docMentionKey.getState(view.state) !== null)
    return
  }
  // 筛选结果变了（打字）回到第一项，只是重画（协同、目录到达）保持当前项
  if (hit.query !== c.lastQuery || c.activeIndex >= c.matches.length) c.activeIndex = 0
  c.lastQuery = hit.query
  render(c)
  // 光标处的查询范围转视口坐标（fixed 定位，不被 .main 的滚动容器裁剪）
  const rect = posToDOMRect(view, hit.at, view.state.selection.from)
  c.menu.style.display = 'flex'
  const width = c.menu.offsetWidth
  c.menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
  // 下面放不下（手机软键盘占掉下半屏）就翻到光标上方，以可视视口的高度为准，不是布局视口
  const below = rect.bottom + 6
  const height = c.menu.offsetHeight
  const visibleBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight
  c.menu.style.top = `${below + height > visibleBottom - 8 && rect.top - height - 6 >= 8 ? rect.top - height - 6 : below}px`
}

/** 正文引用菜单。enabled 为 false（viewer）时只挂一个空插件，不弹也不拦键 */
export function docMention(opts: DocMentionOptions) {
  return $prose(() => {
    return new Plugin<Session | null>({
      key: docMentionKey,
      state: sessionField((tr) => tr.getMeta(docMentionKey), mentionQuery, anywhere),
      props: {
        // 失焦（点到别处、切走窗口）就结束会话，点菜单项不失焦（mousedown 已 preventDefault）
        handleDOMEvents: {
          blur: (view) => {
            endSession(view)
            return false
          },
        },
      },
      view: (view) => {
        const menu = document.createElement('div')
        menu.className = 'pop-card chat-mention doc-mention'
        menu.style.display = 'none'
        menu.style.position = 'fixed'
        menu.style.bottom = 'auto'
        document.body.appendChild(menu)
        const c: DocMentionController = {
          view,
          menu,
          opts,
          matches: [],
          activeIndex: 0,
          lastQuery: '',
          category: null,
          sessionAt: null,
          query: '',
          trigger: null,
          renderedSig: '',
        }
        controllers.set(view, c)
        return {
          update: (v: EditorView) => refresh(v, c),
          destroy: () => {
            controllers.delete(view)
            menu.remove()
          },
        }
      },
    })
  })
}

/** 键盘通道（同 slash.ts）：菜单可见才拦，拦哪些键由 mention-nav.ts 定（↑↓ / Enter / Tab / ← → / 空查询退格 / Esc）。
 *  委托既有 handleKeyDown，不覆盖别人 */
export function configDocMention(ctx: Ctx) {
  ctx.update(editorViewOptionsCtx, (prev) => {
    const prior = prev.handleKeyDown
    return {
      ...prev,
      handleKeyDown: (view: EditorView, event: KeyboardEvent): boolean => {
        if (event.isComposing) return false
        const c = controllers.get(view)
        if (!c || c.menu.style.display === 'none' || c.matches.length === 0) return prior ? prior(view, event) === true : false
        const action = mentionKey(event, { category: c.category, query: c.query, active: c.matches[c.activeIndex] })
        if (!action) return prior ? prior(view, event) === true : false
        act(c, action)
        return true
      },
    }
  })
}
