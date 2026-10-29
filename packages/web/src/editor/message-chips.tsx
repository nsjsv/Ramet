/* ---------- 用户消息的署名行：「你 → agent」+ 调用配置 chip + 发送钮 ----------
 * 署名行是消息块的块首 widget。草稿（文档最后一条、其后没有回复）常显 chip 与发送钮；
 * 已发出的消息只露出署名，chip 悬停 / 焦点进入才展开（CSS）。草稿与否由节点装饰 `is-draft` 给，CSS 决定显隐，
 * 这里不维护显隐状态。
 *
 * 一条用户消息自己的调用配置：谁来跑（agent）、跑在哪个目录（cwd）、用哪个模型 / 思考（opts）。
 * 值只存在消息节点 attrs（见 message-blocks.ts 的 MessageConfig），不是正文文本，
 * 所以不进提示词、不进 markdown；空值表示用页面级默认。
 *
 * 控件本身是 ChipBar（chip-bar.tsx，与聊天输入卡同一个组件）；本文件只做文档宿主的薄壳：
 * 给顶层 user_message 挂一个 widget、里面 createRoot 一个 MessageChips，把 attrs 读出来喂给
 * ChipBar，把 ChipBar 的改动写回 attrs。写值一律走 setNodeMarkup 单事务，进 Yjs attrs，协作同步、可撤销。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose, $view } from '@milkdown/kit/utils'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { COPY } from '../copy'
import { useAgents } from '../default-agent'
import { Icon } from '../icons'
import { setAgentRunError, useAgentEvents, usePageAgent } from './agent-bar'
import { api } from '../api'
import { selfId } from '../people'
import { askAgent, writeSessionOption } from './agent-controls'
import { ChipBar } from './chip-bar'
import { ModeHint } from './mode-hint'
import { draftIdOf, sendLast } from './doc-send'
import { encodeOpts, messageConfigOf, userMessageSchema, type MessageConfig } from './message-blocks'

export interface ChipPatch {
  agent?: string
  cwd?: string
  opts?: Record<string, string>
  /** true = 整组清空（换 agent 时用：旧 agent 的 config id 对新 agent 无意义） */
  clearOpts?: boolean
}

/* 已收敛过的失效 (块 id, 失效值)：避免每次渲染都重复派发。
 * 收敛是幂等的：attrs 改成可用值后 stale 不再成立，后续不会再进来。 */
const repaired = new Set<string>()

/** 把「attrs 指定了一个不在目录里的 agent」收敛成实际会用的 agent。
 *  为什么必须收敛：服务端按 attrs 解析执行目标，失效 id 一律 400（消息永远发不出去），
 *  而界面显示的是回落后的值，显示的和实际会跑的不是同一个。收敛后两者一致，
 *  且用户能在菜单里正常改成别的 agent（原来那个失效 id 是选项里删不掉的幽灵）。
 *  幂等，且不在渲染中派发（微任务里做，PM 的 update 循环内禁止 dispatch）。 */
function repairStaleAgent(view: EditorView, blockId: string, stale: string, fallback: string): void {
  const key = `${blockId}|${stale}`
  if (repaired.has(key)) return
  repaired.add(key)
  queueMicrotask(() => {
    if (view.isDestroyed) return
    const p = posOfMessage(view, blockId)
    if (p == null) return
    const node = view.state.doc.nodeAt(p)
    // 期间可能已被改掉 / 删掉：只在仍是那个失效值时收敛
    if (!node || node.type.name !== 'user_message' || node.attrs.agent !== stale) return
    writeMsgConfig(view, p, { agent: fallback, clearOpts: true })
    // 失效来源已被修掉，把由它引起的「准备 agent ... 失败」清掉，
    // 否则页面修好了、错误条还挂着一条用户无从处理的旧提示
    setAgentRunError(null)
  })
}

/** 消息在文档里的位置：按块 id 找（id 由 ensureBlockIds 保证存在，跨重建稳定）。
 *  不用 widget 的 getPos 反推，装饰位置随文档漂移；也不用 nodeSize 反推，消息长度会变。 */
export function posOfMessage(view: EditorView, id: string): number | null {
  if (!id) return null
  let found: number | null = null
  view.state.doc.forEach((node, offset) => {
    if (node.type.name === 'user_message' && node.attrs.id === id) found = offset
  })
  return found
}

/** 写进消息节点 attrs */
export function writeMsgConfig(view: EditorView, pos: number, patch: ChipPatch): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'user_message') return
  const cfg = messageConfigOf(node)
  const next = {
    ...node.attrs,
    ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    ...(patch.clearOpts ? { opts: '' } : {}),
    ...(!patch.clearOpts && patch.opts !== undefined ? { opts: encodeOpts({ ...cfg.opts, ...patch.opts }) } : {}),
  }
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, next))
}

/** 块 id → 重画 chip。节点 attrs 变了由 nodeView 调用，不靠拆掉 widget */
const chipRefreshers = new Map<string, () => void>()

function attrText(node: PMNode, name: string): string {
  const value = node.attrs[name]
  return typeof value === 'string' ? value : ''
}

