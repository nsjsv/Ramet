/* ---------- 发起控件栏 ChipBar（来源 / 工作目录 / 模型·思考 / 设置 = 权限模式 + 工具档位）----------
 * 聊天输入卡与文档 `>>` 消息行共用这一个受控组件：值与写入由宿主传入（对话是页面级默认，文档是消息节点 attrs），
 * 本组件不持有会话状态，两处因此不会漂移。
 * 选项来自 agent 的会话（SSE config 事件的模块级镜像 agentOptionsFor）：模型 / 思考 / 权限模式是同一条会话配置通道上的
 * 三类 option（category = model / thought_level / mode），权限模式的名称 / 说明 / 顺序以 agent 上报的为准（agent-mode.ts）。
 * 控件收成四个 chip：模型与思考合一（点模型在右侧展开思考子菜单）；权限模式与工具档位合进齿轮 chip，
 * 都在默认值时只是个图标，离开默认才写出当前值（这两项会改变 agent 能做什么，必须看得见）。
 * 权限判定只在服务端：这里按 GET /api/agents 给的 posture 显示（危险档标红、非主人禁选、mode 不可改的 agent 不摆权限模式），
 * 写入时服务端仍会校验。
 * 工具档位是页面级的（本页所有 agent 共用），只有对话宿主传 tools 才进设置菜单，文档 `>>` 行不传（那里是单条消息的配置）。 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AgentBadgeView } from '../agent-marks'
import type { AgentInfo, ConfigOption, ToolProfile } from '../api'
import { COPY } from '../copy'
import { useAgents } from '../default-agent'
import { Icon } from '../icons'
import { agentOptionsFor, subscribeAgentOptions } from './agent-bar'
import { defaultModeValue, modeText } from './agent-mode'
import { agentBadge } from './ai-block'
import { ChipMenu } from './chip-menu'
import { WorkspacePanel } from './workspace-panel'

const T = COPY.chips

/** 并进「模型」chip 的 option 类别，按摆位顺序 */
const GENERATIVE_CATEGORIES = ['model', 'thought_level']
const CWD = 'cwd'
const AGENT = 'agent'
/** 模型 + 思考 */
const GEN = 'gen'
/** 权限模式 + 工具档位 */
const SETUP = 'setup'

export interface ChipBarProps {
  pageId: string
  /** 已过 pickAgent 回落的实际来源；'' = 没有可用 agent */
  agent: string
  /** 工作目录；'' = 执行端默认 */
  cwd: string
  /** 会话配置项的覆盖值（configId → value）；没有覆盖的用 agent 会话里的当前值 */
  opts: Record<string, string>
  /** card = 输入卡（28px）；inline = 文档消息行（24px） */
  size?: 'card' | 'inline'
  onAgent: (id: string) => void
  /** 抛错则面板不关、就地显示原因 */
  onCwd: (cwd: string) => Promise<void>
  onOpt: (configId: string, value: string) => void
  /** 给了它，权限模式就不走 opts / onOpt：模式是会话状态，不是这条消息的属性，消息级覆盖里的 mode 服务端一律不认。
   *  文档宿主用它；对话宿主的 opts 本身就是会话配置的待确认值，不需要 */
  onMode?: (configId: string, value: string) => void
  /** 本页的工具档位（页面级），给了才进设置 chip，只有对话宿主传 */
  tools?: { value: ToolProfile; onChange: (profile: ToolProfile) => void }
}

/** 目录名（只用于显示，完整路径在 title）：分隔符两种都认，connector 可能跑在 Windows */
function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 一个 option 某个值的显示名（权限模式按 agent-mode 的口径） */
function valueName(option: ConfigOption, value: string): string {
  const hit = option.options.find((v) => v.value === value)
  if (!hit) return value
  return option.category === 'mode' ? modeText(hit).t : hit.name
}

function optionTitle(option: ConfigOption): string {
  if (option.category === 'model') return T.model
  if (option.category === 'thought_level') return T.thought
  if (option.category === 'mode') return COPY.modes.title
  return option.name
}

