// ---------- slash 菜单 ----------
// 静态块与 agent 命令同一个 items 数组，键盘覆盖全部项；带参命令写成 `>>` 草稿而不是 window.prompt。
// 一次性触发（slashSession，trigger-session.ts）：只有刚打出 `/` 的那一下开启，之后打字 = 筛选，
// 光标离开 / 失焦 / Esc / 没有匹配就结束，光标挪回旧的 `/` 后面不再弹。每项左边图标块 + 名称 + 一行说明，
// 按名称 / 说明 / 英文别名筛选，分组（基础块 / 媒体 / agent 命令 / Skill）。样式见 styles/menus.css。

import { editorViewOptionsCtx } from '@milkdown/kit/core'
import { slashFactory } from '@milkdown/kit/plugin/slash'
import type { Ctx } from '@milkdown/kit/ctx'
import { setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import { EditorView } from '@milkdown/kit/prose/view'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { api } from '../api'
import { COPY } from '../copy'
import { cachedSkills, loadSkills, type SkillSummary } from '../skill-api'
import { agentCommandsFor, agentStateFor, pageAgent, sendAgentMessage } from './agent-bar'
import { agentName } from './ai-block'
import { REMEMBER_COMMAND } from '../memory/remember'
import { startMessageDraft } from './doc-send'
import { pickAndInsert } from './media'
import { iconSvg, type IconName } from '../icons'
import { END_SESSION, endSessionSoon, parseAt, sessionField, slashQuery, type Session } from './trigger-session'
// 补丁版 SlashProvider：修 isSame 被后续 no-op 事务顶掉导致 IME 提交 "/" 后菜单不弹，详见 vendor/plugin-slash-patched.js 头部
import { SlashProvider } from '../vendor/plugin-slash-patched'
import { insertTable } from './table-ops'
import { insertMathBlock, insertMathInline } from './math'
import { openInlineMathEditor } from './math-view'
import { insertColumns } from './columns'
import { promptEmbed } from './embed'
import { selectionTurnRange, turnInto, type ContainerKind } from './block-turn'
import { insertBlockAtCursor } from './block-insert'
import { insertCollectionBlock, insertLinkView } from '../collection/slash-collection'
import type { Page } from '../api'

/** 斜杠「提示框 / 折叠块」：把光标所在块包进容器（空段落 = 空提示框 / 空折叠块，光标留在里面） */
function turnHere(view: EditorView, kind: ContainerKind): void {
  const range = selectionTurnRange(view.state)
  if (range) turnInto(view, range.from, range.to, { kind: 'wrap', wrap: kind })
}

/** 斜杠插原子块（目录）：空段落换掉，否则插在光标所在块后面 */
function insertAtom(view: EditorView, name: string): void {
  const type = view.state.schema.nodes[name]
  if (!type) return
  const { $from } = view.state.selection
  const tr = view.state.tr
  if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth >= 1) tr.replaceWith($from.before(), $from.after(), type.create())
  else tr.insert($from.depth >= 1 ? $from.after() : view.state.selection.to, type.create())
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

export const slash = slashFactory('ramet-slash')

function nodeType(view: EditorView, name: string) {
  const type = view.state.schema.nodes[name]
  if (!type) throw new Error(`schema 里没有节点 ${name}`)
  return type
}

// 一次性触发会话（trigger-session.ts）：只在段落里，`/` 到光标不含空白
const slashSessionKey = new PluginKey<Session | null>('rametSlashSession')
const inParagraph = ($from: { parent: { type: { name: string } } }): boolean => $from.parent.type.name === 'paragraph'

/** 会话开着时光标处的查询词（`/` 之后、光标之前）；会话没开 / 光标已不在那段 → null */
function sessionQuery(view: EditorView): string | null {
  const session = slashSessionKey.getState(view.state)
  if (!session) return null
  const hit = parseAt(view.state, slashQuery, inParagraph)
  return hit && hit.at === session.at ? hit.query : null
}

/** 结束会话（Esc / 失焦，事件回调里同步派发） */
function endSlash(view: EditorView): void {
  if (slashSessionKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(slashSessionKey, END_SESSION))
}

/** 斜杠会话插件：编辑器要 `.use(slashSession)`（菜单本体是 slash factory 的插件，挂不了 state） */
export const slashSession = $prose(
  () =>
    new Plugin<Session | null>({
      key: slashSessionKey,
      state: sessionField((tr) => tr.getMeta(slashSessionKey), slashQuery, inParagraph),
      props: {
        handleDOMEvents: {
          // 失焦 = 结束；点菜单项不失焦（mousedown 已 preventDefault）。结束只改插件 state，provider 的 isSame
          // （doc / 选区都没变）会跳过求值，所以菜单要这里亲手藏
          blur: (view) => {
            slashControllers.get(view)?.provider.hide()
            endSlash(view)
            return false
          },
        },
      },
    }),
)

/** 删掉「/查询词」整段并结束会话（执行菜单项前） */
function clearSlash(view: EditorView) {
  const session = slashSessionKey.getState(view.state)
  const hit = parseAt(view.state, slashQuery, inParagraph)
  if (!session || !hit || hit.at !== session.at) return
  view.dispatch(view.state.tr.delete(hit.at, view.state.selection.from).setMeta(slashSessionKey, END_SESSION))
}

export interface SlashActions {
  pageId: string
  navigate: (to: string) => void
  onChanged: () => void
  /** 子页要落进父页所在空间（后端同空间约束：缺省落个人空间会 400） */
  getSpaceId: () => string | undefined
  /** slash 建的子页登记进 link-watcher 的 linkedChildren，此后该页链接从文档消失才会级联删页 */
  onChildLinked?: (pageId: string) => void
  /** 页面列表（「链接视图」列出本空间的集合） */
  getPages?: () => readonly Page[] | null
}

/** 「创建页面」：当前页下建子页，光标处插 page_ref 块（整行卡片，点块进入），然后直接进入新页。
 *  落点规则（空段替换 / 当前块后 / 列表里跳出到顶层列表之后）在 block-insert.ts，集合块共用 */
async function createPageAtCursor(view: EditorView, actions: SlashActions): Promise<void> {
  try {
    const created = await api.createPage(actions.pageId, actions.getSpaceId())
    actions.onChanged()
    actions.onChildLinked?.(created.id) // 先登记再插块，之后此块从文档消失才会触发删页
    const pageRef = view.state.schema.nodes.page_ref
    if (!pageRef) return
    insertBlockAtCursor(view, pageRef.create({ pageId: created.id, title: '新页面' }))
    actions.navigate(`/page/${created.id}`)
  } catch (err) {
    console.error(err)
  }
}

/** 菜单里的一项。静态块与 agent 命令放在同一个数组里：键盘导航、高亮、执行都只认这个数组，
 *  分组只是渲染时的分隔，不是两套逻辑 */
interface SlashItem {
  label: string
  hint: string
  group: 'blocks' | 'media' | 'agent' | 'ramet' | 'skill'
  /** 左边图标块：图标名，或几个字的文字块（标题的 H1 / H2 / H3） */
  icon: { svg: IconName } | { text: string }
  /** 英文别名（筛选也匹配它们）：/h1、/todo、/code …… */
  keys: readonly string[]
  run: (v: EditorView) => void
}

/** 筛选：名称 / 说明 / 别名任一包含查询词（不区分大小写）；空查询 = 全部 */
function matches(item: SlashItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q) || item.keys.some((k) => k.includes(q))
}

