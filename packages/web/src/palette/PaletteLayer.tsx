/* ---------- 命令面板的浮层本体（按需加载）----------
 * 开关状态与 ⌘K 监听在常驻的 CommandPalette.tsx；这里是第一次打开面板才下载的部分：收集当前上下文、画浮层、接键盘。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAgents } from '../default-agent'
import { Icon } from '../icons'
import { agentName } from '../editor/agent-badge'
import { agentCommandsFor, pageAgent, setAgentRunError, setPageChoice, useAgentEvents } from '../editor/agent-bar'
import { nowOf } from '../editor/run-strip'
import { isMentionablePage } from '../editor/mention-query'
import { closeHud, openHud, useHud } from '../hud/hud-store'
import { requestQuickOpen, toggleProject, useProjectShell, useProjectTarget } from '../project/project-state'
import { openSettings } from '../settings-bus'
import { readViewMode, requestViewToggle } from '../view-mode'
import { closePalette, paletteDraft, type PaletteProps as Props } from './CommandPalette'
import { filterPalette, paletteItems, PALETTE_COPY as C, type PaletteHit } from './palette-model'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** 命中的字高亮 */
function Label({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>
  const hit = new Set(indices)
  return (
    <>
      {[...text].map((ch, i) => (hit.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  )
}

export default function PaletteLayer({ pages, spaceId, canWritePage, onCreated }: Props) {
  const navigate = useNavigate()
  const pageId = useMatch('/page/:id')?.params.id ?? null
  const agent = useAgentEvents(pageId ?? undefined)
  const hud = useHud()
  const shell = useProjectShell()
  const target = useProjectTarget(pageId ?? undefined)
  const { agents } = useAgents()
  const [query, setQuery] = useState(paletteDraft)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    const current = pageId ? pageAgent(pageId) : ''
    const live = agent.run && !agent.run.outcome ? agent.run : null
    const close = (fn: () => void) => () => {
      closePalette()
      fn()
    }
    const items = paletteItems(
      {
        pageId,
        canWrite: pageId ? canWritePage(pageId) : false,
        run: live ? { agentLabel: agentName(live.agent ?? current) || live.agent || current, now: nowOf(live.state).text, asking: agent.permissions.length > 0 } : null,
        hud: { available: live !== null || hud.open, open: hud.open },
        project: { available: target !== null, open: shell.open },
        chatMode: pageId ? readViewMode(pageId) : null,
        agents: agents.map((a) => ({ id: a.id, label: a.label })),
        currentAgent: current,
        canCompact: pageId ? agentCommandsFor(pageId, current).some((c) => c.name === 'compact') : false,
        pages: pages.filter((p) => isMentionablePage(p) && p.space_id === spaceId && p.in_page_tree !== false).map((p) => ({ id: p.id, title: p.title })),
        spaceId,
        mod: MOD,
      },
      {
        openHud: close(() => openHud('overview')),
        closeHud: close(closeHud),
        stop: close(() => pageId && void api.stopPage(pageId).catch((err: unknown) => setAgentRunError(err instanceof Error ? err.message : String(err)))),
        toggleProject: close(toggleProject),
        quickOpen: close(requestQuickOpen),
        toggleView: close(requestViewToggle),
        switchAgent: (id) => close(() => pageId && setPageChoice(pageId, id))(),
        // 压缩 = 发一条 /compact：走排队接口（页面空着服务端直接发，在跑就排着），不需要编辑器视图
        compact: close(() => pageId && void api.enqueue(pageId, { agent: current, kind: 'message', text: '/compact' }).catch((err: unknown) => setAgentRunError(err instanceof Error ? err.message : String(err)))),
        newPage: close(() => {
          if (!spaceId) return
          void api.createPage(null, spaceId).then((p) => {
            onCreated()
            navigate(`/page/${p.id}`)
          }, (err: unknown) => setAgentRunError(err instanceof Error ? err.message : String(err)))
        }),
        go: (path) => close(() => navigate(path))(),
        settings: (tab) => close(() => openSettings(tab, spaceId ?? undefined))(),
      },
    )
    return filterPalette(items, query)
  }, [pageId, agent, hud, shell.open, target, agents, pages, spaceId, canWritePage, query, navigate, onCreated])

  const flat: PaletteHit[] = useMemo(() => groups.flatMap((g) => g.hits), [groups])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      flat[active]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    }
  }

  let i = -1
  return (
    <div className="palette-veil" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-label="命令面板">
        <div className="pal-in">
          <Icon name="search" size={18} />
          <input autoFocus placeholder={C.placeholder} aria-label={C.placeholder} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={list} role="listbox">
          {flat.length === 0 && <div className="pal-empty">{C.empty}</div>}
          {groups.map((g) => (
            <div key={g.group}>
              <div className="pal-group">{C.groups[g.group]}</div>
              {g.hits.map((it) => {
                i++
                const n = i
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="option"
                    aria-selected={n === active}
                    data-i={n}
                    className={n === active ? 'pal-item is-active' : 'pal-item'}
                    onMouseMove={() => n !== active && setActive(n)}
                    onClick={() => it.run()}
                  >
                    <span className="pal-ic">{typeof it.icon === 'string' && <Icon name={it.icon} size={16} />}</span>
                    <span className="pal-main">
                      <Label text={it.label} indices={it.indices} />
                      {it.desc && <span className={`pal-desc${it.tone ? ` is-${it.tone}` : ''}`}>{it.desc}</span>}
                    </span>
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>{C.foot.pick}</span>
          <span>{C.foot.run}</span>
          <span>{C.foot.toggle(`${MOD}K`)}</span>
        </div>
      </div>
    </div>
  )
}
