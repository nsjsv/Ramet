/* ---------- 对话视图里的任务通知卡 / 定时通知卡 ----------
 * Genet 派出去的任务做完时服务端写的通知（带 notice 属性的 user_message，见 message-blocks.ts；服务端 agents/task-watch.ts）。
 * 它占着用户消息的位置，但不是谁说的话：不画成用户气泡、没有头像和轻操作。第一段是抬头（任务链接 + 结局 + agent + 用时；
 * 不在 .chat-bubble 里，task-status.ts 不给这里的链接挂实时状态标，抬头已经写了结局），其余是原因与任务最后的回复，
 * 超过几行就折叠（渐隐 + 展开 / 收起）。
 * 定时器到点写的定时通知（notice = timer，服务端 triggers/notice.ts）同一张卡：时钟图标，抬头是定时器名字与时间表，正文是指令原文。
 * 别的规则写的事件通知（notice = event）也是这张卡：闪电图标，抬头是规则名与来由，正文先是规则的指令，再是页面、改动、事件带来的文字（引用）。
 * 触发者不是主人（external = '1'）时抬头带「外来」小标，引用画成外来内容的样式：那是别人写的，只当资料。
 * 用户在评论里 @Genet 写的评论呼叫（notice = comment，服务端 comments/genet-call.ts）也是这张卡：评论图标，抬头「你在《…》的评论里叫了 Genet」，
 * 正文是页面、你的要求、整串评论（引用）；串里有别人的评论时同样带「外来」小标。
 * 展开过的按块 id 记在调用方给的 Set 里：文档一变气泡就重建，不记的话每来一个字就收回去。 */
import type { DOMSerializer, Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { COPY } from '../copy'
import { iconSvg, type IconName } from '../icons'
import { hydrateRich } from './rich-render'

export function isNotice(node: ProsemirrorNode): boolean {
  return node.type.name === 'user_message' && typeof node.attrs.notice === 'string' && node.attrs.notice !== ''
}

export function buildNoticeCard(
  node: ProsemirrorNode,
  railId: number,
  serializer: DOMSerializer,
  /** 视图打开之后新出现的才播入场动画（同 chat-view 的气泡） */
  enter: Set<string>,
  isOpen: () => boolean,
  expanded: Set<string>,
): () => HTMLElement {
  return () => {
    const dom = document.createElement('div')
    dom.className = 'chat-msg chat-notice'
    dom.dataset.rail = String(railId)
    const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    if (id) dom.dataset.blk = id
    if (id && !enter.has(id)) {
      enter.add(id)
      if (isOpen()) dom.classList.add('is-new')
    }
    const kind = node.attrs.notice
    const external = (kind === 'event' || kind === 'comment') && node.attrs.external === '1'
    const card = document.createElement('div')
    card.className = `notice-card${KIND_CLASS[String(kind)] ?? ''}${external ? ' is-external' : ''}`
    const head = document.createElement('div')
    head.className = 'notice-head'
    const icon = document.createElement('span')
    icon.className = 'notice-icon'
    icon.innerHTML = iconSvg(KIND_ICON[String(kind)] ?? 'check', 14)
    head.append(icon)
    const body = document.createElement('div')
    body.className = 'notice-body'
    const parts: Node[] = []
    let instructionAt = -1
    node.content.forEach((child, _off, i) => {
      const el = serializer.serializeNode(child)
      if (el instanceof HTMLElement) el.dataset.part = String(i)
      if (i === 0) head.append(el)
      else {
        if (kind === 'event' && instructionAt < 0 && child.textContent.startsWith(INSTRUCTION_HEAD)) instructionAt = parts.length
        parts.push(el)
      }
    })
    // 事件通知：规则的指令排在文档最后（提示词里主人的话压在外来内容后面），卡片上挪到抬头下面，折起来时也看得到要做什么
    body.append(...(instructionAt < 0 ? parts : [...parts.slice(instructionAt), ...parts.slice(0, instructionAt)]))
    if (external) head.append(externalTag())
    card.append(head)
    if (body.childNodes.length > 0) {
      hydrateRich(body)
      card.append(body, foldToggle(body, id, expanded))
    }
    dom.append(card)
    return dom
  }
}

/** 事件通知里规则指令那一段的开头（服务端 triggers/notice.ts 的 eventNoticeElement 写的） */
const INSTRUCTION_HEAD = '规则的指令：'

const KIND_CLASS: Record<string, string> = { failed: ' is-failed', timer: ' is-timer', event: ' is-event', comment: ' is-event' }
const KIND_ICON: Record<string, IconName> = { failed: 'x', timer: 'clock', event: 'bolt', comment: 'comment' }

function externalTag(): HTMLElement {
  const tag = document.createElement('span')
  tag.className = 'notice-tag'
  tag.textContent = COPY.assistant.notice.external
  tag.dataset.tip = COPY.assistant.notice.externalTip
  return tag
}

/** 折叠：先按收起画，挂上之后量一下没超高就把按钮和渐隐都去掉 */
function foldToggle(body: HTMLElement, id: string, expanded: Set<string>): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'notice-fold'
  const paint = (): void => {
    const open = expanded.has(id)
    body.classList.toggle('is-folded', !open)
    btn.textContent = open ? COPY.assistant.notice.collapse : COPY.assistant.notice.expand
  }
  btn.addEventListener('click', () => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    paint()
  })
  paint()
  requestAnimationFrame(() => {
    if (expanded.has(id) || body.scrollHeight > body.clientHeight + 1) return
    body.classList.remove('is-folded')
    btn.hidden = true
  })
  return btn
}

/** 消息是不是自动化发的：定时器（timer）/ 别的规则（rule）以主人身份写在目标页上的指令消息（没有 notice）。文档模式的署名行也用它 */
export function sentBy(node: ProsemirrorNode): 'timer' | 'rule' | null {
  if (isNotice(node)) return null
  if (typeof node.attrs.timer === 'string' && node.attrs.timer) return 'timer'
  if (typeof node.attrs.rule === 'string' && node.attrs.rule) return 'rule'
  return null
}

/** 自动化发出的消息：气泡顶上的「定时」/「自动化」小标。消息里只记了定时器 / 规则 id，名字拿不到，悬停只说明来历 */
export function autoTag(node: ProsemirrorNode): HTMLElement | null {
  const by = sentBy(node)
  if (!by) return null
  const copy = by === 'timer' ? COPY.ai.timers : COPY.ai.automations
  const tag = document.createElement('div')
  tag.className = 'chat-timer-tag'
  tag.dataset.tip = copy.sentTip
  tag.innerHTML = iconSvg(by === 'timer' ? 'clock' : 'bolt', 12)
  tag.append(copy.sentTag)
  return tag
}
