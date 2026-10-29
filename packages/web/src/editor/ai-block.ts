// ---------- agent_reply 顶栏：agent 归属 → icon + 名字 ----------
// 节点本身（user_message / agent_reply 的 schema 与 markdown 归一化）在 message-blocks.ts，本文只管顶栏怎么显示。
// 归属：agent_reply 的 `agent` 节点属性是产出它的 agent catalog id，由 server 的 ReplyWriter
// 写进 Y.XmlElement（与块 id 同机制，只进节点 attrs，DOM / 剪贴板都不带）。
// 渲染：优先用部署方在该 agent 配置里写的 `logo` 文本（emoji 等，显式配置优先于推断），
// 否则按 id / label 认厂商用内置品牌 mark（agent-marks.tsx），都认不出用通用星标；名字取同一 agent 的 label。
// 都查不到（agent 被摘、connector 离线）时 icon 与名字一起回落当前默认 agent。

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { agentBadge, agentName } from './agent-badge'
export { agentBadge, agentName } from './agent-badge'
import { chainRestAfter } from './chain-state'
import { createDocFollow } from './doc-follow'
import { LiveSlot } from './live-slot'
import { decodeStats } from '@ramet/shared/reply-stats'
import { decodePlan, decodeTeam } from '@ramet/shared/run-model'
import { buildDock } from '../hud/dock'
import { buildPlanStrip } from './plan-card'
import { buildTeamStrip, disposeTeamStrips } from '../team/team-mount'
import { buildFailStrip, failText, isFailedReply } from './reply-fail'
import { ensureAgentsLoaded, subscribeAgentList, subscribeDefaultAgent } from '../default-agent'

const logoListeners = new Set<() => void>()
let wired = false

function notifyLogo(): void {
  logoListeners.forEach((l) => l())
}

/** 目录 / 默认 agent 变化时重算装饰（派发空事务触发 update，装饰由各插件的 plugin state 重算）。
 * 两个事实源的模块级订阅在首个消费者出现时接上。 */
export function watchAgentLogo(view: EditorView): () => void {
  if (!wired) {
    wired = true
    subscribeAgentList(notifyLogo)
    subscribeDefaultAgent(notifyLogo)
  }
  const cb = () => {
    if (!view.isDestroyed) view.dispatch(view.state.tr)
  }
  logoListeners.add(cb)
  return () => {
    logoListeners.delete(cb)
  }
}

/** AI 回复块挂顶栏属性：文本 logo 走 data-agent-logo（CSS 直接当 content），品牌 mark 走
 *  data-agent-mark + --agent-mark（CSS 用掩膜图，见 styles/agent-marks.css），名字走
 *  data-agent-name（CSS ::after 的 content）。
 * 三套属性都要写（用不到的置空）：装饰整棵重算，PM 不会摘掉上一轮挂的旧属性，
 * 否则换 agent 时会留着上一个 icon / 名字。 */
function agentReplyDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.forEach((node, offset) => {
    if (node.type.name !== 'agent_reply') return
    const agentId: unknown = node.attrs.agent
    const id = typeof agentId === 'string' ? agentId : ''
    const badge = agentBadge(id)
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        'data-agent-mark': badge.kind === 'mark' ? badge.key : '',
        'data-agent-logo': badge.kind === 'text' ? badge.text : '',
        'data-agent-name': agentName(id),
        style: badge.kind === 'mark' ? `--agent-mark: var(--mark-${badge.key})` : '',
      }),
    )
  })
  return DecorationSet.create(doc, decos)
}

const agentReplyKey = new PluginKey<DecorationSet>('agentReplyHead')

// ---------- 回复抬头行（文档 / 对话两种模式同一套，样式在 chat.css 的 .reply-head） ----------
// 图标 + 名字靠左；右端 .reply-end 是悬停才出现的操作行（doc-acts.ts / chat-acts.ts）+ 停靠的岛（hud/dock.ts）。
// 两种模式结构相同，文档 / 对话切换时整行平移（view-morph.ts 按「块 id@head」配对）。
export function buildReplyHead(agentId: string, end: Array<HTMLElement | null>): HTMLElement {
  const badge = agentBadge(agentId)
  const head = document.createElement('div')
  head.className = 'reply-head'
  const logo = document.createElement('span')
  logo.className = badge.kind === 'mark' ? 'reply-logo is-mark' : 'reply-logo'
  const glyph = document.createElement('span')
  if (badge.kind === 'mark') {
    glyph.className = 'agent-mark'
    glyph.style.setProperty('--agent-mark', `var(--mark-${badge.key})`)
  } else glyph.textContent = badge.text
  logo.append(glyph)
  const name = document.createElement('span')
  name.className = 'reply-name'
  name.textContent = agentName(agentId)
  const tail = document.createElement('span')
  tail.className = 'reply-end'
  for (const el of end) if (el) tail.append(el)
  head.append(logo, name, tail)
  return head
}

