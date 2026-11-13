/* ---------- 侧栏页面树上方的一行：当前空间的空间 AI ----------
 * 点进空间 AI 页（对话 / 记忆 / Skill，ai/SpaceAiHub.tsx）。没开时这一行照样在，淡一些、带「未启用」：成员要知道这里能有一个，owner 进去能一键去启用。
 * 只在我是成员的空间出现（访客空间没有：那里的约定、AI 都不是给访客的）；名字跟空间 AI 的配置走（assistant/space-ai.ts）。 */
import { NavLink } from 'react-router-dom'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { spaceAiPath } from '../ai/space-ai-path'
import { useSpaceAiOfSpace } from './space-ai'

const C = COPY.spaceAi.row

export default function SpaceAiRow({ spaceId }: { spaceId: string }) {
  const ai = useSpaceAiOfSpace(spaceId)
  if (!ai) return null
  return (
    <nav className="side-nav space-ai-nav">
      <NavLink
        to={spaceAiPath(spaceId)}
        className={({ isActive }) => 'side-nav-item space-ai-row' + (isActive ? ' active' : '') + (ai.enabled ? '' : ' is-off')}
        data-tip={C.tip(ai.name)}
      >
        <span className="side-nav-ic">
          <Icon name="bot" size={18} />
        </span>
        <span className="space-ai-row-name">{ai.name}</span>
        {!ai.enabled && <span className="space-ai-row-off">{C.off}</span>}
      </NavLink>
    </nav>
  )
}
