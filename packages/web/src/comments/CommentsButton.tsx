/* ---------- 顶栏「评论」按钮：未解决数角标，点了开 / 关评论抽屉 ---------- */

import { COPY } from '../copy'
import { Icon } from '../icons'
import { unresolvedCount, useComments } from './comments-store'

export default function CommentsButton({ pageId, onClick }: { pageId: string; onClick: () => void }) {
  const s = useComments()
  const n = unresolvedCount(s, pageId)
  const label = COPY.comments.topbar(n)
  return (
    <button type="button" className="topbar-btn cm-topbar-btn" title={label} aria-label={label} aria-pressed={s.drawer} onClick={onClick}>
      <Icon name="comment" />
      {n > 0 && <span className="cm-badge">{n > 99 ? '99+' : n}</span>}
    </button>
  )
}
