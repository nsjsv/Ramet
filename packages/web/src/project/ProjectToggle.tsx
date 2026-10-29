import { COPY } from '../copy'
import { Icon } from '../icons'
import { PROJECT_TOGGLE_LABEL } from './project-keys'
import { useProjectToggle } from './project-state'

/** 顶栏上的项目面板开关。当前页面的 agent 不是一台自己能用的机器时不出现（见 project-state.ts 的 useProjectTarget） */
export default function ProjectToggle({ pageId }: { pageId: string | undefined }) {
  const { available, open, toggle } = useProjectToggle(pageId)
  if (!available) return null
  return (
    <button
      type="button"
      className="topbar-btn"
      title={`${COPY.project.toggle}（${PROJECT_TOGGLE_LABEL}）`}
      aria-label={COPY.project.toggle}
      aria-pressed={open}
      onClick={toggle}
    >
      <Icon name="panel-right" />
    </button>
  )
}