/** 斜杠菜单键盘导航状态：挂在每次 buildSlashMenu 产出的 menu 上，经 slashControllers 供 handleKeyDown 取用 */
interface SlashNav {
  activeIndex: number
  /** 归一化 index（循环）并同步 DOM 高亮 */
  setActive: (index: number) => void
  /** 循环移动高亮（ArrowDown/Up） */
  move: (delta: number) => void
  /** 执行当前高亮项（与鼠标点击同路径：clearSlash → item.run → focus） */
  runActive: (view: EditorView) => void
  /** 菜单每次弹出复位到第一项（provider.onShow 钩） */
  reset: () => void
}

interface SlashController {
  menu: HTMLElement
  provider: SlashProvider
  nav: SlashNav
}

/* handleKeyDown（editorViewOptionsCtx 通道）无法直接拿到 view 工厂闭包里的 provider/nav，
 * 经此表按视图取用；destroy 时摘除，换页重建编辑器后旧条目自然失效 */
const slashControllers = new WeakMap<EditorView, SlashController>()

const H = COPY.slash.blockHints

/** 静态块命令（不随 agent 变） */
function blockItems(view: EditorView, actions: SlashActions): SlashItem[] {
  const schema = view.state.schema
  const block =
    (group: 'blocks' | 'media', icon: SlashItem['icon'], keys: readonly string[]) =>
    (label: string, hint: string, run: SlashItem['run']): SlashItem => ({ label, hint, group, icon, keys, run })
  const svg = (name: IconName): SlashItem['icon'] => ({ svg: name })
  return [
    block('blocks', svg('file'), ['page', 'new'])('创建页面', H.page, (v) => void createPageAtCursor(v, actions)),
    block('blocks', svg('table'), ['collection', 'database', 'db', '数据库'])(COPY.collection.embed.slashInline, COPY.collection.embed.slashInlineHint, (v) =>
      void insertCollectionBlock(v, actions),
    ),
    block('blocks', svg('link'), ['linked', 'view', 'database', 'collection'])(COPY.collection.embed.slashLink, COPY.collection.embed.slashLinkHint, (v) =>
      insertLinkView(v, actions),
    ),
    block('blocks', { text: 'H1' }, ['h1', 'heading1', 'title'])('标题 1', H.h1, (v) => setBlockType(schema.nodes.heading!, { level: 1 })(v.state, v.dispatch, v)),
    block('blocks', { text: 'H2' }, ['h2', 'heading2'])('标题 2', H.h2, (v) => setBlockType(schema.nodes.heading!, { level: 2 })(v.state, v.dispatch, v)),
    block('blocks', { text: 'H3' }, ['h3', 'heading3'])('标题 3', H.h3, (v) => setBlockType(schema.nodes.heading!, { level: 3 })(v.state, v.dispatch, v)),
    block('blocks', svg('list-bullet'), ['ul', 'bullet', 'list'])('无序列表', H.bullet, (v) => wrapInList(schema.nodes.bullet_list!)(v.state, v.dispatch, v)),
    block('blocks', svg('list-number'), ['ol', 'number', 'ordered', 'list'])('有序列表', H.ordered, (v) => wrapInList(schema.nodes.ordered_list!)(v.state, v.dispatch, v)),
    block('blocks', svg('todo'), ['todo', 'task', 'check'])('待办列表', H.todo, (v) => {
      // gfm 的待办 = 带 checked 的 list_item：先套 bullet list，再打 checked 标记
      if (!wrapInList(schema.nodes.bullet_list!)(v.state, v.dispatch, v)) return
      const { $from } = v.state.selection
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d)
        if (node.type.name === 'list_item' && node.attrs.checked !== undefined) {
          v.dispatch(v.state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: false }))
          break
        }
      }
    }),
    block('blocks', svg('blockquote'), ['quote', 'blockquote'])('引用', H.quote, (v) => wrapIn(schema.nodes.blockquote!)(v.state, v.dispatch, v)),
    block('blocks', svg('code-block'), ['code', 'codeblock'])('代码块', H.code, (v) => setBlockType(schema.nodes.code_block!)(v.state, v.dispatch, v)),
    block('blocks', svg('table'), ['table', 'grid'])('表格', H.table, (v) => insertTable(v)),
    block('blocks', svg('sigma'), ['math', 'latex', 'equation', 'formula'])('公式', H.math, (v) => insertMathBlock(v)),
    block('blocks', svg('callout-note'), ['callout', 'note', 'tip', 'warning', 'alert'])('提示框', H.callout, (v) => turnHere(v, 'callout')),
    block('blocks', svg('toggle'), ['toggle', 'details', 'collapse', 'fold'])('折叠块', H.toggle, (v) => turnHere(v, 'toggle')),
    block('blocks', svg('toc'), ['toc', 'outline', 'contents'])('目录', H.toc, (v) => insertAtom(v, 'toc')),
    block('blocks', svg('columns'), ['columns', 'column', 'layout', '2'])('两栏', H.columns2, (v) => insertColumns(v, 2)),
    block('blocks', svg('columns'), ['columns', 'column', 'layout', '3'])('三栏', H.columns3, (v) => insertColumns(v, 3)),
    block('blocks', { text: '$' }, ['inline math', 'latex', 'math'])('行内公式', H.mathInline, (v) => {
      const pos = insertMathInline(v)
      if (pos !== null) openInlineMathEditor(v, pos)
    }),
    block('blocks', svg('divider'), ['hr', 'divider', 'line'])('分隔线', H.divider, (v) => insertBlockAtCursor(v, nodeType(v, 'hr').create())),
    // 上传入口：共用 pickAndInsert（media.ts）—— 隐藏 file input → uploadFile → 按 mime 插 image/attachment。
    // 「图片」限定 image/* 只是选择器初筛，选中非图片仍按附件插（accept 不是硬约束）
    block('media', svg('image'), ['image', 'img', 'picture', 'photo'])('图片', H.image, (v) => pickAndInsert(v, 'image/*')),
    block('media', svg('paperclip'), ['file', 'attachment', 'upload'])('附件', H.attachment, (v) => pickAndInsert(v, '')),
    block('media', svg('embed'), ['embed', 'video', 'youtube', 'bilibili', 'iframe', 'figma'])('嵌入', H.embed, (v) => promptEmbed(v)),
  ]
}

