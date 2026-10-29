/* ---------- 消息块：user_message（用户消息）+ agent_reply（AI 回复） ----------
 * 文档即会话：两类消息都是独立块节点，`>` 引用块完全归用户的普通引用（嵌套引用也是普通引用，
 * 不会被当成用户消息）。触发 / 渲染分别看 chat-view.tsx（气泡）、doc-send.ts（两次回车发送）、
 * ai-block.ts（agent_reply 顶栏 icon / 名字）。
 * markdown：两者都没有自然语法，toMarkdown 降级成「首段为标记段的引用块」（`[!user]` /
 * `[!agent <id>]`），打开页防抖 pass（Editor.tsx）/ 源码模式写回（source-sync.ts 的解析管线）
 * 由 upgradeMessageBlocks 升回块（page_ref 同套惯例）。
 * 归属：agent_reply 的 `agent` attr 是产出它的 agent catalog id，由 server 的 ReplyWriter 写进
 * Y.XmlElement；user_message 不带归属（发言者就是用户）。
 * id：两个节点都带 `id`，由通用顶层块补齐（block-id.ts 的 ensureBlockIds）。 */

import { $nodeSchema } from '@milkdown/kit/utils'
import type { SerializerState } from '@milkdown/kit/transformer'
import type { Transaction } from '@milkdown/kit/prose/state'
import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as PMNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { motionMs } from '../motion'
import { deleteBlockRange } from './block-delete'

/** 降级标记：整块引用块的首段恰为标记文本时才认（升级见 upgradeMessageBlocks）。
 * agent 行可带 `run=<过程页 id>`：那是这一轮工具调用过程归档出来的页面（见 agents/runs.ts），
 * 不带则块上没有「过程」入口，无 run 的标记必须继续匹配 */
const USER_MARK_RE = /^\[!user\]\s*$/
// 还可带 `stats=<编码>`（回复的结果与用量，见 @ramet/shared/reply-stats）；键值对任意顺序
const AGENT_MARK_RE = /^\[!agent ([^\s\]]+)((?:\s+[a-z]+=[^\s\]]+)*)\]\s*$/

export const userMessageMark = '[!user]'
export const agentReplyMark = (agentId: string, runPageId = '', stats = ''): string =>
  `[!agent ${agentId}${runPageId ? ` run=${runPageId}` : ''}${stats ? ` stats=${stats}` : ''}]`

function markPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.trim().split(/\s+/)) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

/** 共用序列化：引用块 + 首段标记段 + 节点内容（两个消息块的 toMarkdown 只差标记文本） */
function toMarkedQuote(state: SerializerState, node: PMNode, mark: string): void {
  state.openNode('blockquote')
  state.openNode('paragraph')
  state.addNode('text', undefined, mark)
  state.closeNode()
  state.next(node.content)
  state.closeNode()
}

/** 用户消息的调用配置：这条消息要谁来跑、跑在哪个目录、用哪个模型 / 思考程度。
 *  值都放节点 attrs（不是正文文本），不进提示词、不进 markdown；空串表示用页面级默认。
 *  `opts` 是编码串而不是固定 attr：会话配置项的 id 由 agent 给（model / thinking / 更多），
 *  写死 attr 名就把动态集合钉死了。attrs 里禁止放对象（y-prosemirror 走 setAttribute，
 *  对象会被 String() 成 '[object Object]' 永久存进文档）。 */
export type MessageConfig = { agent: string; cwd: string; opts: Record<string, string> }

/** opts 编码：`model=m2;thinking=high`。值里若含 `;` 会被截断，配置值是 agent 给的
 *  短枚举令牌（m1/m2/low/high），够用。 */
export function encodeOpts(opts: Record<string, string>): string {
  return Object.entries(opts)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(';')
}

/** opts 解码；坏片段（无 `=`）跳过，不抛 */
export function decodeOpts(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const key = pair.slice(0, i)
    const value = pair.slice(i + 1)
    if (value) out[key] = value
  }
  return out
}

/** 从节点 attrs 读这条消息的配置（缺失 / 坏值一律回落空串，即页面级默认） */
export function messageConfigOf(node: PMNode): MessageConfig {
  const agent = node.attrs.agent
  const cwd = node.attrs.cwd
  const opts = node.attrs.opts
  return {
    agent: typeof agent === 'string' ? agent : '',
    cwd: typeof cwd === 'string' ? cwd : '',
    opts: typeof opts === 'string' ? decodeOpts(opts) : {},
  }
}

