import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type * as Y from 'yjs'
import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'
import { Plugin, PluginKey, EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode, Schema } from '@milkdown/kit/prose/model'
import { DOMSerializer } from '@milkdown/kit/prose/model'
import { ySyncPlugin } from 'y-prosemirror'
import { decodePlan, decodeTeam } from '@ramet/shared/run-model'
import { api, type Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { agentBadge, agentName, buildReplyHead, watchAgentLogo } from './ai-block'
import { chainRestAfter } from './chain-state'
import { landmarks } from './doc-rail'
import { LiveSlot, type LiveHit } from './live-slot'
import { buildPlanStrip } from './plan-card'
import { buildTeamStrip, disposeTeamStrips } from '../team/team-mount'
import { buildDock } from '../hud/dock'
import { buildFailStrip, buildStoppedStrip, isFailedReply, isStoppedReply } from './reply-fail'
import { buildActs, bubbleActsFor, type BubbleActs } from './chat-acts'
import { hydrateRich } from './rich-render'
import { autoTag, buildNoticeCard, isNotice } from './task-notice'
import { quietDecorations } from './quiet-fold'
import { clearCarried, imageMark, peekCarried, registerComposer } from './composer-bridge'
import { useRemember } from '../memory/use-remember'
import { RunErrorBar, agentCommandsFor, appendUserMessage, runAgent, sendAgentMessage, setAgentRunError, setPageTools, type AgentState } from './agent-bar'
import { ContextRing, contextFor, repliesOf } from './context-ring'
import { AttachTray, useAttachments } from './composer-attach'
import { attCard, attItemsOf, attLabels } from './att-cards'
import { wireAttHover } from './att-hover'
import { attachLayout, onAttachLayout, useAttachLayout, type AttachLayout } from './attach-layout'
import { QueueList } from './queue-list'

/** 在跑时的发送钮：排队（服务端保存，这一轮正常结束后自动发） */
const COPY_QUEUE = '排队：这一轮结束后自动发送（⌘Enter 停下当前这一轮、立即发送）'
import { nextModeStep, useAgentControls } from './agent-controls'
import { ChipBar } from './chip-bar'
import { useChatFollow } from './chat-follow'
import ComposerInput, { type ComposerInputHandle } from './composer-input'
import { rewriteDraft } from './quick-draft'
import { isQuickKey } from './quick-keys'
import MentionMenu from './mention-menu'
import { ModeHint } from './mode-hint'
import { candidatesFor, mentionLabel, mentionQuery, type Candidate, type MentionCategory, type MentionQuery } from './mention-query'
import { mentionKey, type MentionKeyAction } from './mention-nav'
import { mentionSources, useMentionAgents, warmMentionSources } from './mention-sources'
import { advance, type Session } from './trigger-session'
import { chatUnits, registerChatUnits } from './view-morph'
import { flyFrom } from '../motion'
import { lastReply, redoableUserIds, resumableReply, resumes } from './reply-target'
import { avatarKey, fillAvatar, personOf, subscribePeople, type Person } from '../people'
import { isAssistantPage } from '../assistant/identity'
import { useTaskMarks } from '../assistant/task-status'

/* ---------- 传统（聊天）模式视图 ----------
 * 文档按消息块渲染成聊天气泡流（节点定义见 message-blocks.ts）：顶层 user_message 是用户气泡（靠右），
 * 顶层 agent_reply 是 AI 气泡（靠左，icon / 名字取产出它的 agent，见 ai-block.ts），其余块（含 `>` 引用块）按普通 Markdown 渲染。
 *
 * 只读 PM 视图绑同一个 Y fragment（主编辑器隐藏但仍挂载并协同，y-prosemirror 对同一 fragment 开多个视图是合法的）。
 * 装饰层把消息块 display:none 并在它前面插气泡 widget，文档一变装饰重算，不需要 React 重渲染。 */

/** 用户气泡的头像：发言人（消息的 author，没记的回落页面创建者）的头像，规则在 people.ts */
function buildUserAvatar(person: Person | null): HTMLElement {
  const plate = document.createElement('span')
  plate.className = 'chat-avatar'
  fillAvatar(plate, person)
  return plate
}

/** 页面的空间与创建者，查发言人头像用：空间决定去哪份成员列表里找，创建者是消息没记发言人时的回落 */
export interface PageMeta {
  spaceId: string | null
  ownerId: string
}

/** 气泡正文直接用文档节点的 DOM（agent 回复的 markdown 就是被落成这些节点的）。serializer 按 schema 缓存：
 *  同时在场的两个对话各有自己编辑器的 schema，只缓存一份的话两边交替重算时每个气泡都要重建一次 serializer */
const serializers = new WeakMap<Schema, DOMSerializer>()

function contentSerializer(schema: Schema): DOMSerializer {
  let serializer = serializers.get(schema)
  if (!serializer) {
    serializer = DOMSerializer.fromSchema(schema)
    serializers.set(schema, serializer)
  }
  return serializer
}

/** 气泡 widget 的 key 用节点身份：PM 与 y-prosemirror 都复用没变的节点对象，所以节点变了（内容 / 属性）key 才变。
 *  用文本长度做 key 的话，流式时每个字整条重建，等长编辑又不刷新 */
const nodeIds = new WeakMap<ProsemirrorNode, number>()
let nextNodeId = 0
function nodeKey(node: ProsemirrorNode): number {
  let id = nodeIds.get(node)
  if (id === undefined) {
    id = ++nextNodeId
    nodeIds.set(node, id)
  }
  return id
}

/** 气泡：kind 决定左右 / 配色，AI 侧带顶栏（名字 + 用量标签）。
 * 用户气泡不挂调用配置（来源 / 模型 / 思考 / 路径在底部输入卡里）。
 * 正在跑的那条（live）正文是实时视图的 body、气泡尾是状态条，收尾后真内容替换上来，状态条飞进标签。
 * `railId` 是地标序号（doc-rail.tsx 的 landmarks 给的），落成 `data-rail` 供右轨跳转定位 */
function buildBubble(
  kind: 'user' | 'ai',
  node: ProsemirrorNode,
  railId: number,
  enter: Set<string>,
  isOpen: () => boolean,
  live: LiveHit | null,
  slot: LiveSlot | null,
  retry: { pageId: string; canRetry: boolean },
  acts: BubbleActs | null,
  rest: number,
  /** 用户消息有「重新回复」落点；AI 回复是「失败 / 停止后能续跑」（最后一块、不是带队轮） */
  redo: boolean,
  /** 用户消息的发言人（AI 回复不用） */
  author: Person | null,
  /** 附件摆法：托盘时用户消息的附件排成卡片放在气泡上方（attach-layout.ts） */
  layout: AttachLayout,
): () => HTMLElement {
  return () => {
    const dom = document.createElement('div')
    dom.className = `chat-msg chat-${kind}`
    dom.dataset.rail = String(railId)
    // 入场动画只给视图打开之后新出现的消息（收尾重建气泡不重播）
    const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    if (id) dom.dataset.blk = id // 文档 ⇄ 对话切换按块 id 配对（view-morph.ts）
    if (id && !enter.has(id)) {
      enter.add(id)
      if (isOpen()) dom.classList.add('is-new')
    }
    const bubble = document.createElement('div')
    bubble.className = 'chat-bubble'
    // AI 回复的抬头行与文档模式同一套（ai-block.ts 的 buildReplyHead），切换时整行平移；用户消息是头像 + 右侧气泡
    const a = node.attrs as { id?: unknown; agent?: unknown; stats?: unknown; plan?: unknown; run?: unknown }
    const chip = kind === 'ai' ? buildDock({ id: a.id, agent: a.agent, stats: a.stats, plan: a.plan, run: a.run }, retry.pageId) : null
    // 气泡内纵向顺序：运行条、正文（运行条高度封顶，正文位置与步骤数无关）
    if (live) bubble.append(live.ctrl.strip)
    else if (kind === 'user') {
      const tag = autoTag(node)
      if (tag) bubble.append(tag)
    } else if (kind === 'ai') {
      // 没有实时视图接管的失败 / 停止气泡：失败条或「已停止 · 继续」条放在运行条的位置，agent 的计划清单（回复块的 plan 属性）紧随其后
      if (isFailedReply(node.attrs.stats)) bubble.append(buildFailStrip({ ...retry, replyId: id, rest, resume: redo }))
      else if (redo && retry.canRetry && isStoppedReply(node.attrs.stats)) bubble.append(buildStoppedStrip(retry.pageId, id))
      const plan = decodePlan(node.attrs.plan)
      if (plan.length > 0) bubble.append(buildPlanStrip(plan))
      const team = decodeTeam(node.attrs.team)
      if (team) bubble.append(buildTeamStrip(team, { pageId: retry.pageId, canAct: retry.canRetry }))
    }
    if (live?.phase === 'live') {
      bubble.classList.add('is-live')
      dom.classList.add('is-live')
      bubble.append(live.ctrl.body)
    } else {
      // 正文逐块序列化并标序号（data-part），文档 ⇄ 对话切换按 块 id#序号 与文档里的子块配对（view-morph.ts）
      const serializer = contentSerializer(node.type.schema)
      node.content.forEach((child, _off, i) => {
        const el = serializer.serializeNode(child)
        if (el instanceof HTMLElement) el.dataset.part = String(i)
        bubble.append(el)
      })
      hydrateRich(bubble) // 静态 DOM 没有 nodeView，代码高亮 / mermaid 要在这里补（rich-render.ts）
    }
    if (live?.phase === 'landing') requestAnimationFrame(() => slot?.land(chip))
    // 轻操作：悬停出现（触屏常显），正在跑的这条没有。AI 的在抬头行右端，用户的在气泡下方
    const row = acts && !live ? buildActs(kind, node, acts, retry.canRetry, dom, redo) : null
    if (kind === 'ai') {
      row?.classList.add('is-head')
      const agentId: unknown = node.attrs.agent
      dom.append(buildReplyHead(typeof agentId === 'string' ? agentId : '', [row, chip], retry.pageId), bubble)
    } else {
      // 一条用户消息是附件悬停联动的一个单元（att-hover.ts）
      dom.dataset.attUnit = ''
      const items = layout === 'tray' ? attItemsOf(node) : []
      if (items.length > 0) {
        const labels = attLabels(items)
        const cards = document.createElement('div')
        cards.className = 'att-cards'
        cards.append(...items.map((item, i) => attCard(item, labels[i]!)))
        const col = document.createElement('div')
        col.className = 'chat-user-col'
        col.append(cards, bubble)
        dom.append(buildUserAvatar(author), col)
      } else dom.append(buildUserAvatar(author), bubble)
      if (row) dom.append(row)
    }
    return dom
  }
}

/** 消息块隐藏原节点并前插气泡 widget，非消息地标（标题）与其余块原样渲染。
 * 锚只挂可见元素：消息的可见元素是气泡（在这里挂），标题走节点装饰 */
function chatDecorations(
  doc: ProsemirrorNode,
  enter: Set<string>,
  isOpen: () => boolean,
  slot: LiveSlot | null,
  retry: { pageId: string; canRetry: boolean },
  acts: BubbleActs | null,
  meta: PageMeta,
  /** 展开过的任务通知（task-notice.ts）与「不用处理」折叠（quiet-fold.ts） */
  expanded: Set<string>,
): DecorationSet {
  // Genet 标了「不用处理」的一轮：回复与它看过的通知折成一行，收起的块不画气泡（还在收尾动画里的先不折）
  const quiet = quietDecorations(doc, expanded, 'chat', (node) => slot?.attach(node) != null)
  const decos: Decoration[] = [...quiet.decos]
  const layout = attachLayout()
  const redoable = redoableUserIds(doc)
  const last = lastReply(doc)
  for (const mark of landmarks(doc)) {
    const node = mark.node
    if (quiet.hidden.has(mark.off)) continue
    if (mark.kind !== 'user' && mark.kind !== 'ai') {
      decos.push(
        Decoration.node(mark.off, mark.off + node.nodeSize, {
          'data-rail': String(mark.id),
        }),
      )
      continue
    }
    // 任务通知不是谁说的话：画成通知卡，不是用户气泡
    if (isNotice(node)) {
      const card = buildNoticeCard(node, mark.id, contentSerializer(node.type.schema), enter, isOpen, expanded)
      decos.push(Decoration.node(mark.off, mark.off + node.nodeSize, { style: 'display:none' }))
      decos.push(Decoration.widget(mark.off, card, { side: 1, key: `n:${nodeKey(node)}` }))
      continue
    }
    const isAi = mark.kind === 'ai'
    const agentId: unknown = node.attrs.agent
    const id = typeof agentId === 'string' ? agentId : ''
    const badge = isAi ? agentBadge(id) : null
    const name = isAi ? agentName(id, retry.pageId) : ''
    const live = isAi && slot ? slot.attach(node) : null
    // @ 点名链停在这条失败回复后还剩几个（只有最后一条回复算，其余 0）
    const replyId: unknown = node.attrs.id
    const rest = isAi && typeof replyId === 'string' ? chainRestAfter(doc, replyId) : 0
    // 用户消息的「重新回复」、AI 回复能不能续跑都取决于它后面的块（删掉回复 / 新消息到达），节点自己没变，所以要进 key 才会重建
    const redo = isAi ? resumes(node, last) : typeof replyId === 'string' && redoable.has(replyId)
    // 发言人取消息记的 author，没记的回落页面创建者；成员列表还没到时先画中性头像，到了由 subscribePeople 重算
    const authorAttr: unknown = node.attrs.author
    const author = isAi ? null : personOf(meta.spaceId, typeof authorAttr === 'string' && authorAttr ? authorAttr : meta.ownerId)
    // key = 节点身份 + icon + 名字 + 实时阶段 + 重答落点，任一变了 DOM 重建
    const iconKey = badge === null ? '' : badge.kind === 'mark' ? badge.key : badge.text
    decos.push(
      Decoration.node(mark.off, mark.off + node.nodeSize, {
        style: 'display:none',
      }),
    )
    decos.push(
      Decoration.widget(
        mark.off,
        buildBubble(mark.kind, node, mark.id, enter, isOpen, live, slot, retry, acts, rest, redo, author, layout),
        {
          side: 1,
          key: `m:${nodeKey(node)}:${iconKey}:${name}:${live?.phase ?? ''}:${rest}:${redo ? 'r' : ''}:${isAi ? '' : `${avatarKey(author)}:${layout}`}`,
          destroy: disposeTeamStrips, // 气泡里的带队卡有 React root，气泡被换掉时卸载
        },
      ),
    )
  }
  return DecorationSet.create(doc, decos)
}

const chatDecoKey = new PluginKey<DecorationSet>('chatDeco')

/** 空对话：0 个子节点，或只有一个空段落（新页服务端播种的形状）。
 * 只含图片 / 引用块这类非消息内容的页面不算空，它们本来就会渲染出来 */
function isEmptyDoc(doc: ProsemirrorNode): boolean {
  if (doc.textContent.trim().length > 0) return false
  if (doc.childCount === 0) return true
  if (doc.childCount > 1) return false
  const only = doc.child(0)
  return only.type.name === 'paragraph' && only.content.size === 0
}

/** 视图每次更新之后（气泡已在 DOM 里）通知宿主：空状态提示、Genet 页的任务状态标 */
function updateWatchPlugin(onUpdate: (view: EditorView) => void): Plugin {
  return new Plugin({
    view: () => ({ update: onUpdate }),
  })
}

/** 气泡里点到的页面提及 chip 指向哪一页：气泡是静态 DOM，没有编辑器里的点击跳转 */
function clickedPage(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('.chat-bubble [data-page-mention]') : null
  return el?.dataset.pageMention || null
}

function chatDecoPlugin(
  pageId: string,
  host: HTMLElement,
  canStop: boolean,
  acts: BubbleActs,
  meta: () => PageMeta,
): Plugin {
  // 这条视图见过的消息 id。opened 在首帧之后才为真：打开时已经在的历史消息不入场，之后新来的才播
  const enter = new Set<string>()
  const expanded = new Set<string>()
  let opened = false
  let arm = 0
  const isOpen = () => opened
  // 正在跑的回复归实时视图（live-slot.ts），store 换了一轮或结束时重算气泡
  let slot: LiveSlot | null = null
  const retry = { pageId, canRetry: canStop }
  return new Plugin({
    key: chatDecoKey,
    state: {
      init: (_, state) => chatDecorations(state.doc, enter, isOpen, slot, retry, acts, meta(), expanded),
      apply: (_tr, _prev, _old, state) => chatDecorations(state.doc, enter, isOpen, slot, retry, acts, meta(), expanded),
    },
    props: { decorations: (state) => chatDecoKey.getState(state) },
    // agent 目录 / 默认 agent 变化时重算气泡 logo（没记 agent 的块回落默认 agent，会跟着变）
    view: (view) => {
      const refresh = (): void => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(chatDecoKey, true))
      }
      slot = new LiveSlot({
        pageId,
        canStop,
        visible: () => host.offsetParent !== null,
        onChange: refresh,
        rest: (replyId) => chainRestAfter(view.state.doc, replyId),
        resume: (replyId) => resumableReply(view.state.doc, replyId),
      })
      // 首帧结束前把当前消息都记成已在场，历史记录不入场
      arm = requestAnimationFrame(() => {
        if (!view.isDestroyed) {
          for (const mark of landmarks(view.state.doc)) {
            if (mark.kind !== 'user' && mark.kind !== 'ai') continue
            const id = mark.node.attrs.id
            if (typeof id === 'string' && id) enter.add(id)
          }
        }
        opened = true
        refresh()
      })
      const offLogo = watchAgentLogo(view)
      // 成员列表（发言人头像）到了或自己换了头像、换了附件摆法，重算气泡
      const offPeople = subscribePeople(refresh)
      const offLayout = onAttachLayout(refresh)
      return {
        destroy: () => {
          cancelAnimationFrame(arm)
          slot?.dispose()
          slot = null
          offLogo()
          offPeople()
          offLayout()
        },
      }
    },
  })
}