/** agent 命令：读的是下一条消息实际会发给的那个 agent（与聊天输入卡 / 文档发送同一条 pageAgent 解析）
 *  的命令，SSE commands 事件推送，菜单每次弹出重读。
 *  - 不带参数：`/name` 直接作为用户消息走现有发送路径（追加 >> 块 + POST continue）；
 *  - 带参数（有 input hint）：在文档末尾起一条 `>>` 草稿 `/name `，光标留在末尾由用户补参数，
 *    补完和普通消息一样发送（发送钮 / 末尾空行回车）；参数输入走正文这条路径，IME、引用、多行都正常。 */
function agentItems(pageId: string, agent: string): SlashItem[] {
  return agentCommandsFor(pageId, agent).map((cmd) => ({
    label: cmd.name,
    hint: cmd.description,
    group: 'agent' as const,
    icon: { svg: 'terminal' as const },
    keys: [],
    run: (v: EditorView) =>
      cmd.input ? startMessageDraft(v, `/${cmd.name} `, agent) : sendAgentMessage(v, pageId, `/${cmd.name}`, agent),
  }))
}

/** Ramet 自己的命令（不属于哪个 agent）：「记住」「带队」。都是带参命令，和 agent 的带参命令一样起一条 `>>` 草稿，补完内容发送：
 *  - 记住：发送时由 doc-send.ts 的 sendLast 接手（直接记进空间的公共记忆，不发给 agent）；
 *  - 带队：就是一条普通消息，发给当前 agent（组长）；服务端认出 `/带队` 开头，这一轮让它出计划，计划卡里确认后才开工 */
