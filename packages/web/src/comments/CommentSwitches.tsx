/* ---------- 顶栏 ⋮ 菜单里的「评论」项：悬浮展开子菜单，里面是两个开关 ----------
 * 两种评论各一个开关（页面属性 pages.inline_comments / page_comments，协作者与公开页同看）：划词评论默认开，底部讨论默认关。
 * 写完重拉页面树，开关状态以服务端为准；关掉的那种服务端也不再列出、不收新评论。
 * 子菜单向左飞出（⋮ 菜单贴着视口右缘）。移出后延迟收起：鼠标斜着划向子菜单时会短暂离开两者，立刻收会扑空。
 * 触屏没有悬浮，点「评论」本身也能展开 / 收起。 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { toast } from '../ui/toast'

const C = COPY.comments
const CLOSE_DELAY_MS = 180

export type CommentSwitchState = { inline: boolean; page: boolean }

export default function CommentSwitches({ pageId, state, onChanged }: { pageId: string; state: CommentSwitchState; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = () => {
    window.clearTimeout(timer.current)
    setOpen(true)
  }
  const hideSoon = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  const toggle = (col: 'inline_comments' | 'page_comments', on: boolean) => {
    api.setCommentSwitch(pageId, col, on).then(onChanged, (err: unknown) => {
      console.error('set comment switch failed:', err)
      toast(C.switchFailed, { kind: 'error' })
    })
  }
  return (
    <div className="page-menu-flyout" onMouseEnter={show} onMouseLeave={hideSoon}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="comment" className="menu-icon" />
        {C.switches}
        <Icon name="chevron" size={14} className="menu-chevron" />
      </button>
      {open && (
        <div className="page-menu page-menu-sub" role="menu">
          <button type="button" role="menuitemcheckbox" aria-checked={state.inline} data-tip={C.inlineSwitchHint} onClick={() => toggle('inline_comments', !state.inline)}>
            {C.inlineSwitch}
            {state.inline && <Icon name="check" size={14} className="menu-check" />}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={state.page} data-tip={C.pageSwitchHint} onClick={() => toggle('page_comments', !state.page)}>
            {C.pageSwitch}
            {state.page && <Icon name="check" size={14} className="menu-check" />}
          </button>
        </div>
      )}
    </div>
  )
}
