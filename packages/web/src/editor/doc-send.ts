/* ---------- 文档模式：两次回车发送一条用户消息（user_message 块） ----------
 * 消息本身只是文档内容，触发 continue 的只有聊天输入卡、斜杠命令和这里（见 chat-view.tsx / agent-bar.tsx）；
 * 在文档里手打 `>> ` 只会得到消息块，没人触发 agent。这里补的是：本端把这条用户消息写完了就 runAgent。
 * 唯一手势是在消息块末尾的空行上按回车：打完字按回车开新行，空行上再按一次就是「说完了」。
 * 这次回车必须拦，不拦的话 PM 会把新段落挤出内层引用块（`bq(bq(p(正文)), p())`），消息形状被拆散，用户也得不到反馈。
 *
 * 为什么只留这一个手势：离开块 / 失焦是推断「写完了」，点一下别处、点标题、切窗口都会命中，
 * 用户刚写完一句话、鼠标移开去看别的东西，agent 就自己跑起来了。发送必须是显式动作。
 * 为什么不比较文本：发送已是显式手势，不需要「这次真的写过字」这条守卫，它会让「删掉回复后再问一次」没反应。
 * 能不能发只看位置：光标在文档最后一条非空用户消息块里，且按在它末尾的空行上。重跑一条旧消息因此是合法的。
 * 为什么必须靠手势而不是块非空：文档模式打字即入档，没有别的信号区分正在写与写完，按内容非空就发会把半句话发给 agent。
 * 为什么只认最后一条用户消息：continue 的增量取文档最后一条用户消息，触发更早的块会发错消息。
 * 为什么只有本端会触发：判定只看本端选区的当下位置，协作者的光标不在你的块里，不会替你发出半句话；
 * 多端同时继续由服务端页面级互斥锁挡（409）。
 * 第二个入口是消息署名行的发送钮（message-chips.tsx），和末尾空行回车共用 `sendLast`，不复制判定；
 * 钮只在草稿（`draftIdOf`：最后一条用户消息且其后没有 AI 回复）上显示。
 * 判定口径见 message-blocks.ts：用户消息是顶层 `user_message` 块（AI 回复是 agent_reply，引用块是引用，不会混进来）。 */

import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { agentStateFor, appendUserMessage, pageAgent, runAgent, setAgentRunError } from './agent-bar'
import { api } from '../api'
import { parseRemember, remember, spaceOfPage } from '../memory/remember'
import { messageConfigOf } from './message-blocks'
import { findBlockIdPos } from './block-id'
import { deleteBlockRange } from './block-delete'
import { draftToComposerText } from './composer-bridge'
import { flyGhost } from '../motion'

const docSendKey = new PluginKey('rametDocSend')

/** 用户消息块的身份和文本 */
interface Msg {
  key: string
  text: string
}

/** 最后一条用户消息和它的块结束位置。位置必须现算：消息块在写的过程中会长，
 * 早先记下的位置到发送时已经指到块里（拿它插段落会把消息正文劈开） */
interface LastMsg extends Msg {
  end: number
  /** 这条消息 attrs 里指定的来源，'' 表示没指定 */
  agent: string
}

/** 顶层块的稳定身份：块 id（补 id 插件保证存在，见 block-id.ts），万一还没补上退回块起点
 * （打字期间块起点不动，够做本端这次访问的身份） */
function blockKey(node: PMNode, pos: number): string {
  const id: unknown = node.attrs.id
  return typeof id === 'string' && id ? id : `pos:${pos}`
}

/** 这个顶层块是用户消息块吗 */
function isUserMessage(node: PMNode): boolean {
  return node.type.name === 'user_message'
}

/** 光标所在的用户消息块（只认顶层，光标在块内任意深度都算），不在块里返回 null */
function visitAt(state: EditorState): Msg | null {
  const $from = state.selection.$from
  if ($from.depth < 1) return null
  const node = $from.node(1)
  return isUserMessage(node) ? { key: blockKey(node, $from.before(1)), text: node.textContent } : null
}

/** 文档里最后一条用户消息块（continue 的增量就是它） */
function lastUserMessage(doc: PMNode): LastMsg | null {
  let hit: LastMsg | null = null
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (isUserMessage(node)) {
      hit = { key: blockKey(node, pos), text: node.textContent, end: pos + node.nodeSize, agent: messageConfigOf(node).agent }
    }
    pos += node.nodeSize
  }
  return hit
}