interface Props {
  pageId: string
  readOnly: boolean
  /** 页面目录（Editor 的 listPages 结果）：@ 提示列表的候选来源 */
  pages: Page[] | null
  /** `[[新名字` 建了页面：通知外壳刷新侧栏 */
  onPagesChanged: () => void
  /** 活编辑器（换页拆建的窗口期是 undefined）：schema 来源 + 发送通道 */
  getEditor: () => Editor | undefined
  /** 与主编辑器同一 Y.Doc（usePageSession 的 getDoc） */
  getDoc: () => Y.Doc | undefined
  /** 编辑器建好 / 换页信号：chat 视图依赖其 schema，就绪后再建 */
  tick: number
  /** agent SSE 状态（Editor 的 useAgentEvents）：运行中 / 会话配置项 / cwd */
  agentState: AgentState
  /** 空对话时中间的提示；不给就是对话页的那句（说到了右上角的文档模式，嵌在别处时不对） */
  emptyHint?: string
  /** 发消息时用户正在看的页面（Genet 浮窗：不往输入框里放当前页的 chip，记在消息的 ctx 上，「这页」就是它） */
  focusPage?: string | null
  /** 输入框占位文字；不给用默认的 */
  placeholder?: string
}

export default function ChatView({
  pageId,
  readOnly,
  pages,
  onPagesChanged,
  getEditor,
  getDoc,
  tick,
  agentState,
  emptyHint,
  focusPage,
  placeholder = '输入消息，@ 提及，Enter 发送，Shift+Enter 换行…',
}: Props) {
  // 引用提示列表：`@` 大菜单（Agent / 页面 / Skill / 成员），`[[` 提及或新建页面（规则与文档模式同一份，见 mention-query.ts），pages 未加载（null）时不弹。
  // 一次性触发（trigger-session.ts）：只有刚键入 `@` / `[[` 才开启会话，挪光标只会延续或结束它。
  // base 是查询所在段落在输入框文档里的起点（下标都相对这一段，见 ComposerInput.caret）
  const [mention, setMention] = useState<(MentionQuery & { base: number }) | null>(null)
  const [mentionActive, setMentionActive] = useState(0)
  // `@` 进入的分类（null 是顶层），会话换了就归零（键位语义见 mention-nav.ts）
  const [mentionCat, setMentionCat] = useState<MentionCategory | null>(null)
  // skill / 成员从缓存同步取，会话开启时后台补取，到了靠它重画一次
  const [, setSourcesTick] = useState(0)
  const mentionSession = useRef<Session | null>(null)
  // @ 候选列全部工具：显式 @ 点名不受本页的工具锁定（它用自己的会话，对话内容靠补发带过去）；团队空间里另有空间 AI
  const agents = useMentionAgents(pageId)
  const matches =
    mention && pages ? candidatesFor(mention, mentionSources(pages, agents, pageId), mention.trigger === '@' ? mentionCat : null) : []
  /** 输入框内容 / 光标变了，按会话推进（typed 表示这次是键入，不是粘贴 / 拖放 / 删字 / 挪光标） */
  const syncMention = (typed: boolean): void => {
    const caret = composerRef.current?.caret() ?? null
    const parsed = caret && mentionQuery(caret.text, caret.cursor)
    const prev = mentionSession.current
    const next = advance(prev, parsed && { ...parsed, at: caret.base + parsed.start }, typed)
    mentionSession.current = next
    setMention(next && parsed ? { ...parsed, base: caret.base } : null)
    if (next === prev) return
    setMentionCat(null)
    if (next) void warmMentionSources(pages, pageId).then(() => setSourcesTick((t) => t + 1))
  }
  // 没有候选就结束会话；页面目录还没到（null）时先不判
  const noMatch = mention !== null && pages !== null && matches.length === 0
  useEffect(() => {
    if (!noMatch) return
    mentionSession.current = null
    setMention(null)
    setMentionCat(null)
  }, [noMatch])
  const hostRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerInputHandle>(null)
  // Genet 页：派出去的任务页链接后面挂运行状态（assistant/task-status.ts）
  const { sync: syncTasks } = useTaskMarks(pageId, isAssistantPage(pageId, agentState), pages, hostRef)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  // 初始值是从文档模式带过来的草稿（composer-bridge：切换时没发出去的输入跟着走）
  const [input, setInput] = useState(() => peekCarried(pageId))
  const inputText = useRef(input)
  useEffect(() => {
    inputText.current = input
  }, [input])
  useEffect(() => {
    // 首次渲染之后才带来的也接住：右下角浮窗走到这页时收起，在 layout effect 里带字，晚于上面读初始值，不接就在这里被清掉
    const late = peekCarried(pageId)
    clearCarried(pageId) // 已经落进输入框
    if (late && late !== inputText.current) setComposerText(late)
  }, [pageId])
  // 空对话提示：聊天模式中间是只读气泡区，空页面一片空白，需要给出下一步动作
  const [empty, setEmpty] = useState(false)
  // 控制项（来源 / 模型 / 思考 / 路径）的事实源与写入路径在 agent-controls.tsx
  const controls = useAgentControls(pageId, agentState, readOnly)
  const { agent, running } = controls
  // 上下文圆环：这个 agent 在跑取实时值，否则取文档里它最近一条收尾回复的 stats（收尾 / 换 agent / 新快照时重算，不随打字重算）
  const liveRun = agentState.run && !agentState.run.outcome ? agentState.run : null
  const ctx = useMemo(
    () => contextFor(repliesOf(getDoc()), agent, liveRun ? { ...(liveRun.agent ? { agent: liveRun.agent } : {}), ...(liveRun.state.info?.context ? { context: liveRun.state.info.context } : {}) } : null),
    [getDoc, agent, liveRun, liveRun?.version, agentState.status, tick],
  )
  const canCompact = agentCommandsFor(pageId, agent).some((c) => c.name === 'compact')
  // 图片附件（粘贴 / 拖入，插在框里），上传中不能发；摆法决定附件是行内 token 还是输入卡上方的托盘
  const reportError = useCallback((message: string) => setAgentRunError(pageId, message), [pageId])
  const attach = useAttachments(composerRef, reportError)
  const layout = useAttachLayout()
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => (pageRef.current ? wireAttHover(pageRef.current) : undefined), [])
  // `/记住 内容` 是 Ramet 自己的命令，不发给 agent：Genet 页上进个人记忆，别的页进这个空间的公共记忆（服务端按页面定，memory/remember.ts）
  const remember = useRemember(pageId, !readOnly)
  // 气泡装饰按需读页面的空间 / 创建者（发言人头像），经 ref 取最新 pages，免得 pages 变化重建对话视图
  const pagesRef = useRef(pages)
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])
  const pageMeta = useCallback((): PageMeta => {
    const page = pagesRef.current?.find((p) => p.id === pageId)
    return { spaceId: page?.space_id ?? null, ownerId: page?.owner_id ?? '' }
  }, [pageId])

  useEffect(() => {
    const doc = getDoc()
    const editor = getEditor()
    const host = hostRef.current
    if (!doc || !editor || !host) return
    let schema: Schema | undefined
    editor.action((ctx) => {
      schema = ctx.get(editorViewCtx).state.schema
    })
    if (!schema) return
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        plugins: [
          ySyncPlugin(doc.getXmlFragment('prosemirror')),
          chatDecoPlugin(pageId, host, !readOnly, bubbleActsFor(pageId, getEditor), pageMeta),
          updateWatchPlugin((v) => {
            setEmpty(isEmptyDoc(v.state.doc))
            syncTasks(host, v.state.doc)
          }),
        ],
      }),
      editable: () => false,
      // 点击 / 复制 / 拖拽交给浏览器：PM 的处理器按它自己的选区行事（三击选段自己写选区，点图片建 NodeSelection，
      // 复制和拖拽取 PM 选区的内容），而这里 PM 不持有用户看到的选区（见下）。
      // 例外是点页面提及：跳过去（拖选结束时的那一下不算）
      handleDOMEvents: {
        mousedown: () => true,
        copy: () => true,
        dragstart: () => true,
        click: (_v, event) => {
          const target = clickedPage(event.target)
          if (!target || event.button !== 0 || !(window.getSelection()?.isCollapsed ?? true)) return false
          navigateRef.current(`/page/${target}`)
          return true
        },
      },
    })
    // 选区不归 PM。气泡是 widget，PM 的选区表示不了气泡里的位置：拖选时它把 DOM 选区折算到气泡边界
    // （落进 display:none 的原消息块）再写回去，浏览器下一次 mousemove 又把选区拉出来，结果拖动时一直闪、松手什么也没选中。
    // widget 的 ignoreSelection 只管选区整个落在一个气泡里，拖过气泡边（选整条回复时很常见）时公共祖先是视图根，PM 照样接管，
    // 文档一更新也会把记着的旧选区写回 DOM。PM 没有公开开关，这里让它看不到 DOM 选区：domSelection() 是内部方法，
    // 返回 null 是它本来就处理的情形（getSelection() 可以为 null），读写 DOM 选区的路径都就此跳过。升 prosemirror-view 时核对它还在
    Object.assign(view, { domSelection: () => null })
    setEmpty(isEmptyDoc(view.state.doc))
    syncTasks(host, view.state.doc)
    // 文档 ⇄ 对话切换的文字单元来源（view-morph.ts）：普通块和气泡正文里的各段，气泡本身是壳，淡入淡出
    const offBlocks = registerChatUnits(pageId, () => chatUnits(view, host, composerRef.current?.dom() ?? null))
    return () => {
      offBlocks()
      view.destroy()
    }
  }, [getDoc, getEditor, tick, readOnly, pageMeta, syncTasks])

  /** 整框换成这段记号文字（框里升成 chip）；输入框还没建好时先记下，建好时灌进去 */
  const setComposerText = useCallback((text: string) => {
    inputText.current = text
    setInput(text)
    composerRef.current?.setText(text)
  }, [])

  // 输入框登记给桥：气泡的「引用」往里放记号，切回文档时取走没发出去的字
  useEffect(() => {
    if (readOnly) return
    return registerComposer(pageId, {
      get: () => composerRef.current?.text() ?? inputText.current,
      set: setComposerText,
      insert: (text) => {
        const composer = composerRef.current
        const prev = composer?.text() ?? inputText.current
        const add = `${prev && !/\s$/.test(prev) ? ' ' : ''}${text} `
        // 接在末尾，不整框重建：框里还在上传的图没有记号，重建会把它丢掉
        if (composer) composer.append(add)
        else setComposerText(`${prev}${add}`)
        composer?.focus()
      },
      dom: () => composerRef.current?.dom() ?? null,
      focus: () => composerRef.current?.focus(),
    })
  }, [pageId, readOnly, setComposerText])

  /** 输入框借主编辑器 schema 里的 chip 定义；编辑器换页拆建的窗口期取不到，等 tick */
  const getSchema = useCallback((): Schema | undefined => {
    let schema: Schema | undefined
    getEditor()?.action((ctx) => {
      schema = ctx.get(editorViewCtx).state.schema
    })
    return schema
  }, [getEditor])

  const follow = useChatFollow(hostRef, tick)

  /** 菜单动作（键位 / 点击都走这里）：进出分类只改状态，选中走 pickMention */
  function mentionAct(action: MentionKeyAction) {
    switch (action.type) {
      case 'move': {
        const n = matches.length
        if (n) setMentionActive((i) => (((i + action.delta) % n) + n) % n)
        return
      }
      case 'enter':
      case 'back':
        setMentionCat(action.type === 'enter' ? action.cat : null)
        setMentionActive(0)
        return
      case 'pick':
        return void pickMention(action.cand)
      case 'close':
        return closeMention()
    }
  }

  /** 选中候选：把「触发符..光标」换成 `@[名字](page:id)` / `agent:id` / `user:id` 记号，光标放到后面（记号不再被当作新查询）。
   *  skill 是指向 skill 页的页面记号（名字是 skill 名）。新建页面先建（当前页的子页）再插入。 */
  async function pickMention(cand: Candidate) {
    const q = mention
    if (!composerRef.current || !q) return
    if (cand.kind === 'category') return mentionAct({ type: 'enter', cat: cand.cat })
    closeMention()
    let insert: string
    if (cand.kind === 'agent') insert = `@[${cand.label}](agent:${cand.id})`
    else if (cand.kind === 'person') insert = `@[${cand.person.username}](user:${cand.person.id})`
    else if (cand.kind === 'skill') insert = `@[${cand.skill.name}](page:${cand.skill.id})`
    else {
      let page: { id: string; title: string }
      if (cand.kind === 'page') page = cand.page
      else {
        try {
          // 入口是插进消息里的提及，服务端不必再往对话正文里补子页面块
          page = await api.createPage(pageId, pages?.find((p) => p.id === pageId)?.space_id, {
            title: cand.title,
            link_in_parent: false,
          })
        } catch (err) {
          console.error(err)
          return
        }
        onPagesChanged()
      }
      insert = `@[${mentionLabel(page.title)}](page:${page.id})`
    }
    // 建页期间输入可能又变了：按当下的段落重新找这段查询，找不到就不插
    const composer = composerRef.current
    const now = composer?.caret()
    if (!composer || !now || now.base !== q.base) return
    const range = mentionQuery(now.text, Math.min(q.end, now.text.length))
    const at = range && range.trigger === q.trigger && range.start === q.start ? range : null
    if (!at) return
    // 记号在同一事务里升成 chip，光标落在 chip 后的空格之后（发送时的升级见 mention-upgrade）
    composer.replace(now.base + at.start, now.base + at.end, `${insert} `)
    composer.focus()
  }

  function closeMention() {
    mentionSession.current = null
    setMention(null)
    setMentionCat(null)
  }

  /** jump = ⌘Enter：在跑时插队（停下当前这一轮后马上发） */
  function send(jump = false) {
    const text = (composerRef.current?.text() ?? input).trim()
    if (!text || attach.uploading) return
    // `/记住 …` 不是给 agent 的消息，不写进文档、不触发运行，记下了才清输入框
    if (text && remember.run(text, () => setComposerText(''))) return
    // 在跑时排到服务端（这一轮正常结束后由服务端写进文档并发起下一轮），不直接写进文档
    if (running) return enqueue(text, jump)
    let main: EditorView | undefined
    getEditor()?.action((ctx) => {
      main = ctx.get(editorViewCtx)
    })
    if (!main || main.isDestroyed) return
    const from = composerRef.current?.dom()?.getBoundingClientRect()
    controls.pin() // 用过的来源就是这页的来源：别的页再换来源，这页刷新也不跟着变
    appendUserMessage(main, text, undefined, focusPage ?? undefined) // 图片 / 文件引用是文字里的记号，落在原位；气泡随 Y 同步立即出现在只读视图里
    flushSync(() => setComposerText('')) // 输入框先缩回一行，飞行终点才不会漂
    follow.toLatest(true)
    // 消息从输入框飞到新气泡的位置，替代 rise 入场
    const mine = hostRef.current?.querySelectorAll<HTMLElement>('.chat-msg.chat-user')
    const bubble = mine?.[mine.length - 1]
    if (from && bubble) {
      bubble.classList.remove('is-new')
      flyFrom(bubble, from, bubble.querySelector<HTMLElement>('.chat-bubble') ?? bubble)
    }
    // 没有可用 agent 时 runAgent 会把原因写进运行错误条
    runAgent(pageId, agent)
  }

  /** 排队，失败了把文字放回输入框 */
  function enqueue(text: string, jump: boolean) {
    controls.pin()
    if (text) flushSync(() => setComposerText(''))
    void api
      .enqueue(pageId, { agent, kind: 'message', text, images: [], ...(focusPage ? { ctx: focusPage } : {}) })
      .then(({ item }) => (jump ? api.sendQueuedNow(pageId, item.id) : undefined))
      .catch((err: unknown) => {
        if (text) setComposerText(text)
        setAgentRunError(pageId, err instanceof Error ? `排队失败：${err.message}` : '排队失败')
      })
  }

  /** 撤回的排队消息：文字（图片在里面，是记号）接在输入框里已有的话后面；老的排队项图片单列，接在它后面 */
  function restoreQueued(text: string, images: string[]) {
    const cur = (composerRef.current?.text() ?? input).trim()
    const back = [text, images.map(imageMark).filter(Boolean).join(' ')].filter(Boolean).join('\n')
    if (!back) return
    if (composerRef.current) composerRef.current.append(cur ? `\n${back}` : back)
    else setComposerText(cur ? `${cur}\n${back}` : back)
  }

  /** 压缩上下文就是发一条 `/compact`（agent 自带命令，走斜杠菜单的发送路径），在跑就排队 */
  function compact() {
    if (running) return enqueue('/compact', false)
    let main: EditorView | undefined
    getEditor()?.action((ctx) => {
      main = ctx.get(editorViewCtx)
    })
    if (!main || main.isDestroyed) return
    controls.pin()
    sendAgentMessage(main, pageId, '/compact', agent)
  }

  function stop() {
    void api.stopPage(pageId).catch((err: unknown) => {
      setAgentRunError(pageId, err instanceof Error ? `停止失败：${err.message}` : '停止失败')
    })
  }

  return (
    <div className="chat-page" ref={pageRef} data-att-layout={layout}>
      <div className="chat-thread">
        <RunErrorBar pageId={pageId} />
        {empty && (
          <div className="chat-empty">
            {emptyHint ?? (
              <>
                这是空对话。在下方输入框发消息（Enter 发送）会以「&gt;&gt; 内容」写进文档并触发 agent；
                输入框下面能切 agent、工作区、模型和思考程度；想直接写文档，点右上角「文档模式」。
              </>
            )}
          </div>
        )}
        <div className="chat-root" ref={hostRef} />
      </div>
      <div className="chat-dock" data-att-unit="">
        {follow.away && (
          <button className="chat-jump" onClick={() => follow.toLatest()}>
            回到最新
          </button>
        )}
        {!readOnly && <ModeHint pageId={pageId} agent={agent} pending={controls.opts} />}
        {/* 托盘在输入卡外面、上方：附件不跟输入框挤在一起，框里只留占位符 */}
        {!readOnly && layout === 'tray' && <AttachTray items={attach.items} onRemove={(i) => composerRef.current?.removeAtt(i)} />}
        {!readOnly && (
          <div className="chat-composer">
            {mention && pages && matches.length > 0 && (
              <MentionMenu
                matches={matches}
                pages={pages}
                trigger={mention.trigger}
                category={mention.trigger === '@' ? mentionCat : null}
                activeIndex={mentionActive}
                onActive={setMentionActive}
                onAct={mentionAct}
              />
            )}
            {remember.hint && (
              <div className={'chat-hint' + (remember.hint.error ? ' is-error' : '')} role="status">
                {remember.hint.text}
              </div>
            )}
            <QueueList pageId={pageId} items={agentState.queue.items} paused={agentState.queue.paused} onWithdraw={restoreQueued} />
            <div className="chat-composer-line">
              <ComposerInput
                ref={composerRef}
                getSchema={getSchema}
                tick={tick}
                initial={input}
                placeholder={placeholder}
                onChange={(text, typed) => {
                  const changed = text !== inputText.current
                  inputText.current = text
                  setInput(text)
                  // 只挪光标只会延续或结束会话，挪回旧的 `@` 后面不重开（typed 由输入框判定）
                  syncMention(typed)
                  if (changed) setMentionActive(0)
                }}
                onBlur={closeMention}
                onFiles={attach.add}
                onAtts={attach.onAtts}
                onKeyDown={(e) => {
                  // ⌘J ⌘J：把输入框里的话写清楚，只改草稿不发送，一步 ⌘Z 回原文
                  if (isQuickKey(e)) {
                    rewriteDraft({
                      get: () => composerRef.current?.text() ?? '',
                      set: (text) => {
                        const composer = composerRef.current
                        if (!composer) return false
                        composer.setText(text)
                        composer.focus()
                        return true
                      },
                      anchor: () => composerRef.current?.dom()?.getBoundingClientRect() ?? null,
                    })
                    return true
                  }
                  // 提示列表开着时键位归列表（哪些键见 mention-nav.ts），回车不发送
                  if (mention && matches.length > 0) {
                    const action = mentionKey(e, {
                      category: mention.trigger === '@' ? mentionCat : null,
                      query: mention.query,
                      active: matches[mentionActive],
                    })
                    if (action) mentionAct(action)
                    return action != null
                  }
                  // ⇧Tab 把权限模式转到下一档（agent 上报的顺序，跳过「跳过全部确认」档）。没得转（表外 agent / 不足两档）时不拦，键照旧
                  if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                    const step = nextModeStep(pageId, agent, controls.opts)
                    if (!step) return false
                    controls.changeOpt(step.configId, step.value)
                    return true
                  }
                  // Shift+Enter 换行（输入框自己的键位），输入法组字中的回车输入框不会问到这里
                  if (e.key !== 'Enter' || e.shiftKey) return false
                  send(e.metaKey || e.ctrlKey)
                  return true
                }}
              />
            </div>
            {/* 控制行与输入框同卡：agent / 目录 / 工具档位 / 模型 / 思考 / 权限模式都是这条消息怎么跑的一部分。
                工具档位是页面级的，只在这里摆（文档 `>>` 行不摆） */}
            <div className="chat-composer-bar">
              <ChipBar
                pageId={pageId}
                agent={agent}
                cwd={controls.cwd}
                opts={controls.opts}
                onAgent={controls.setAgent}
                onCwd={controls.applyCwd}
                onOpt={controls.changeOpt}
                tools={readOnly ? undefined : { value: agentState.tools, onChange: (p) => setPageTools(pageId, p) }}
              />
              {agentState.message && <span className="agent-status-msg">{agentState.message}</span>}
              {ctx && <ContextRing info={ctx} canCompact={canCompact && !readOnly} onCompact={compact} />}
              {running && input.trim() ? (
                <button
                  type="button"
                  className="chat-send is-queue"
                  onClick={() => send()}
                  disabled={attach.uploading}
                  data-tip={COPY_QUEUE}
                  aria-label={COPY_QUEUE}
                >
                  <Icon name="clock" size={16} />
                </button>
              ) : running ? (
                <button type="button" className="chat-send is-stop" onClick={stop} aria-label={COPY.chips.stop}>
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-send"
                  onClick={() => send()}
                  // 锁定的工具一台在线的都没有、又没 @ 别的 agent：发出去也只会被拒，提示在来源 chip 上
                  disabled={!input.trim() || attach.uploading || (agentState.lock !== '' && !agent && !input.includes('](agent:'))}
                  aria-label={COPY.chips.send}
                >
                  <Icon name="arrow-up" size={16} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
