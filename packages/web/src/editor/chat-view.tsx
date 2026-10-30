import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
import { buildFailStrip, isFailedReply } from './reply-fail'
import { buildActs, bubbleActsFor, type BubbleActs } from './chat-acts'
import { hydrateRich } from './rich-render'
import { clearCarried, peekCarried, registerComposer } from './composer-bridge'
import { useRemember } from '../memory/use-remember'
import { RunErrorBar, agentCommandsFor, appendUserMessage, runAgent, sendAgentMessage, setAgentRunError, setPageTools, type AgentState } from './agent-bar'
import { ContextRing, contextFor, repliesOf } from './context-ring'
import { AttachStrip, useAttachments } from './composer-attach'
import { QueueList } from './queue-list'

/** 在跑时的发送钮：排队（服务端保存，这一轮正常结束后自动发） */
const COPY_QUEUE = '排队：这一轮结束后自动发送（⌘Enter 停下当前这一轮、立即发送）'
import { nextModeStep, useAgentControls } from './agent-controls'
import { ChipBar } from './chip-bar'
import { useChatFollow } from './chat-follow'
import ComposerInput, { type ComposerInputHandle } from './composer-input'
import { rewriteDraft } from './quick-draft'
import { isQuickKey } from './quick-keys'
import { useAgents } from '../default-agent'
import MentionMenu from './mention-menu'
import { ModeHint } from './mode-hint'
import { candidatesFor, mentionLabel, mentionQuery, type Candidate, type MentionCategory, type MentionQuery } from './mention-query'
import { mentionKey, type MentionKeyAction } from './mention-nav'
import { mentionSources, warmMentionSources } from './mention-sources'
import { advance, type Session } from './trigger-session'
import { chatUnits, registerChatUnits } from './view-morph'
import { flyFrom } from '../motion'
import { redoableUserIds } from './reply-target'
import { avatarKey, fillAvatar, personOf, subscribePeople, type Person } from '../people'

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

/** 气泡正文直接用文档节点的 DOM（agent 回复的 markdown 就是被落成这些节点的）。serializer 按 schema 缓存 */
let cached: { schema: Schema; serializer: DOMSerializer } | null = null