export function ChipBar({ pageId, agent, cwd, opts, size = 'card', onAgent, onCwd, onOpt, onMode, tools }: ChipBarProps) {
  const { agents, loaded } = useAgents()
  const options = useSyncExternalStore(subscribeAgentOptions, () => agentOptionsFor(pageId, agent))
  const [open, setOpen] = useState<string | null>(null)
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({})

  // 换页 / 换 agent 关掉菜单：换 agent 等于换机器，旧菜单（目录树、选项）没有意义
  useEffect(() => {
    setOpen(null)
  }, [pageId, agent])

  if (agents.length === 0) {
    return <span className="chip-empty">{loaded ? T.noAgents : T.loadingAgents}</span>
  }

  const info = agents.find((a) => a.id === agent)
  const posture = info?.posture
  const unrestricted = posture?.unrestricted ?? []
  const generative = options
    .filter((o) => o.category != null && GENERATIVE_CATEGORIES.includes(o.category))
    .sort((a, b) => GENERATIVE_CATEGORIES.indexOf(a.category ?? '') - GENERATIVE_CATEGORIES.indexOf(b.category ?? ''))
  // 权限模式：posture.modes 表示服务端核实过这个 agent 的 mode 能改，没核实的不摆
  const modeOption = posture?.modes ? options.find((o) => o.category === 'mode') : undefined
  const valueOf = (o: ConfigOption) => (onMode && o.category === 'mode' ? o.currentValue : (opts[o.id] ?? o.currentValue))

  // 模型 chip 显示「模型名 · 思考档」，后面的值淡一号；只有思考没有模型时显示「思考 xx」
  const genNames = generative.map((o) => valueName(o, valueOf(o)))
  const genMain = generative.length === 1 && generative[0]?.category === 'thought_level' ? T.thoughtChip(genNames[0] ?? '') : genNames[0]
  const genLabel = generative.map(optionTitle).join(' · ')

  // 设置 chip：都在默认值时只是个图标，离开默认（权限模式不在默认档 / 工具不是完整）才写出来，危险档标红、计划档标蓝
  const modeValue = modeOption ? valueOf(modeOption) : ''
  const setupNotes = [
    modeOption && modeValue !== defaultModeValue(modeOption) ? valueName(modeOption, modeValue) : null,
    tools && tools.value !== 'full' ? COPY.tools.label[tools.value] : null,
  ].filter((t): t is string => t != null)
  const setupCls = !modeOption ? '' : unrestricted.includes(modeValue) ? 'is-risky' : modeValue === 'plan' ? 'is-plan' : ''
  const setupLabel = [modeOption && COPY.modes.title, tools && COPY.tools.title].filter(Boolean).join(' · ')
  const setupTitle = [
    modeOption && T.field(COPY.modes.title, valueName(modeOption, modeValue)),
    tools && T.field(COPY.tools.title, COPY.tools.label[tools.value]),
  ]
    .filter(Boolean)
    .join('\n')

  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id))
  const close = () => setOpen(null)
  const openAnchor = open ? (anchors.current[open] ?? null) : null

  return (
    <div className={`chip-bar is-${size}`}>
      <Chip id={AGENT} open={open} anchors={anchors} onToggle={toggle} title={T.agent}>
        <AgentBadgeView badge={agentBadge(agent)} className="chip-mark" />
        <span className="chip-text">{info?.label ?? agent}</span>
      </Chip>
      {agent && (
        <Chip id={CWD} open={open} anchors={anchors} onToggle={toggle} title={COPY.cwd.chipTitle(cwd)}>
          <Icon name="folder" size={14} />
          <span className="chip-path">{cwd ? baseName(cwd) : COPY.cwd.defaultDir}</span>
        </Chip>
      )}
      {generative.length > 0 && (
        <Chip id={GEN} open={open} anchors={anchors} onToggle={toggle} title={genLabel}>
          <span className="chip-text">{genMain}</span>
          {genNames.slice(1).map((name, i) => (
            <span key={i} className="chip-sub">
              {name}
            </span>
          ))}
        </Chip>
      )}
      {(modeOption || tools) && (
        <Chip
          id={SETUP}
          open={open}
          anchors={anchors}
          onToggle={toggle}
          title={setupTitle}
          className={[setupCls, setupNotes.length === 0 ? 'is-icon' : ''].filter(Boolean).join(' ')}
        >
          <Icon name="cog" size={14} />
          {setupNotes.length > 0 && <span className="chip-text">{setupNotes.join(' · ')}</span>}
        </Chip>
      )}

      {open === AGENT && openAnchor && (
        <AgentMenu anchor={openAnchor} agents={agents} current={agent} onPick={(id) => { close(); onAgent(id) }} onClose={close} />
      )}
      {open === CWD && openAnchor && agent && (
        <ChipMenu anchor={openAnchor} onClose={close} label={COPY.cwd.title} className="ws" focusItem={false}>
          <WorkspacePanel pageId={pageId} agent={agent} cwd={cwd} onApply={onCwd} onClose={close} />
        </ChipMenu>
      )}
      {open === GEN && openAnchor && generative.length > 0 && (
        <GenMenu
          anchor={openAnchor}
          label={genLabel}
          model={generative.find((o) => o.category === 'model')}
          thought={generative.find((o) => o.category === 'thought_level')}
          valueOf={valueOf}
          onPick={onOpt}
          onClose={close}
        />
      )}
      {open === SETUP && openAnchor && (modeOption || tools) && (
        <ChipMenu anchor={openAnchor} onClose={close} label={setupLabel}>
          {modeOption && (
            <OptionItems
              option={modeOption}
              value={modeValue}
              divided={false}
              owner={posture?.owner ?? false}
              unrestricted={unrestricted}
              onPick={(value) => { close(); (onMode ?? onOpt)(modeOption.id, value) }}
            />
          )}
          {tools && <ToolItems value={tools.value} divided={modeOption != null} onPick={(p) => { close(); tools.onChange(p) }} />}
        </ChipMenu>
      )}
    </div>
  )
}