// 文档模式：抬头行挂在块首 widget 上（绝对定位到块顶部留白，不占正文流）。正在跑的回复（o:run）不出操作行。
// 公开页不装这个插件（仍用伪元素画顶栏，见 prose.css）。操作行不随正文改动重建（动作执行时按块 id 现查节点），
// key 只认块身份、标签内容、图标与名字（agent 目录到了或换了要重画）。

type HeadActs = (node: PMNode) => HTMLElement | null

function replyChipDecorations(doc: PMNode, pageId: string, acts: HeadActs | null): DecorationSet {
  const decos: Decoration[] = []
  doc.forEach((node, offset) => {
    if (node.type.name !== 'agent_reply') return
    const { stats, run, id, agent, plan } = node.attrs as { stats?: unknown; run?: unknown; id?: unknown; agent?: unknown; plan?: unknown }
    const agentId = typeof agent === 'string' ? agent : ''
    const withActs = Boolean(acts) && decodeStats(stats).o !== 'run'
    const badge = agentBadge(agentId)
    const look = `${badge.kind === 'mark' ? badge.key : badge.text}:${agentName(agentId)}`
    decos.push(
      Decoration.widget(
        offset + 1,
        () =>
          buildReplyHead(agentId, [
            withActs && acts ? acts(node) : null,
            buildDock({ id, agent, stats, plan, run }, pageId),
          ]),
        {
          side: -1,
          key: `head:${String(id)}:${String(stats)}:${String(run)}:${String(plan)}:${withActs}:${look}`,
          // 事件交给标签 / 按钮自己，PM 不管这块 DOM，否则点一下会顺手动选区 / 光标
          stopEvent: () => true,
          ignoreSelection: true,
        },
      ),
    )
  })
  return DecorationSet.create(doc, decos)
}

const replyChipKey = new PluginKey<DecorationSet>('agentReplyChip')

/** 文档模式：AI 回复块抬头右端（停靠的岛，hud/dock.ts，点开右上角工作台；acts 是抬头操作行，viewer 也有复制） */
export function replyChipView(pageId: string, acts: HeadActs | null = null) {
  return $prose(
    () =>
      new Plugin({
        key: replyChipKey,
        props: { decorations: (state) => replyChipDecorations(state.doc, pageId, acts) },
      }),
  )
}

/** 文档模式：AI 回复块顶栏装饰。loadAgents 表示这个实例可以拉 agent 目录
 * （公开页是匿名访客，api 层遇 401 会跳登录，所以那边不拉） */
export function aiBlockView(opts: { loadAgents: boolean }) {
  return $prose(() => {
    if (opts.loadAgents) ensureAgentsLoaded()
    return new Plugin({
      key: agentReplyKey,
      props: { decorations: (state) => agentReplyDecorations(state.doc) },
      view: (view) => ({ destroy: watchAgentLogo(view) }),
    })
  })
}

// ---------- 运行中的回复（文档模式） ----------
// 正在跑的那条回复由实时视图接管（live-slot.ts 判定、live-reply.ts 画）：块首依次放运行条与实时正文
// （抬头之下、正文之上），占位段落隐藏、块不可编辑（`is-live`）。收尾事务到达后真内容在原位渲染，
// 运行条收回、用量标签就位再摘掉（run-land.ts）。块由 run.replyId 指名，不猜最后一条。
// 失败收尾（o:error）的块挂失败条（reply-fail.ts，含重试）。agent 报过计划清单的块，收尾后在同一位置挂计划卡（plan-card.ts）：
// 运行条收尾时只收掉胶囊 / 托盘、把计划卡留在原位，随后由块上的 plan 属性接手，所以交接处不闪不跳。

const liveKey = new PluginKey<DecorationSet>('agentLiveReply')