function contentSerializer(schema: Schema): DOMSerializer {
  if (cached?.schema !== schema) cached = { schema, serializer: DOMSerializer.fromSchema(schema) }
  return cached.serializer
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
  /** 用户消息有「重新回复」落点 */
  redo: boolean,
  /** 用户消息的发言人（AI 回复不用） */
  author: Person | null,
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
    else if (kind === 'ai') {
      // 没有实时视图接管的失败气泡：失败条放在运行条的位置，agent 的计划清单（回复块的 plan 属性）紧随其后
      if (isFailedReply(node.attrs.stats)) bubble.append(buildFailStrip({ ...retry, replyId: id, rest }))
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
      dom.append(buildReplyHead(typeof agentId === 'string' ? agentId : '', [row, chip]), bubble)
    } else {
      dom.append(buildUserAvatar(author), bubble)
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
): DecorationSet {
  const decos: Decoration[] = []
  const redoable = redoableUserIds(doc)
  for (const mark of landmarks(doc)) {
    const node = mark.node
    if (mark.kind !== 'user' && mark.kind !== 'ai') {
      decos.push(
        Decoration.node(mark.off, mark.off + node.nodeSize, {
          'data-rail': String(mark.id),
        }),
      )
      continue
    }
    const isAi = mark.kind === 'ai'
    const agentId: unknown = node.attrs.agent
    const id = typeof agentId === 'string' ? agentId : ''
    const badge = isAi ? agentBadge(id) : null
    const name = isAi ? agentName(id) : ''
    const live = isAi && slot ? slot.attach(node) : null
    // @ 点名链停在这条失败回复后还剩几个（只有最后一条回复算，其余 0）
    const replyId: unknown = node.attrs.id
    const rest = isAi && typeof replyId === 'string' ? chainRestAfter(doc, replyId) : 0
    // 用户消息的「重新回复」取决于它后面的块（删掉回复 / 新消息到达），节点自己没变，所以要进 key 才会重建
    const redo = !isAi && typeof replyId === 'string' && redoable.has(replyId)
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
        buildBubble(mark.kind, node, mark.id, enter, isOpen, live, slot, retry, acts, rest, redo, author),
        {
          side: 1,
          key: `m:${nodeKey(node)}:${iconKey}:${name}:${live?.phase ?? ''}:${rest}:${redo ? 'r' : ''}:${isAi ? '' : avatarKey(author)}`,
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

/** 空状态提示的开关：文档一变就重算 */
function emptyWatchPlugin(onChange: (empty: boolean) => void): Plugin {
  return new Plugin({
    view: () => ({ update: (view) => onChange(isEmptyDoc(view.state.doc)) }),
  })
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
  let opened = false
  let arm = 0
  const isOpen = () => opened
  // 正在跑的回复归实时视图（live-slot.ts），store 换了一轮或结束时重算气泡
  let slot: LiveSlot | null = null
  const retry = { pageId, canRetry: canStop }
  return new Plugin({
    key: chatDecoKey,
    state: {
      init: (_, state) => chatDecorations(state.doc, enter, isOpen, slot, retry, acts, meta()),
      apply: (_tr, _prev, _old, state) => chatDecorations(state.doc, enter, isOpen, slot, retry, acts, meta()),
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
      // 成员列表（发言人头像）到了或自己换了头像，重算气泡
      const offPeople = subscribePeople(refresh)
      return {
        destroy: () => {
          cancelAnimationFrame(arm)
          slot?.dispose()
          slot = null
          offLogo()
          offPeople()
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
  /** 与主编辑器同一 Y.Doc（EditorPage 经 ref 暴露 provider.document） */
  getDoc: () => Y.Doc | undefined
  /** 编辑器建好 / 换页信号：chat 视图依赖其 schema，就绪后再建 */
  tick: number
  /** agent SSE 状态（Editor 的 useAgentEvents）：运行中 / 会话配置项 / cwd */
  agentState: AgentState
}

export default function ChatView({ pageId, readOnly, pages, onPagesChanged, getEditor, getDoc, tick, agentState }: Props) {
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
  const { agents } = useAgents()
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
  // 初始值是从文档模式带过来的草稿（composer-bridge：切换时没发出去的输入跟着走）
  const [input, setInput] = useState(peekCarried)
  const inputText = useRef(input)
  useEffect(() => {
    inputText.current = input
  }, [input])
  useEffect(() => {
    clearCarried() // 已经落进输入框
  }, [])
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
  // 图片附件（粘贴 / 拖入），上传中不能发
  const attach = useAttachments(setAgentRunError)
  const hasAttach = attach.items.some((a) => a.url)
  // `/记住 内容` 是 Ramet 自己的命令，直接记进这个空间的公共记忆，不发给 agent（memory/remember.ts）
  const remember = useRemember(pages?.find((p) => p.id === pageId)?.space_id, !readOnly)
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
          emptyWatchPlugin(setEmpty),
        ],
      }),
      editable: () => false,
      // 点击 / 复制 / 拖拽交给浏览器：PM 的处理器按它自己的选区行事（三击选段自己写选区，点图片建 NodeSelection，
      // 复制和拖拽取 PM 选区的内容），而这里 PM 不持有用户看到的选区（见下）
      handleDOMEvents: { mousedown: () => true, copy: () => true, dragstart: () => true },
    })
    // 选区不归 PM。气泡是 widget，PM 的选区表示不了气泡里的位置：拖选时它把 DOM 选区折算到气泡边界
    // （落进 display:none 的原消息块）再写回去，浏览器下一次 mousemove 又把选区拉出来，结果拖动时一直闪、松手什么也没选中。
    // widget 的 ignoreSelection 只管选区整个落在一个气泡里，拖过气泡边（选整条回复时很常见）时公共祖先是视图根，PM 照样接管，
    // 文档一更新也会把记着的旧选区写回 DOM。PM 没有公开开关，这里让它看不到 DOM 选区：domSelection() 是内部方法，
    // 返回 null 是它本来就处理的情形（getSelection() 可以为 null），读写 DOM 选区的路径都就此跳过。升 prosemirror-view 时核对它还在
    Object.assign(view, { domSelection: () => null })
    setEmpty(isEmptyDoc(view.state.doc))
    // 文档 ⇄ 对话切换的文字单元来源（view-morph.ts）：普通块和气泡正文里的各段，气泡本身是壳，淡入淡出
    const offBlocks = registerChatUnits(() => chatUnits(view, host))
    return () => {
      offBlocks()
      view.destroy()
    }
  }, [getDoc, getEditor, tick, readOnly, pageMeta])

  /** 整框换成这段记号文字（框里升成 chip）；输入框还没建好时先记下，建好时灌进去 */
  const setComposerText = useCallback((text: string) => {
    inputText.current = text
    setInput(text)
    composerRef.current?.setText(text)
  }, [])

  // 输入框登记给桥：气泡的「引用」往里放记号，切回文档时取走没发出去的字
  useEffect(() => {
    if (readOnly) return
    return registerComposer({
      get: () => composerRef.current?.text() ?? inputText.current,
      set: setComposerText,
      insert: (text) => {
        const prev = composerRef.current?.text() ?? inputText.current
        setComposerText(`${prev}${prev && !/\s$/.test(prev) ? ' ' : ''}${text} `)
        composerRef.current?.focus()
      },
    })
  }, [readOnly, setComposerText])

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
    if ((!text && !hasAttach) || attach.uploading) return
    // `/记住 …` 不是给 agent 的消息，不写进文档、不触发运行，记下了才清输入框
    if (text && remember.run(text, () => setComposerText(''))) return
    // 在跑时排到服务端（这一轮正常结束后由服务端写进文档并发起下一轮），不直接写进文档
    if (running) return enqueue(text, attach.take(), jump)
    let main: EditorView | undefined
    getEditor()?.action((ctx) => {
      main = ctx.get(editorViewCtx)
    })
    if (!main || main.isDestroyed) return
    const from = composerRef.current?.dom()?.getBoundingClientRect()
    controls.pin() // 用过的来源就是这页的来源：别的页再换来源，这页刷新也不跟着变
    appendUserMessage(main, text, undefined, attach.take()) // 气泡随 Y 同步立即出现在只读视图里
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
  function enqueue(text: string, images: string[], jump: boolean) {
    controls.pin()
    if (text) flushSync(() => setComposerText(''))
    void api
      .enqueue(pageId, { agent, kind: 'message', text, images })
      .then(({ item }) => (jump ? api.sendQueuedNow(pageId, item.id) : undefined))
      .catch((err: unknown) => {
        if (text) setComposerText(text)
        setAgentRunError(err instanceof Error ? `排队失败：${err.message}` : '排队失败')
      })
  }

  /** 撤回的排队消息：文字接在输入框里已有的话后面，图片回到附件 */
  function restoreQueued(text: string, images: string[]) {
    const cur = (composerRef.current?.text() ?? input).trim()
    if (text) setComposerText(cur ? `${cur}\n${text}` : text)
    attach.restore(images)
  }

  /** 压缩上下文就是发一条 `/compact`（agent 自带命令，走斜杠菜单的发送路径），在跑就排队 */
  function compact() {
    if (running) return enqueue('/compact', [], false)
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
      setAgentRunError(err instanceof Error ? `停止失败：${err.message}` : '停止失败')
    })
  }

  return (
    <div className="chat-page">
      <div className="chat-thread">
        <RunErrorBar />
        {empty && (
          <div className="chat-empty">
            这是空对话。在下方输入框发消息（Enter 发送）会以「&gt;&gt; 内容」写进文档并触发 agent；
            输入框下面能切 agent、工作区、模型和思考程度；想直接写文档，点右上角「文档模式」。
          </div>
        )}
        <div className="chat-root" ref={hostRef} />
      </div>
      <div className="chat-dock">
        {follow.away && (
          <button className="chat-jump" onClick={() => follow.toLatest()}>
            回到最新
          </button>
        )}
        {!readOnly && <ModeHint pageId={pageId} agent={agent} pending={controls.opts} />}
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
            <AttachStrip items={attach.items} onRemove={attach.remove} />
            <div className="chat-composer-line">
              <ComposerInput
                ref={composerRef}
                getSchema={getSchema}
                tick={tick}
                initial={input}
                placeholder="输入消息，@ 提及，Enter 发送，Shift+Enter 换行…"
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
                onKeyDown={(e) => {
                  // ⌘J 随手 AI：把输入框里的话写清楚，只改草稿不发送，一步 ⌘Z 回原文
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
              {running && (input.trim() || hasAttach) ? (
                <button
                  type="button"
                  className="chat-send is-queue"
                  onClick={() => send()}
                  disabled={attach.uploading}
                  title={COPY_QUEUE}
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
                  disabled={(!input.trim() && !hasAttach) || attach.uploading}
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