const rametItems = (full: boolean): SlashItem[] => {
  const items: SlashItem[] = [
    {
      label: COPY.memory.slash.label,
      hint: COPY.memory.slash.hint,
      group: 'ramet',
      icon: { svg: 'memory' },
      keys: ['remember', 'memory', '记忆'],
      run: (v: EditorView) => startMessageDraft(v, `${REMEMBER_COMMAND} `),
    },
  ]
  // 带队要的工具（submit_plan / send_back、组员的 run_agent）只有完整档才有：别的档不给入口（服务端也只在完整档认 `/带队`）
  if (full) {
    items.push({
      label: COPY.team.slash.label,
      hint: COPY.team.slash.hint,
      group: 'ramet',
      icon: { svg: 'users' },
      keys: ['team', 'lead', 'plan', 'swarm', '组长', '计划'],
      run: (v: EditorView) => startMessageDraft(v, `${COPY.team.command} `),
    })
  }
  return items
}

/** 点名一个 skill：光标处插一颗指向 skill 页的 page_mention chip（标题 = skill 名）+ 一个空格。
 *  发给 agent 时服务端把它写成 `skill:<名字>`（agents/refs.ts），agent 看到就用 use_skill 加载 */
function insertSkillMention(view: EditorView, skill: SkillSummary): void {
  const type = view.state.schema.nodes.page_mention
  if (!type) return
  const { from, to } = view.state.selection
  const node = type.create({ pageId: skill.id, title: skill.name })
  const tr = view.state.tr.replaceWith(from, to, [node, view.state.schema.text(' ')])
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + node.nodeSize + 1), 1))
  view.dispatch(tr)
}

const skillItems = (skills: SkillSummary[]): SlashItem[] =>
  skills.map((skill) => ({
    label: skill.name,
    hint: skill.description,
    group: 'skill' as const,
    icon: { svg: 'skill' as const },
    keys: [],
    run: (v: EditorView) => insertSkillMention(v, skill),
  }))