function Chip({
  id,
  open,
  anchors,
  onToggle,
  title,
  className,
  children,
}: {
  id: string
  open: string | null
  anchors: { current: Record<string, HTMLButtonElement | null> }
  onToggle: (id: string) => void
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`chip${className ? ` ${className}` : ''}`}
      aria-haspopup="menu"
      aria-expanded={open === id}
      title={title}
      ref={(el) => {
        anchors.current[id] = el
      }}
      // 不抢编辑器 / 输入框的焦点，菜单打开后焦点由 ChipMenu 放到菜单项上
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(id)}
    >
      {children}
    </button>
  )
}

function AgentMenu({
  anchor,
  agents,
  current,
  onPick,
  onClose,
}: {
  anchor: HTMLElement
  agents: AgentInfo[]
  current: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <ChipMenu anchor={anchor} onClose={onClose} label={T.agent}>
      <div className="menu-title">{T.agent}</div>
      {agents.map((a) => {
        const badge = agentBadge(a.id)
        return (
          <button
            key={a.id}
            type="button"
            className="menu-item"
            role="menuitemradio"
            aria-checked={a.id === current}
            onClick={() => onPick(a.id)}
          >
            <AgentBadgeView badge={badge} className="chip-mark" />
            <span className="menu-text">
              <span className="t">{a.label}</span>
            </span>
            {a.id === current && <Icon name="check" size={14} className="tick" />}
          </button>
        )
      })}
    </ChipMenu>
  )
}

/** 模型菜单：选模型即写入；有思考档时每行带 ›，点击（或 →）在列表右侧展开思考子菜单，选完整个菜单关掉，
 *  ← / Esc 收起子菜单回到模型行。只有思考没有模型的 agent 直接列思考档。
 *  子菜单列的是会话当前的思考档：对话宿主换模型是即时写会话，agent 若按模型给不同档位，SSE 推回后这里跟着变 */
