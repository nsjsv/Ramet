/* ---------- 文档模式：`>>` 草稿里的 ⇧Tab 切换权限模式 ----------
 * 与对话输入卡（chat-view.tsx）同一个动作：按 agent 上报的模式顺序转到下一档，跳过「跳过全部确认」档
 * （agent-mode.ts 的 nextModeValue），写入走会话配置的唯一通道（agent-controls.tsx 的 writeSessionOption，
 * 服务端校验权限；失败的原因进运行错误条）。模式是会话的状态，不是这条消息的属性，所以不写消息节点 attrs。
 * 只在光标位于草稿（文档最后一条、其后没有回复的用户消息）里接管，且让位给既有的 Shift-Tab：
 * 列表缩进 / 代码块缩进 / 表格跳格（editing-keys.ts、gfm 先处理，这里再声明一次不抢）。
 * 这个插件必须排在 editingKeys 之后（editor-session.ts 的 .use 顺序）。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { pageAgent, subscribeAgentOptions } from './agent-bar'
import { nextModeStep, writeSessionOption } from './agent-controls'
import { draftIdOf } from './doc-send'
import { messageConfigOf } from './message-blocks'

/** 已提交未确认的模式值（`${页}\n${agent}` → configId → value）：连按 ⇧Tab 从上一次的目标接着转。
 *  会话的 config 事件一到就以它为准（清空）。 */
const pending = new Map<string, Record<string, string>>()
subscribeAgentOptions(() => pending.clear())

/** 光标所在的草稿消息（不在草稿里 / 在列表项、代码块、表格里 = null） */
function draftAt(state: EditorState): PMNode | null {
  const { $head } = state.selection
  if ($head.depth < 1) return null
  const top = $head.node(1)
  if (top.type.name !== 'user_message' || top.attrs.id !== draftIdOf(state.doc)) return null
  if ($head.parent.type.spec.code) return null
  for (let d = 2; d <= $head.depth; d++) {
    const name = $head.node(d).type.name
    if (name === 'list_item' || name.startsWith('table')) return null
  }
  return top
}

export function docModeKeys(opts: { pageId: string; enabled: boolean }) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('rametDocModeKeys'),
        props: {
          handleKeyDown: (view, event) => {
            if (!opts.enabled || event.isComposing || view.composing) return false
            if (event.key !== 'Tab' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
            const draft = draftAt(view.state)
            if (!draft) return false
            // 这条草稿要发给谁：消息 chip 指定的来源，失效 / 没指定 → 本页的来源（与发送同一条 pageAgent 解析）
            const agent = pageAgent(opts.pageId, messageConfigOf(draft).agent)
            const key = `${opts.pageId}\n${agent}`
            const step = agent ? nextModeStep(opts.pageId, agent, pending.get(key)) : null
            if (!step) return false // 没得转（表外 agent / 不足两档）：键照旧，不假装生效
            pending.set(key, { ...pending.get(key), [step.configId]: step.value })
            void writeSessionOption(opts.pageId, agent, step.configId, step.value).then((ok) => {
              if (ok) return
              const left = { ...pending.get(key) }
              delete left[step.configId]
              pending.set(key, left)
            })
            return true
          },
        },
      }),
  )
}