function isBlank(node: PMNode): boolean {
  return node.textContent.trim().length === 0
}

function applyMessageDom(dom: HTMLElement, node: PMNode): void {
  dom.setAttribute('data-agent', attrText(node, 'agent'))
  dom.setAttribute('data-cwd', attrText(node, 'cwd'))
  dom.setAttribute('data-opts', attrText(node, 'opts'))
}

/** 调用配置（agent/cwd/opts）不是正文。默认视图把 attrs 算进 sameMarkup，
 *  一切换来源就拆掉整块 DOM 再造，光标和焦点一起没。这里原地改 data-*，contentDOM 不动。 */
export const userMessageView = $view(userMessageSchema.node, () => {
  return (node: PMNode) => {
    const dom = document.createElement('div')
    dom.className = 'user-message'
    dom.setAttribute('data-user-message', '')
    applyMessageDom(dom, node)
    let current = node
    return {
      dom,
      contentDOM: dom,
      update(next: PMNode) {
        if (next.type !== current.type) return false
        // 署名行要重画的变化：调用配置、发送钮的可用性（正文空与非空切换）
        const changed =
          attrText(current, 'agent') !== attrText(next, 'agent') ||
          attrText(current, 'cwd') !== attrText(next, 'cwd') ||
          attrText(current, 'opts') !== attrText(next, 'opts') ||
          isBlank(current) !== isBlank(next)
        applyMessageDom(dom, next)
        current = next
        // 等这次视图更新结束再重画 chip，避免画在 PM 还在改子节点的半路上
        if (changed) {
          const id = attrText(next, 'id')
          queueMicrotask(() => chipRefreshers.get(id)?.())
        }
        return true
      },
      ignoreMutation(mutation: { type: string; target: Node }) {
        return mutation.type === 'attributes' && mutation.target === dom
      },
    }
  }
})

interface MessageHeadProps {
  pageId: string
  view: EditorView
  blockId: string
  cfg: MessageConfig
  /** 正文是空的：发送钮不可点 */
  blank: boolean
}

const QUEUED_LABEL = '排队中 · 取消'
const QUEUED_TIP = '这一轮结束后继续发给 agent；点一下取消排队'

/** 署名行的文档宿主：attrs → props，props 的改动 → attrs */
function MessageHead({ pageId, view, blockId, cfg, blank }: MessageHeadProps) {
  const { agents, loaded } = useAgents()
  // 解析规则与别处同一所有者（pageAgent）：消息 attrs 指定且仍在目录里才用它，否则依次回落本页的来源、
  // 全局默认、目录第一个。不要直接用 getDefaultAgent()，那会把「已被撤销的 connector agent」这类失效 id
  // 当成活值，界面卡死在它上面并且反复 prepare
  const { agent, ready } = usePageAgent(pageId, cfg.agent)
  const label = agents.find((a) => a.id === agent)?.label?.trim() || agent
  // 在跑时发过的草稿，我排着一个「这一轮结束后继续」
  const { queue } = useAgentEvents(pageId)
  const queued = queue.items.find((q) => q.kind === 'continue' && q.userId === selfId())

  useEffect(() => {
    // 目录还没到手时不能判失效（pickAgent([]) = ''，会把好好的值清掉）
    if (loaded && agents.length > 0 && cfg.agent && cfg.agent !== agent) repairStaleAgent(view, blockId, cfg.agent, agent)
    // 这条消息指定的 agent 也要问过 —— 页面默认不等于消息指定的那个。回落到本页来源的要等它到了再问
    if (ready || agent === cfg.agent) askAgent(pageId, agent)
  }, [pageId, view, blockId, loaded, agents, cfg.agent, agent, ready])

  const write = (patch: ChipPatch) => {
    const p = posOfMessage(view, blockId)
    if (p != null) writeMsgConfig(view, p, patch)
  }

  return (
    <>
      <span className="msg-who">{label ? COPY.msg.youTo(label) : COPY.msg.you}</span>
      <ChipBar
        pageId={pageId}
        agent={agent}
        cwd={cfg.cwd}
        opts={cfg.opts}
        size="inline"
        onAgent={(id) => {
          write({ agent: id })
          // 换来源必须立刻预备新 agent 的会话：不预备就没有它的 config 事件，
          // chip 上的模型 / 思考还停在旧来源的值
          askAgent(pageId, id)
        }}
        onCwd={(cwd) => {
          write({ cwd })
          return Promise.resolve()
        }}
        onOpt={(configId, value) => write({ opts: { [configId]: value } })}
        // 权限模式不写消息 attrs（服务端不认消息级的 mode）：走会话配置通道，和对话输入卡、⇧Tab 同一个出口
        onMode={(configId, value) => void writeSessionOption(pageId, agent, configId, value)}
      />
      {queued ? (
        // 在跑时发过，这条草稿排着「这一轮结束后继续」（服务端 send-queue.ts）；点了撤掉排队
        <button
          type="button"
          className="msg-queued"
          title={QUEUED_TIP}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void api.withdrawQueued(pageId, queued.id).catch(() => undefined)}
        >
          <Icon name="clock" size={12} />
          {QUEUED_LABEL}
        </button>
      ) : (
        <button
          type="button"
          className="msg-send"
          aria-label={COPY.chips.send}
          title={COPY.chips.send}
          disabled={blank}
          // 别把编辑器焦点抢走；发送本身走与「末尾空行回车」同一个 sendLast
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => sendLast(view, pageId)}
        >
          <Icon name="arrow-up" size={12} />
        </button>
      )}
    </>
  )
}

