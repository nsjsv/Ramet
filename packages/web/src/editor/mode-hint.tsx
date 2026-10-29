/* ---------- 权限模式提示行：离开默认档时，告诉用户现在是什么模式、它意味着什么 ----------
 * 文字全取 agent 上报的（档位名称 / 说明，缺了才用 COPY.modes.known 兜底）；
 * 默认档（agent 的 `default`，没有就是它上报的第一个）不出现。能用 ⇧Tab 轮换时才带「⇧Tab 切换」。
 * 对话宿主放在输入卡上方（chat-view.tsx）；文档宿主是 `>>` 草稿署名行下方的块首 widget（message-chips.tsx）。 */

import { useSyncExternalStore } from 'react'
import { COPY } from '../copy'
import { useAgents } from '../default-agent'
import { agentOptionsFor, subscribeAgentOptions } from './agent-bar'
import { defaultModeValue, modeOptionOf, modeText, nextModeValue } from './agent-mode'

export function ModeHint({ pageId, agent, pending }: { pageId: string; agent: string; pending?: Readonly<Record<string, string>> }) {
  const options = useSyncExternalStore(subscribeAgentOptions, () => agentOptionsFor(pageId, agent))
  const { agents } = useAgents()
  const posture = agents.find((a) => a.id === agent)?.posture
  // 与 ChipBar 同口径：没核实过的 agent（posture.modes 为假）不摆权限模式
  const option = posture?.modes ? modeOptionOf(options) : undefined
  if (!option || !posture) return null
  const current = pending?.[option.id] ?? option.currentValue
  if (!current || current === defaultModeValue(option)) return null
  const text = modeText(option.options.find((v) => v.value === current) ?? { value: current, name: '' })
  const risky = posture.unrestricted.includes(current)
  return (
    <div className={`mode-hint${risky ? ' is-risky' : ''}`} role="status">
      <span className="mode-hint-name">{text.t}</span>
      {text.d && <span className="mode-hint-desc">· {text.d}</span>}
      {nextModeValue(option, current, posture.unrestricted) !== null && <span className="mode-hint-keys">{COPY.modes.rotateHint}</span>}
    </div>
  )
}