/** 这次回车能不能发：光标正处在文档最后一条非空用户消息块里。
 *  不比较文本：发送是显式手势（末尾空行两次回车），再要求「必须是这次新写进去的文本」，
 *  坐在一条已发出的消息里连按两次回车就什么都不发（删掉回复想再问一次、或原样重跑一遍）。
 *  只认最后一条：continue 的增量取文档最后一条用户消息，触发更早的块会发错消息。 */
function sendable(state: EditorState): LastMsg | null {
  const here = visitAt(state)
  if (!here) return null
  const last = lastUserMessage(state.doc)
  if (!last || last.key !== here.key) return null
  return last.text.trim().length > 0 ? last : null
}

/** 消息块末尾的空段落对应的删除 tr（末尾不是空段落时 null）。
 *  那是打完字按回车留下的输入痕迹，不属于消息：不清掉它会进文档、进搜索索引、进下一轮的 agent 上下文（多一个空行）。
 *  随发送手势一起清。 */
function trimTrailingBlank(state: EditorState, last: LastMsg): Transaction | null {
  const tr = state.tr
  // last.end 是块的结束位置：块内最后一个子块要到块尾前一位再取父节点才拿得到
  const block = tr.doc.resolve(last.end - 1).node(1)
  if (block.childCount < 2) return null
  const tail = block.child(block.childCount - 1)
  if (tail.type.name !== 'paragraph' || tail.content.size > 0) return null
  return tr.delete(last.end - 1 - tail.nodeSize, last.end - 1)
}

/** 发送最后一条用户消息：末尾空行回车与消息行的发送钮共用这一个执行体，判定不复制。
 *  发完把光标落到消息块后的顶层段落（已有现成空段就用它），别留在消息块里，
 *  留在原处继续打字会追加到已发出的消息上，再按空行回车就成重发。
 *  没有非空的用户消息就什么都不做（返回 false）。 */
export function sendLast(view: EditorView, pageId: string): boolean {
  const last = lastUserMessage(view.state.doc)
  if (!last || last.text.trim().length === 0) return false
  // `/记住 …` 是 Ramet 自己的命令，不发给 agent、不产生运行
  const toRemember = parseRemember(last.text)
  if (toRemember !== null) {
    void rememberDraft(view, pageId, last.key, toRemember)
    return true
  }
  // 去掉末尾空行，光标落到块后
  const tr = trimTrailingBlank(view.state, last) ?? view.state.tr
  const end = tr.mapping.map(last.end)
  const next = tr.doc.resolve(end).nodeAfter
  if (!next || next.type.name !== 'paragraph' || next.content.size > 0) {
    tr.insert(end, view.state.schema.nodes.paragraph!.create(null, null))
  }
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1), 1)))
  // 发给这条消息自己指定的来源（chip 里选的），失效或没指定就回落到本页的来源（pageAgent）
  const agent = pageAgent(pageId, last.agent)
  // 在跑时消息已经在文档里，排一个「这一轮结束后继续」（服务端保存，见 send-queue.ts），不撞 409
  if (agentStateFor(pageId).status === 'running') {
    void api.enqueue(pageId, { agent, kind: 'continue' }).catch((err: unknown) => {
      setAgentRunError(err instanceof Error ? `排队失败：${err.message}` : '排队失败')
    })
    return true
  }
  runAgent(pageId, agent)
  return true
}

/** 文档模式的 `>> /记住 …` 草稿：记下了就把这条草稿从文档里删掉（它不是给 agent 的消息，留着会进之后每一轮的上下文），
 *  没记下（只读 / 超限 / 空内容）草稿原样留着，原因走运行错误条 */
async function rememberDraft(view: EditorView, pageId: string, key: string, content: string): Promise<void> {
  const res = await remember(spaceOfPage(pageId), content)
  if (!res.ok) {
    setAgentRunError(res.message)
    return
  }
  setAgentRunError(null)
  if (view.isDestroyed) return
  const pos = findBlockIdPos(view.state.doc, key)
  const node = pos === null ? null : view.state.doc.nodeAt(pos)
  if (pos !== null && node) deleteBlockRange(view, pos, pos + node.nodeSize)
}

/** 草稿是文档最后一条用户消息，且它之后没有任何 AI 回复，即还没发出去的那条。
 *  返回块 id，没有草稿返回 null。消息行据此常显发送钮，已发出的消息只在悬停时才露出控件 */