/** 用户消息块节点。Editor / PublicPage 必须 .use（协同对端与公开页 schema 同名同 attrs） */
export const userMessageSchema = $nodeSchema('user_message', () => ({
  content: 'block+',
  group: 'block',
  defining: true, // 与 blockquote 同：输入规则不整块改写，块边界稳定
  // agent/cwd/opts 是这条消息的调用配置（见 MessageConfig），只进 attrs，markdown 不带。
  // author 是发言人的用户 id，对话气泡按它画头像：本端新写的消息由创建处填 selfId()（people.ts）；
  // 老消息 / markdown 导入的为空，显示时回落页面创建者。只进 attrs，不进 markdown / 提示词，服务端不读
  attrs: { id: { default: '' }, agent: { default: '' }, cwd: { default: '' }, opts: { default: '' }, author: { default: '' } },
  // 剪贴板往返：DOM 带块身份 + 调用配置 + 发言人（同 agent_reply 的 data-agent/data-run 口径）
  parseDOM: [
    {
      tag: 'div[data-user-message]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          agent: el.getAttribute('data-agent') ?? '',
          cwd: el.getAttribute('data-cwd') ?? '',
          opts: el.getAttribute('data-opts') ?? '',
          author: el.getAttribute('data-author') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'user-message',
      'data-user-message': '',
      'data-agent': typeof node.attrs.agent === 'string' ? node.attrs.agent : '',
      'data-cwd': typeof node.attrs.cwd === 'string' ? node.attrs.cwd : '',
      'data-opts': typeof node.attrs.opts === 'string' ? node.attrs.opts : '',
      'data-author': typeof node.attrs.author === 'string' ? node.attrs.author : '',
    },
    0,
  ],
  // markdown 解析路径不直接接（同 page_ref 惯例）：降级形态由 upgradeMessageBlocks 升回
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'user_message',
    // 调用配置（agent/cwd/opts）不进 markdown，与 agent_reply 的 run 同口径：
    // 它是运行期元数据，不是正文；源码模式往返丢值是可接受的取舍
    runner: (state, node) => toMarkedQuote(state, node, userMessageMark),
  },
}))

/** AI 回复块节点（同 user_message 形态，另带产出者归属与过程页引用）。Editor / PublicPage 必须 .use */
export const agentReplySchema = $nodeSchema('agent_reply', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  // stats 是回复的生命周期 + 用量（server ReplyWriter 写：建块 `o:run`，收尾覆盖成终态）。
  // plan 是 agent 最后一份计划清单（JSON 串，收尾时写；见 @ramet/shared/run-model 的 encodePlan / plan-card.ts）。
  // team 是带队（/带队）的团队计划与进度（JSON 串，收尾时写；见 @ramet/shared/run-model 的 encodeTeam / team/team-mount.tsx）。
  // 只进 attrs，markdown 不带（同 user_message 的调用配置：源码模式往返丢它是可接受的取舍）
  attrs: { id: { default: '' }, agent: { default: '' }, run: { default: '' }, stats: { default: '' }, plan: { default: '' }, team: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-agent-reply]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          agent: el.getAttribute('data-agent') ?? '',
          run: el.getAttribute('data-run') ?? '',
          stats: el.getAttribute('data-stats') ?? '',
          plan: el.getAttribute('data-plan') ?? '',
          team: el.getAttribute('data-team') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'agent-reply',
      'data-agent-reply': '',
      'data-agent': typeof node.attrs.agent === 'string' ? node.attrs.agent : '',
      'data-run': typeof node.attrs.run === 'string' ? node.attrs.run : '',
      'data-stats': typeof node.attrs.stats === 'string' ? node.attrs.stats : '',
      'data-plan': typeof node.attrs.plan === 'string' ? node.attrs.plan : '',
      'data-team': typeof node.attrs.team === 'string' ? node.attrs.team : '',
    },
    0,
  ],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'agent_reply',
    runner: (state, node) => {
      const str = (v: unknown): string => (typeof v === 'string' ? v : '')
      toMarkedQuote(state, node, agentReplyMark(str(node.attrs.agent), str(node.attrs.run), str(node.attrs.stats)))
    },
  },
}))