function GenMenu({
  anchor,
  label,
  model,
  thought,
  valueOf,
  onPick,
  onClose,
}: {
  anchor: HTMLElement
  label: string
  model: ConfigOption | undefined
  thought: ConfigOption | undefined
  valueOf: (o: ConfigOption) => string
  onPick: (configId: string, value: string) => void
  onClose: () => void
}) {
  /** 展开了思考子菜单的模型行 */
  const [sub, setSub] = useState<{ value: string; anchor: HTMLElement } | null>(null)

  const pick = (option: ConfigOption, value: string) => {
    if (value !== valueOf(option)) onPick(option.id, value)
  }
  const thoughtItems = (option: ConfigOption) => (
    <OptionItems
      option={option}
      value={valueOf(option)}
      divided={false}
      owner={false}
      unrestricted={[]}
      onPick={(value) => {
        pick(option, value)
        onClose()
      }}
    />
  )

  if (!model) {
    return thought ? (
      <ChipMenu anchor={anchor} onClose={onClose} label={label}>
        {thoughtItems(thought)}
      </ChipMenu>
    ) : null
  }

  const current = valueOf(model)
  const choose = (value: string, row: HTMLElement) => {
    pick(model, value)
    if (thought) setSub({ value, anchor: row })
    else onClose()
  }
  const collapse = () => {
    sub?.anchor.focus({ preventScroll: true })
    setSub(null)
  }

  return (
    <>
      <ChipMenu anchor={anchor} onClose={onClose} label={label}>
        <div className="menu-title">{optionTitle(model)}</div>
        {model.options.map((v) => (
          <button
            key={v.value}
            type="button"
            className="menu-item"
            role="menuitemradio"
            aria-checked={v.value === current}
            aria-haspopup={thought ? 'menu' : undefined}
            aria-expanded={thought ? sub?.value === v.value : undefined}
            onClick={(e) => choose(v.value, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' || !thought) return
              e.preventDefault()
              choose(v.value, e.currentTarget)
            }}
          >
            <span className="menu-text">
              <span className="t">{v.name}</span>
              {v.description && <span className="d">{v.description}</span>}
            </span>
            {v.value === current && <Icon name="check" size={14} className="tick" />}
            {thought && <Icon name="chevron" size={14} className="next" />}
          </button>
        ))}
      </ChipMenu>
      {sub && thought && (
        // 换一行就重挂，焦点重新落到子菜单的已选项
        <ChipMenu key={sub.value} anchor={sub.anchor} onClose={() => setSub(null)} label={optionTitle(thought)} className="sub" side>
          <div
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft') return
              e.preventDefault()
              collapse()
            }}
          >
            {thoughtItems(thought)}
          </div>
        </ChipMenu>
      )}
    </>
  )
}

/** 菜单里一个 option 的一段：段标题 + 各档位，同一个菜单里第二段起上面画分隔线 */
function OptionItems({
  option,
  value,
  divided,
  owner,
  unrestricted,
  onPick,
}: {
  option: ConfigOption
  value: string
  divided: boolean
  owner: boolean
  unrestricted: string[]
  onPick: (value: string) => void
}) {
  const mode = option.category === 'mode'
  return (
    <>
      {divided && <div className="menu-sep" role="separator" />}
      <div className="menu-title">{optionTitle(option)}</div>
      {option.options.map((v) => {
        const text = mode ? modeText(v) : { t: v.name, d: v.description ?? null }
        const risky = mode && unrestricted.includes(v.value)
        // 危险档只有机器主人能选，这里只禁用并说明原因，服务端写入时仍会拒
        const blocked = risky && !owner
        return (
          <button
            key={v.value}
            type="button"
            className={`menu-item${risky ? ' is-risky' : ''}`}
            role="menuitemradio"
            aria-checked={v.value === value}
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) onPick(v.value)
            }}
          >
            <span className="menu-text">
              <span className="t">{text.t}</span>
              {(blocked || text.d) && <span className="d">{blocked ? COPY.modes.ownerOnly : text.d}</span>}
            </span>
            {v.value === value && <Icon name="check" size={14} className="tick" />}
          </button>
        )
      })}
    </>
  )
}

/** 工具档位一段（页面级，只有对话宿主有） */
function ToolItems({ value, divided, onPick }: { value: ToolProfile; divided: boolean; onPick: (profile: ToolProfile) => void }) {
  return (
    <>
      {divided && <div className="menu-sep" role="separator" />}
      <div className="menu-title">{COPY.tools.title}</div>
      {COPY.tools.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="menu-item"
          role="menuitemradio"
          aria-checked={o.value === value}
          onClick={() => onPick(o.value)}
        >
          <span className="menu-text">
            <span className="t">{o.name}</span>
            <span className="d">{o.hint}</span>
          </span>
          {o.value === value && <Icon name="check" size={14} className="tick" />}
        </button>
      ))}
      <div className="menu-note">{COPY.tools.note}</div>
    </>
  )
}