export function draftIdOf(doc: PMNode): string | null {
  let id: string | null = null
  doc.forEach((node) => {
    if (isUserMessage(node)) id = typeof node.attrs.id === 'string' && node.attrs.id ? node.attrs.id : null
    else if (node.type.name === 'agent_reply') id = null
  })
  return id
}

/** 在文档末尾起一条新的用户消息草稿（正文是 text），光标落到它的末尾等用户继续写。
 *  斜杠菜单里带参数的 agent 命令走这里：参数和普通消息同一条输入路径（IME / 引用 / 多行都正常），
 *  用户补完参数后，由发送钮或末尾空行回车发出去。 */
export function startMessageDraft(view: EditorView, text: string, agent?: string): void {
  appendUserMessage(view, text, agent)
  const last = lastUserMessage(view.state.doc)
  if (!last) return
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(last.end - 1), -1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 文档到对话：把正在写的那条消息（草稿）的字取走并从文档里删掉，对话视图里它是输入框里的字，
 *  不该再留一个没发出去的气泡。没有草稿返回 ''（草稿的定义见 draftIdOf） */
export function takeDraftText(view: EditorView): string {
  const id = draftIdOf(view.state.doc)
  const pos = id ? findBlockIdPos(view.state.doc, id) : null
  const node = pos === null ? null : view.state.doc.nodeAt(pos)
  if (pos === null || !node) return ''
  const text = draftToComposerText(node)
  deleteBlockRange(view, pos, pos + node.nodeSize)
  return text
}

export type QuoteRef = { pageId: string; blockId: string; text: string }

/** 把一个块引用放进正在写的那条消息（没有草稿就新建一条），光标落在引用之后，返回引用胶囊的位置（没放成返回 null）。
 *  过程页步骤的「引用」走这里（跨页，见 quote-queue.ts），选区菜单 / 块菜单 / 抬头行的「引用」经 quoteWithFly 共用这一个落点。 */
export function quoteIntoDraft(view: EditorView, ref: QuoteRef): number | null {
  const chip = view.state.schema.nodes.block_ref
  if (!chip) return null
  if (draftIdOf(view.state.doc) === null) appendUserMessage(view, '')
  const last = lastUserMessage(view.state.doc)
  if (!last) return null
  const at = TextSelection.near(view.state.doc.resolve(last.end - 1), -1)
  const tr = view.state.tr.setSelection(at).replaceSelectionWith(chip.create(ref), false).insertText(' ')
  view.dispatch(tr.scrollIntoView())
  view.focus()
  const pos = view.state.selection.from - 2 // 光标在「胶囊 + 空格」之后
  return pos >= 0 && view.state.doc.nodeAt(pos)?.type === chip ? pos : null
}

/** 引用飞行的标签：引用文字的前一小段 */
export function quoteLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 28)
}

/** 文档模式的「引用」加飞行：小胶囊从 from（点的按钮）飞到草稿里新出现的引用胶囊，落地时真胶囊再显现 */
export function quoteWithFly(view: EditorView, ref: QuoteRef, from: DOMRect | null): void {
  const pos = quoteIntoDraft(view, ref)
  if (pos === null || !from) return
  const dom = view.nodeDOM(pos)
  if (dom instanceof HTMLElement) flyGhost(from, dom, quoteLabel(ref.text), { reveal: true })
}

/** 文档模式「两次回车发送」：enabled 表示有写权（viewer 不挂） */
export function docSendView(opts: { pageId: string; enabled: boolean }) {
  return $prose(() => {
    // 无状态：能不能发完全由当下选区和文档决定
    return new Plugin({
      key: docSendKey,
      props: {
        // 只有末尾空行上的回车这一个发送手势，离开块、失焦（点侧栏 / 工具栏 / 切窗口）什么都不做
        handleKeyDown: (view, event) => {
          if (!opts.enabled || event.isComposing) return false
          if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
          const $from = view.state.selection.$from
          // 只在块内末尾的空行上发：非空行回车是开新行，空行之后块内还有内容说明是消息中间的空行
          if ($from.parent.content.size !== 0) return false
          for (let d = 1; d < $from.depth; d++) {
            if ($from.indexAfter(d) !== $from.node(d).childCount) return false
          }
          if (!sendable(view.state)) return false
          return sendLast(view, opts.pageId)
        },
      },
    })
  })
}
