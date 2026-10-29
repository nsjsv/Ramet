/* ---------- 计划卡里的三个编辑控件：单行文字、负责人下拉、工作目录下拉 ----------
 * 都是改一项存一项（PATCH，没有保存按钮），控件自己不持久状态，值永远来自计划视图 store。
 * 存成功后 store 换新视图、控件跟着换，存失败由调用方显示原因，输入框回到服务端的值。 */

import { useEffect, useRef, useState } from 'react'
import { AgentBadgeView } from '../agent-marks'
import { COPY } from '../copy'
import { agentBadge } from '../editor/ai-block'
import { useAgents } from '../default-agent'
import { ChipMenu } from '../editor/chip-menu'
import { WorkspacePanel } from '../editor/workspace-panel'
import { Icon } from '../icons'

const T = COPY.team.task

/** 单行文字：失焦或回车时提交（空串 / 没改回到原值），Esc 放弃。输入法组字中的回车不算 */
export function EditableLine({
  value,
  max,
  label,
  className,
  onCommit,
}: {
  value: string
  max: number
  label: string
  className: string
  onCommit: (text: string) => void
}) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  const cancelled = useRef(false)
  // 没在编辑时跟着服务端的值走
  useEffect(() => {
    if (!focused.current) setText(value)
  }, [value])
  return (
    <input
      className={className}
      value={text}
      maxLength={max}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        if (cancelled.current) {
          cancelled.current = false
          setText(value)
          return
        }
        const next = text.trim()
        if (!next || next === value) setText(value)
        else onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** 目录名（只用于显示，完整路径在 title）。分隔符两种都认，connector 可能跑在 Windows */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 负责人：点开列出我能用的 agent（/api/agents 已按机器使用权过滤），当前的打勾；用不了的负责人标红并提示换人 */
export function AssigneeChip({
  label,
  assignee,
  usable,
  disabled,
  onPick,
}: {
  label: string
  assignee: string
  usable: boolean
  disabled: boolean
  onPick: (agentId: string) => void
}) {
  // 目录只在可编辑时才拉，这个组件只在发起人的草稿计划里出现；公开页 / 过程页的匿名访客拉目录会 401 跳登录
  const { agents } = useAgents()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`team-chip${usable ? '' : ' is-bad'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={usable ? T.assignee : T.unusableTip}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentBadgeView badge={agentBadge(assignee)} className="chip-mark" />
        <span className="chip-text">{label}</span>
        <Icon name="caret" size={12} />
      </button>
      {open && anchor.current && (
        <ChipMenu anchor={anchor.current} onClose={() => setOpen(false)} label={T.assigneeMenu}>
          <div className="menu-title">{T.assigneeMenu}</div>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="menu-item"
              role="menuitemradio"
              aria-checked={a.id === assignee}
              onClick={() => {
                setOpen(false)
                if (a.id !== assignee) onPick(a.id)
              }}
            >
              <AgentBadgeView badge={agentBadge(a.id)} className="chip-mark" />
              <span className="menu-text">
                <span className="t">{a.label}</span>
              </span>
              {a.id === assignee && <Icon name="check" size={14} className="tick" />}
            </button>
          ))}
        </ChipMenu>
      )}
    </>
  )
}

/** 工作目录：默认是页面上这个 agent 当前的工作目录。点开是和输入卡同一个目录浏览面板，
 *  列的是那个 agent 所在机器上的真实目录（服务端 agent-dirs，含机器使用权判定），选定后 PATCH，回默认就是清掉 */
export function CwdChip({
  pageId,
  agent,
  cwd,
  startAt,
  disabled,
  onApply,
}: {
  pageId: string
  agent: string
  /** 任务上设过的目录；空 = 用默认 */
  cwd: string
  /** 目录浏览的起点（任务没设时 = 页面上该 agent 当前的工作区） */
  startAt: string
  disabled: boolean
  /** 抛错则面板不关、就地显示原因；'' = 回默认 */
  onApply: (cwd: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="team-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={cwd ? T.cwdTip(cwd) : T.cwdDefaultTip}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" size={13} />
        <span className="chip-path">{cwd ? baseName(cwd) : T.cwdDefault}</span>
      </button>
      {open && anchor.current && (
        <ChipMenu anchor={anchor.current} onClose={() => setOpen(false)} label={T.cwd} className="ws" focusItem={false}>
          <WorkspacePanel pageId={pageId} agent={agent} cwd={cwd || startAt} onApply={onApply} onClose={() => setOpen(false)} />
        </ChipMenu>
      )}
    </>
  )
}