/** widget 元素 + 它的 React root；destroy 时卸载 */
type ChipHost = HTMLElement & { __root?: Root; __render?: () => void }

/** 草稿的权限模式提示行：自己解析这条草稿会发给谁（消息 chip 指定的来源 → 本页来源 → 默认），离开默认档才有内容 */
function ModeHintHost({ pageId, preferred }: { pageId: string; preferred: string }) {
  const { agent } = usePageAgent(pageId, preferred)
  return <ModeHint pageId={pageId} agent={agent} />
}

function buildModeHint(pageId: string, preferred: string): HTMLElement {
  const host: ChipHost = document.createElement('div')
  host.className = 'msg-mode-hint'
  host.contentEditable = 'false'
  const root = createRoot(host)
  host.__root = root
  root.render(<ModeHintHost pageId={pageId} preferred={preferred} />)
  return host
}

/** 文档模式：给顶层 user_message 挂署名行（块首 widget 装饰）+ 给草稿打 `is-draft`（节点装饰）。
 *  聊天模式不挂：输入卡已经有同一排控件。显隐在 CSS（草稿常显；其余悬浮 / 焦点）。
 *  acts = 署名行末尾的操作行（doc-acts.ts；草稿由 CSS 藏起来）。React 只管 .msg-head-main，操作行是它的兄弟 */
export function messageChipsView(pageId: string, acts: ((node: PMNode) => HTMLElement | null) | null = null) {
  return $prose(() => new Plugin({
    key: new PluginKey('msgChips'),
    props: {
      decorations(state) {
        const decos: Decoration[] = []
        const draftId = draftIdOf(state.doc)
        state.doc.forEach((node, offset) => {
          if (node.type.name !== 'user_message') return
          // 挂在块内开头（offset 是块前的顶层缝，widget 会变成块的兄弟，跟消息脱钩）
          const start = offset + 1
          const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
          if (id && id === draftId) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-draft' }))
          decos.push(
            Decoration.widget(
              start,
              (view) => {
                const host: ChipHost = document.createElement('div')
                host.className = 'msg-head'
                host.contentEditable = 'false'
                const main = document.createElement('span')
                main.className = 'msg-head-main'
                host.append(main)
                const row = acts?.(node)
                if (row) host.append(row)
                const root = createRoot(main)
                host.__root = root
                const blockId = id || String(start)
                const render = () => {
                  const p = posOfMessage(view, id)
                  const current = p == null ? null : view.state.doc.nodeAt(p)
                  const cfg = current && current.type.name === 'user_message' ? messageConfigOf(current) : messageConfigOf(node)
                  const blank = current ? isBlank(current) : isBlank(node)
                  root.render(<MessageHead pageId={pageId} view={view} blockId={blockId} cfg={cfg} blank={blank} />)
                }
                render()
                if (id) chipRefreshers.set(id, render)
                host.__render = render
                return host
              },
              {
                side: -1,
                // 点芯片是在改这条消息的配置，不是在编辑正文
                stopEvent: () => true,
                // key 只认块身份。agent/cwd/opts 变了若换 key，PM 会拆掉 widget 再造，
                // 焦点一起没。配置变化由 userMessageView 通知这块 chip 原地重画。
                // 文本不进 key：在消息里打字不重建署名行（正文空 ↔ 非空由 userMessageView 通知原地重画）。
                key: `mc:${id || start}`,
                destroy: (dom) => {
                  const host = dom as ChipHost
                  // 新旧 widget 同 id 交接时，旧的 destroy 不能把新的注册摘掉
                  if (id && chipRefreshers.get(id) === host.__render) chipRefreshers.delete(id)
                  // destroy 可能发生在 React 渲染途中（PM 更新在 effect 里触发），异步卸载避免 React 报同步卸载警告
                  const root = host.__root
                  if (root) queueMicrotask(() => root.unmount())
                },
              },
            ),
          )
          // 权限模式提示行：只给草稿（还没发出去的那条），紧跟署名行之后；key 含来源，换来源重建
          if (id && id === draftId) {
            const preferred = attrText(node, 'agent')
            decos.push(
              Decoration.widget(start, () => buildModeHint(pageId, preferred), {
                side: -1,
                stopEvent: () => true,
                ignoreSelection: true,
                key: `mh:${id}:${preferred}`,
                destroy: (dom) => {
                  const root = (dom as ChipHost).__root
                  if (root) queueMicrotask(() => root.unmount())
                },
              }),
            )
          }
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
  }))
}