/** 标记段文本 → 该块（不是标记段 → null） */
function markOf(
  text: string | null,
): { type: 'user' } | { type: 'agent'; agent: string; run: string; stats: string } | null {
  if (!text) return null
  if (USER_MARK_RE.test(text)) return { type: 'user' }
  const hit = AGENT_MARK_RE.exec(text)
  if (!hit) return null
  const pairs = markPairs(hit[2] ?? '')
  return { type: 'agent', agent: hit[1]!, run: pairs.run ?? '', stats: pairs.stats ?? '' }
}

/** 降级形态 → 消息块（打开页防抖 pass / 源码模式写回的归一化 pass）：
 * 顶层单层引用块且首段恰为标记段时，`[!user]` 升成 user_message，`[!agent <id>]` 升成 agent_reply；
 * 另外带 `agent` 属性的顶层单层引用块（旧数据里 AI 回复就是引用块）也升成 agent_reply。
 * 只认顶层；嵌套引用块是普通引用，不动。幂等：升过的节点不再是引用块。
 * 对 Transaction 原地操作（调用方各自组进单事务，即单个撤销步）。返回是否真的替换了内容。 */
export function upgradeMessageBlocks(tr: Transaction): boolean {
  const schema = tr.doc.type.schema
  const userType = schema.nodes.user_message
  const replyType = schema.nodes.agent_reply
  const paragraph = schema.nodes.paragraph
  if (!userType || !replyType || !paragraph) return false
  const fallback = Fragment.from(paragraph.create())
  const repls: Array<{ pos: number; size: number; node: PMNode }> = []
  tr.doc.forEach((node, offset) => {
    if (node.type.name !== 'blockquote') return
    if (node.firstChild?.type === node.type) return // 嵌套引用块 = 普通引用
    const first = node.firstChild
    const text = first?.type === paragraph && first.childCount === 1 ? first.firstChild?.text : null
    const mark = markOf(text ?? null)
    if (mark) {
      // 标记段整段丢掉；块内容 block+ 不能空 → 空消息补一个空段落
      const body = node.content.cut(first!.nodeSize)
      const content = body.size > 0 ? body : fallback
      repls.push({
        pos: offset,
        size: node.nodeSize,
        node: mark.type === 'user'
          ? userType.create({}, content)
          : replyType.create({ agent: mark.agent, run: mark.run, stats: mark.stats }, content),
      })
      return
    }
    const agent: unknown = node.attrs.agent
    if (typeof agent === 'string' && agent) {
      repls.push({ pos: offset, size: node.nodeSize, node: replyType.create({ agent }, node.content) })
    }
  })
  // 降序替换：后面的 pos 不受前面替换影响
  for (let i = repls.length - 1; i >= 0; i--) {
    const r = repls[i]!
    tr.replaceWith(r.pos, r.pos + r.size, r.node)
  }
  return repls.length > 0
}

/* ---------- 消息块：删除键的口径 ----------
 * 不变量：Backspace / Delete 不许穿过消息块（user_message / agent_reply）的边界。
 * 二者是 `content: block+` 容器（与 blockquote 同形），PM 默认合并命令会穿过边界：
 *   - 光标在块内文本块的文本边界：joinBackward / joinForward 的 findCutBefore / After 会爬到
 *     容器外（ResolvedPos 索引从 depth-1 往上找，容器 depth=1 时 i=0 恰停在块界上）。
 *     相邻块是段落 / 引用 / list 就把消息整条并走；相邻是另一消息块则 join 不成、退到
 *     SelectNode 分支把空文本块删掉，净效果整块消息消失。
 *   - 光标在块内贴边的空段落：默认把空段并出容器（[空段, 正文] 退格会把空段抬成顶层块）
 *     或把相邻顶层块并进来，同样穿块边界。
 *   - 光标停在块内子块间隙（parent 非文本块）：selectNodeBackward / Forward 会把容器块
 *     变成 NodeSelection 或直接删块。
 * 口径：在消息边界处把默认替换为「空内容才消失」，空内容（含贴边空行）按删除消失，
 * 有内容立墙 no-op，逐条分支见 handleMessageDeleteKey。命中条件严格收窄（折叠光标 +
 * 贴本键方向边界 + 涉事块里有消息块），行中退格 / 不涉消息的边界一律放行默认。
 * 手柄 / 框选多选删除走 deleteBlockRange（显式选区即显式整块删意图，不在本键范围），
 * 块菜单「删除」同理。PublicPage 注册只为两处插件表一致（只读视图 view.editable=false
 * 直接放行；view 缺失时不动作，返回 false 落默认）。 */

