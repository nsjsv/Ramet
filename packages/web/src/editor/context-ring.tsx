/* ---------- 输入卡上的上下文圆环 ----------
 * 发消息前就能看到这个会话的上下文还剩多少。取本页、输入卡当前选的 agent 最近一次已知的占用：
 *   - 这个 agent 正在跑一轮时取实时的 RunState.info.context（ACP usage_update）
 *   - 否则取文档里这个 agent 最近一条已收尾回复的 stats.cu / cs（收尾时的最后一次 usage_update）
 * 都没有就不画。全文重放会新建会话，那时显示的仍是上一次已知值（标「上一轮结束时」），新一轮开跑后由实时值接替。
 * 点开是明细，agent 有 /compact 命令时还有「压缩上下文」（在跑时排队，这一轮结束后发）。 */
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { decodeStats } from '@ramet/shared/reply-stats'
import { fmtTokens } from './run-format'

const C = {
  title: '上下文用量',
  detail: (pct: number, used: string, size: string) => `上下文 ${pct}% · ${used} / ${size} tokens`,
  live: '实时',
  last: '上一轮结束时',
  compact: '压缩上下文',
  compactHint: '/compact：早先的对话折成摘要，文档本身不变',
}

export type CtxInfo = { used: number; size: number; live: boolean }

/** 取值（纯函数）。replies 是文档里的 AI 回复（按文档顺序），live 是本页在跑的一轮（没有或已结束为 null） */
export function contextFor(
  replies: ReadonlyArray<{ agent: string; stats: unknown }>,
  agent: string,
  live: { agent?: string; context?: { used: number; size: number } } | null,
): CtxInfo | null {
  if (!agent) return null
  if (live?.agent === agent && live.context && live.context.size > 0) return { used: live.context.used, size: live.context.size, live: true }
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i]!
    if (r.agent !== agent) continue
    const s = decodeStats(r.stats)
    // 在飞 / 没收尾就断了的块不算；最近一条收尾的回复没报上下文就当不知道，不拿更早的旧值冒充
    if (!s.o || s.o === 'run') continue
    return s.cu !== undefined && s.cs ? { used: s.cu, size: s.cs, live: false } : null
  }
  return null
}

/** ≥ 95% 红、≥ 80% 琥珀 */
export function ctxLevel(info: CtxInfo): '' | 'is-warn' | 'is-danger' {
  const p = info.used / info.size
  return p >= 0.95 ? 'is-danger' : p >= 0.8 ? 'is-warn' : ''
}

/** 文档里的 AI 回复（顶层 agent_reply 的 agent / stats 属性），按文档顺序 */
export function repliesOf(doc: Y.Doc | undefined): Array<{ agent: string; stats: unknown }> {
  const out: Array<{ agent: string; stats: unknown }> = []
  doc?.getXmlFragment('prosemirror').forEach((node) => {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== 'agent_reply') return
    const agent: unknown = node.getAttribute('agent')
    out.push({ agent: typeof agent === 'string' ? agent : '', stats: node.getAttribute('stats') })
  })
  return out
}

export function ContextRing({ info, canCompact, onCompact }: { info: CtxInfo; canCompact: boolean; onCompact: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: Event): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', away)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', away)
    }
  }, [open])
  const p = Math.min(1, info.used / info.size)
  const pct = Math.round(p * 100)
  return (
    <div className="ctx-box" ref={box}>
      <button
        type="button"
        className={`ctx-ring ${ctxLevel(info)}`.trim()}
        title={C.title}
        aria-label={C.title}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="ring" style={{ '--p': p } as React.CSSProperties} />
        <span>{pct}%</span>
      </button>
      {open && (
        <div className="ctx-pop" role="dialog" aria-label={C.title}>
          <div className="ctx-line">{C.detail(pct, fmtTokens(info.used), fmtTokens(info.size))}</div>
          <div className="ctx-sub">{info.live ? C.live : C.last}</div>
          {canCompact && (
            <button
              type="button"
              className="ctx-compact"
              title={C.compactHint}
              onClick={() => {
                setOpen(false)
                onCompact()
              }}
            >
              {C.compact}
              <span>{C.compactHint}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