function replyPos(doc: PMNode, id: string): number {
  let at = -1
  doc.forEach((node, offset) => {
    if (node.type.name === 'agent_reply' && node.attrs.id === id) at = offset
  })
  return at
}

export function liveReplyView(pageId: string, canStop: boolean) {
  return $prose(() => {
    let slot: LiveSlot | null = null
    let view: EditorView | null = null
    const chipOf = (id: string): HTMLElement | null => {
      if (!view || view.isDestroyed) return null
      const pos = replyPos(view.state.doc, id)
      const dom = pos >= 0 ? view.nodeDOM(pos) : null
      return dom instanceof HTMLElement ? dom.querySelector<HTMLElement>('.island.is-docked') : null
    }
    const build = (doc: PMNode): DecorationSet => {
      if (!slot) return DecorationSet.empty
      const decos: Decoration[] = []
      doc.forEach((node, offset) => {
        if (node.type.name !== 'agent_reply') return
        const hit = slot!.attach(node)
        const id = String(node.attrs.id)
        const opts = { ignoreSelection: true, stopEvent: () => true }
        if (!hit) {
          // 没有实时视图接管的失败块（刷新后、实时视图收回后）：失败条接在运行条原来的位置
          if (isFailedReply(node.attrs.stats)) {
            const key = `fail:${id}:${failText(id)}:${canStop}:${chainRestAfter(doc, id)}`
            decos.push(
              Decoration.widget(offset + 1, () => buildFailStrip({ pageId, replyId: id, canRetry: canStop, rest: chainRestAfter(doc, id) }), { ...opts, side: -1, key }),
            )
          }
          // agent 的计划清单随回复块落盘（plan 属性），放在失败条（若有）之下、正文之上，与运行中它在运行条里的位置一致
          const plan = decodePlan(node.attrs.plan)
          if (plan.length > 0) {
            decos.push(Decoration.widget(offset + 1, () => buildPlanStrip(plan), { ...opts, side: -1, key: `plan:${id}:${String(node.attrs.plan)}` }))
          }
          // 带队（/带队）的团队计划 / 进度同理（team 属性），是计划卡或进度卡，紧随计划清单。canStop 即页面可写
          const team = decodeTeam(node.attrs.team)
          if (team) {
            decos.push(
              Decoration.widget(offset + 1, () => buildTeamStrip(team, { pageId, canAct: canStop }), {
                ...opts,
                side: -1,
                key: `team:${id}:${canStop}:${String(node.attrs.team)}`,
                destroy: disposeTeamStrips,
              }),
            )
          }
          return
        }
        // 块内纵向顺序：抬头（CSS 伪元素）、运行条、正文。同位置同 side 的 widget 按加入顺序排
        decos.push(Decoration.widget(offset + 1, hit.ctrl.strip, { ...opts, side: -1, key: `live-strip:${id}` }))
        if (hit.phase === 'live') {
          decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'is-live', contenteditable: 'false' }))
          decos.push(Decoration.widget(offset + 1, hit.ctrl.body, { ...opts, side: -1, key: `live-body:${id}` }))
        } else {
          requestAnimationFrame(() => slot?.land(chipOf(id)))
        }
      })
      return DecorationSet.create(doc, decos)
    }
    return new Plugin({
      key: liveKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, prev, _old, state) => (tr.getMeta(liveKey) || tr.docChanged ? build(state.doc) : prev),
      },
      props: { decorations: (state) => liveKey.getState(state) },
      view: (v) => {
        view = v
        const refresh = (): void => {
          if (!v.isDestroyed) v.dispatch(v.state.tr.setMeta(liveKey, true))
        }
        // 聊天 / 源码模式下文档编辑器是 display:none，那时实时视图归聊天气泡，这份不建
        slot = new LiveSlot({
          pageId,
          canStop,
          visible: () => v.dom.offsetParent !== null,
          onChange: refresh,
          rest: (replyId) => chainRestAfter(v.state.doc, replyId),
        })
        const raf = requestAnimationFrame(refresh)
        // 运行中跟住正在生成的块末尾（doc-follow.ts），哪些块 live 由上面的 is-live 装饰决定
        const follow = createDocFollow(v.dom)
        return {
          update: () => follow.sync(),
          destroy: () => {
            cancelAnimationFrame(raf)
            follow.destroy()
            slot?.dispose()
            slot = null
            view = null
          },
        }
      },
    })
  })
}