/** 块内没有用户眼里的内容：无可见文本且无原子节点（图片 / 附件 / 分隔线）。空白文本算空。 */
function isEmptyBlock(node: PMNode): boolean {
  if (node.textContent.trim().length > 0) return false
  let atom = false
  node.descendants((child) => {
    if (child.isLeaf && !child.isText) atom = true
    return !atom
  })
  return !atom
}

/** 光标是否贴在本键方向的边界（dir<0 起边、dir>0 末边），且从光标所在节点到光标所在的
 *  顶层块一路贴边（中间没有兄弟内容挡着）。是则这一步按键可能穿过顶层块的边界。
 *  对文本块：parentOffset 即行首 / 行尾判定；对容器内的结构位（子块间隙）：即内容起 / 终点。
 *  两级都成立才返回 true，块内部（行中、块内段落之间）的编辑走默认。 */
function atBlockEdge($from: ResolvedPos, dir: -1 | 1): boolean {
  if (dir < 0) {
    if ($from.parentOffset !== 0) return false
    for (let d = 1; d < $from.depth; d++) if ($from.index(d) !== 0) return false
    return true
  }
  if ($from.parentOffset !== $from.parent.content.size) return false
  for (let d = 1; d < $from.depth; d++) if ($from.index(d) !== $from.node(d).childCount - 1) return false
  return true
}

function isMessageNode(node: PMNode | null | undefined): boolean {
  return node?.type.name === 'user_message' || node?.type.name === 'agent_reply'
}

/** 第 index 个顶层块起点（前序块 nodeSize 之和） */
function blockStartAt(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return pos
}

/** 消息块边界上的 Backspace/Delete。true = 已处理，false = 放行默认。
 *  有内容不整块删、空内容按删除才消失的落点（本键方向：Backspace 向左，Delete 向右）：
 *   A. 光标坐在消息块内贴边的空段落（消息的直接子段落；写消息时 Enter 留下的空行、首 / 末空行）
 *      只删这一行（段落级删除，消息与其它行原样保留）。不拦的话默认会把它并出容器
 *      （[空段, 正文] 退格会把空段抬出消息成了顶层块）或把相邻顶层块并进来，都穿块边界。
 *   B. 光标所在消息块整体是空的：整块删（空内容按删除消失的主路径）。
 *   C. 本键方向的邻块是空的（含空消息块）：整块删它（空内容消失，且不并进消息容器）。
 *   D. 光标所在块是空的、邻块是消息块：整块删自己（空段落消失，不并穿消息边界）。
 *   E. 其余（涉事两侧都有内容）：墙，吞键 no-op。消息内容永不被并出容器，也不吞邻块。
 *  非块边界光标（行中、消息块内非贴边的段落之间）放行默认，那是消息内部的段落级编辑；
 *  不涉消息的边界（普通段落之间等）同样放行。
 *  嵌套容器内贴边的空段落（如消息里 list 条目的空段）不做段落级删（动它会破坏容器内容
 *  模型），退到 E 立墙（默认会拆消息，宁可 no-op）。 */
function handleMessageDeleteKey(state: EditorState, dir: -1 | 1, view: EditorView | undefined): boolean {
  if (!view || !view.editable) return false
  const { selection } = state
  if (!selection.empty) return false
  const $from = selection.$from
  if ($from.depth < 1 || !atBlockEdge($from, dir)) return false
  const doc = state.doc
  const index = $from.index(0)
  const here = doc.child(index)
  const neighborIndex = dir < 0 ? index - 1 : index + 1
  const neighbor = neighborIndex >= 0 && neighborIndex < doc.childCount ? doc.child(neighborIndex) : null
  if (!isMessageNode(here) && !isMessageNode(neighbor)) return false // 与消息无关：默认
  // A：消息块内贴边的空段落（深度 2 即消息的直接子段落），只删这一行
  if (isMessageNode(here) && !isEmptyBlock(here) && $from.depth === 2 && isEmptyBlock($from.parent)) {
    const at = $from.before(2)
    return deleteBlockRange(view, at, at + $from.parent.nodeSize)
  }
  let targetIndex = index
  let target: PMNode | null = null
  if (isMessageNode(here) && isEmptyBlock(here)) {
    target = here // B：空消息块整块删
  } else if (neighbor && isEmptyBlock(neighbor)) {
    target = neighbor // C：空邻块整块删
    targetIndex = neighborIndex
  } else if (isEmptyBlock(here)) {
    target = here // D：空块整块删
  }
  if (!target) return true // E：墙
  const at = blockStartAt(doc, targetIndex)
  return deleteBlockRange(view, at, at + target.nodeSize)
}