function buildSlashMenu(
  view: EditorView,
  actions: SlashActions,
): { menu: HTMLElement; nav: SlashNav; refreshAgentItems: () => void; refreshSkills: () => void; filter: (query: string) => number } {
  const menu = document.createElement('div')
  menu.className = 'pop-card slash-menu'
  menu.setAttribute('role', 'listbox')

  const blocks = blockItems(view, actions)
  /** 全部项（块 + agent 命令 + skill）与按当前查询词筛出来的那些（导航 / 渲染只认后者） */
  let all: SlashItem[] = blocks
  let items: SlashItem[] = blocks
  let query = ''
  /** 当前空间的 skill 列表（缓存里的旧值先上，弹出时后台刷新） */
  let skills: SkillSummary[] = []
  let agentTitle = ''
  let buttons: HTMLButtonElement[] = []

  const runItem = (v: EditorView, item: SlashItem): void => {
    clearSlash(v)
    item.run(v)
    v.focus()
  }

  // 高亮样式 .slash-menu .slash-item.is-active；键盘与鼠标共用同一个 activeIndex
  const nav: SlashNav = {
    activeIndex: 0,
    setActive(index) {
      const n = items.length
      if (!n) return
      this.activeIndex = ((index % n) + n) % n
      buttons.forEach((btn, i) => {
        const active = i === this.activeIndex
        btn.classList.toggle('is-active', active)
        btn.setAttribute('aria-selected', String(active))
      })
      // 只滚菜单自己，不用 scrollIntoView：它会连带滚动页面——弹出那一下 floating-ui 的定位还没落（异步），
      // 菜单仍在 CSS 的 top:0，整页被拽到编辑器顶部，等 skill 列表到达重画时再拽回来（「按 / 画面先上跳再下来」）
      const btn = buttons[this.activeIndex]
      if (btn) {
        const top = btn.offsetTop
        const bottom = top + btn.offsetHeight
        if (top < menu.scrollTop) menu.scrollTop = top
        else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight
      }
    },
    move(delta) {
      this.setActive(this.activeIndex + delta)
    },
    runActive(v) {
      const item = items[this.activeIndex]
      if (item) runItem(v, item)
    },
    reset() {
      this.setActive(0)
    },
  }

  const groupTitle = (group: SlashItem['group']): string =>
    group === 'blocks' ? COPY.slash.blocks : group === 'media' ? COPY.slash.media : group === 'skill' ? COPY.slash.skills : group === 'ramet' ? COPY.slash.ramet : agentTitle

  /** 整个菜单按 items 重画：分组标题只是相邻项 group 变了插一行，导航不区分分组 */
  const render = (): void => {
    menu.replaceChildren()
    buttons = []
    let group: SlashItem['group'] | '' = ''
    items.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group
        const title = document.createElement('div')
        title.className = 'pop-section'
        title.textContent = groupTitle(group)
        menu.appendChild(title)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pop-row slash-item'
      btn.setAttribute('role', 'option')
      const ic = document.createElement('span')
      ic.className = 'pop-ic'
      ic.setAttribute('aria-hidden', 'true')
      if ('svg' in item.icon) ic.innerHTML = iconSvg(item.icon.svg, 18)
      else ic.textContent = item.icon.text
      const text = document.createElement('span')
      text.className = 'pop-text'
      const name = document.createElement('span')
      name.className = 'pop-t'
      name.textContent = item.label
      text.appendChild(name)
      if (item.hint) {
        const hint = document.createElement('span')
        hint.className = 'pop-d'
        hint.textContent = item.hint
        text.appendChild(hint)
      }
      btn.append(ic, text)
      btn.addEventListener('mousedown', (e) => e.preventDefault()) // 别把编辑器焦点抢走
      btn.addEventListener('mousemove', () => {
        if (nav.activeIndex !== i) nav.setActive(i)
      })
      btn.addEventListener('click', () => runItem(view, item))
      menu.appendChild(btn)
      buttons.push(btn)
    })
    nav.setActive(nav.activeIndex)
  }

  const refreshAgentItems = (): void => {
    const agent = pageAgent(actions.pageId)
    const cmds = agent ? agentItems(actions.pageId, agent) : []
    // 工具档位（agent-bar 的 AgentState.tools）不是完整：没有 use_skill，点名 skill 也没用，同带队一起不给
    const full = agentStateFor(actions.pageId).tools === 'full'
    all = [...blocks, ...cmds, ...rametItems(full), ...(full ? skillItems(skills) : [])]
    items = all.filter((item) => matches(item, query))
    agentTitle = COPY.slash.agent(agentName(agent) || agent)
    render()
  }
  /** 换查询词：重新筛选并重画，返回筛出来几项（0 = 宿主收起并结束会话） */
  const filter = (next: string): number => {
    if (next !== query) {
      query = next
      items = all.filter((item) => matches(item, query))
      nav.activeIndex = 0
      render()
    }
    return items.length
  }
  /** skill 列表：同空间 30 秒内复用缓存，过期才打服务端；到了新列表就重画（菜单正开着也跟着出现） */
  const refreshSkills = (): void => {
    const spaceId = actions.getSpaceId()
    if (!spaceId) return
    skills = cachedSkills(spaceId) ?? skills
    void loadSkills(spaceId).then((list) => {
      if (list === skills) return
      skills = list
      refreshAgentItems()
    })
  }
  refreshAgentItems()

  return { menu, nav, refreshAgentItems, refreshSkills, filter }
}