/** 文档模式的消息块删除（Editor / PublicPage 都注册，保持两处一致） */
export const messageDeleteKeymap = $prose(() =>
  keymap({
    Backspace: (state, _dispatch, view) => handleMessageDeleteKey(state, -1, view),
    Delete: (state, _dispatch, view) => handleMessageDeleteKey(state, 1, view),
  }),
)

/* ---------- 消息块入场（只属于「插入」，不属于「在场」） ----------
 * 打开页时文档里已有的 user_message / agent_reply 不播动画（init 把它们记进 seen、fresh 为空）。
 * 之后新出现的 id 才挂 is-new，CSS 播一次 rise。流式往同一条回复里追加文字不换 id，不会重播。
 * Editor 与 PublicPage 都要挂：两处视图都能看见这些块。 */

interface EnterState {
  seen: Set<string>
  fresh: Set<string>
}

function messageIds(doc: PMNode): string[] {
  const ids: string[] = []
  doc.forEach((node) => {
    if (!isMessageNode(node)) return
    const id = node.attrs.id
    if (typeof id === 'string' && id) ids.push(id)
  })
  return ids
}

const messageEnterKey = new PluginKey<EnterState>('messageEnter')

function enterDecorations(doc: PMNode, fresh: Set<string>): DecorationSet {
  if (fresh.size === 0) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.forEach((node, offset) => {
    if (!isMessageNode(node)) return
    const id = node.attrs.id
    if (typeof id !== 'string' || !fresh.has(id)) return
    decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-new' }))
  })
  return DecorationSet.create(doc, decos)
}

export const messageEnterView = $prose(
  () =>
    new Plugin({
      key: messageEnterKey,
      state: {
        init: (_, state) => ({ seen: new Set(messageIds(state.doc)), fresh: new Set<string>() }),
        apply(tr, prev) {
          // 入场播完的块退出 fresh：之后块的 DOM 因内容替换被重建（如 AI 回复收尾）也不再重播入场
          const drain = tr.getMeta(messageEnterKey) as string | undefined
          const drained = drain !== undefined && prev.fresh.has(drain) ? new Set([...prev.fresh].filter((id) => id !== drain)) : null
          const base = drained ? { seen: prev.seen, fresh: drained } : prev
          if (!tr.docChanged) return base
          prev = base
          const ids = messageIds(tr.doc)
          let seen = prev.seen
          let fresh = prev.fresh
          let changed = false
          for (const id of ids) {
            if (seen.has(id)) continue
            if (!changed) {
              seen = new Set(seen)
              fresh = new Set(fresh)
              changed = true
            }
            seen.add(id)
            fresh.add(id)
          }
          return changed ? { seen, fresh } : prev
        },
      },
      props: {
        decorations(state) {
          const st = messageEnterKey.getState(state)
          return st ? enterDecorations(state.doc, st.fresh) : DecorationSet.empty
        },
      },
      view: () => {
        const scheduled = new Set<string>()
        const timers = new Set<number>()
        return {
          update(view) {
            const st = messageEnterKey.getState(view.state)
            if (!st) return
            for (const id of st.fresh) {
              if (scheduled.has(id)) continue
              scheduled.add(id)
              const timer = window.setTimeout(() => {
                timers.delete(timer)
                if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(messageEnterKey, id))
              }, motionMs('--d-3') + 60)
              timers.add(timer)
            }
          },
          destroy() {
            timers.forEach((t) => window.clearTimeout(t))
          },
        }
      },
    }),
)