export function configSlash(ctx: Ctx, actions: SlashActions) {
  ctx.update(slash.key, (prev) => ({
    ...prev,
    view: (view: EditorView) => {
      const { menu: content, nav, refreshAgentItems, refreshSkills, filter } = buildSlashMenu(view, actions)
      // 显隐 = 一次性触发会话开着 + 有焦点 + 可编辑 + 筛完还有项（没有 → 结束会话，之后不再复活）。
      // 关掉官方 200ms debounce，菜单立即出；时序问题已由补丁版 isSame 解决，debounce 不再承担兜底职责
      const provider = new SlashProvider({
        content,
        debounce: 0,
        shouldShow: (v: EditorView) => {
          if (!v.editable || !(v.hasFocus() || content.contains(document.activeElement))) return false
          const q = sessionQuery(v)
          if (q === null) return false
          if (filter(q) > 0) return true
          endSessionSoon(v, (tr) => tr.setMeta(slashSessionKey, END_SESSION), () => slashSessionKey.getState(v.state) !== null)
          return false
        },
      })
      let shown = false
      provider.onShow = () => {
        if (shown) return // 会话期间每次击键都会再 show：只在弹出那一下刷新目录、复位高亮（筛选自己复位）
        shown = true
        refreshSkills() // 空间的 skill 列表（有缓存先用缓存，过期才请求）
        refreshAgentItems() // 重读 commands 事件推送（晚于菜单构建到达的命令也能出现）
        nav.reset()
      }
      provider.onHide = () => {
        shown = false
      }
      slashControllers.set(view, { menu: content, provider, nav })
      return {
        update: (updatedView: EditorView, prevState?: Parameters<typeof provider.update>[1]) =>
          provider.update(updatedView, prevState),
        destroy: () => {
          slashControllers.delete(view)
          provider.destroy()
          content.remove()
        },
      }
    },
  }))
  // 键盘导航：与 configLinkNav 的 handleDOMEvents 同走 editorViewOptionsCtx 通道，键位不同互不覆盖。
  // 菜单可见（dataset.show === 'true'，SlashProvider 维护）才拦 ↑/↓/Enter/Tab/Esc，不可见一律放行；
  // IME 组合中的按键必须交给输入法（选字/确认拼音），不能拦。
  // handleKeyDown 属 direct editor props，PM 在插件 keymap 之前先咨询它：菜单可见时拦住 Enter
  // 可防止 listItemKeymap 的 splitListItem 抢先执行
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    handleKeyDown: (view: EditorView, event: KeyboardEvent): boolean => {
      if (event.isComposing) return false
      const ctrl = slashControllers.get(view)
      if (!ctrl || ctrl.menu.dataset.show !== 'true') return false
      switch (event.key) {
        case 'ArrowDown':
          ctrl.nav.move(1)
          return true
        case 'ArrowUp':
          ctrl.nav.move(-1)
          return true
        case 'Enter':
        case 'Tab':
          // 与鼠标点击同路径；执行后选区/文档变化 → provider 下一轮 update 因 shouldShow 不成立自动 hide
          ctrl.nav.runActive(view)
          return true
        case 'Escape':
          // 一次性触发：藏起来并结束会话，"/" 留在原地也不会再弹
          ctrl.provider.hide()
          endSlash(view)
          return true
        default:
          return false
      }
    },
  }))
}
