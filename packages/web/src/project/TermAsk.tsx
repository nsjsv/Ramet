import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { COPY } from '../copy'
import { isQuickKey } from '../editor/quick-keys'
import { Icon } from '../icons'
import { needsSettings, quickReadiness, streamQuick } from '../quick-api'
import { openSettings } from '../settings-bus'
import { commandKeystrokes, sanitizeCommand, terminalTail, type SuggestedCommand } from './term-context'

const Q = COPY.quick

type Phase =
  | { kind: 'input' }
  | { kind: 'running' }
  | { kind: 'suggest'; cmd: SuggestedCommand }
  | { kind: 'error'; message: string; settings: boolean }

/** 建议出现之后这么久之内按回车不算数：用户可能还在连按回车，没看清就执行等于把确认变成了自动执行 */
const ARM_MS = 400

/* ---------- 终端里的 ⌘J（说人话）：一条输入条，贴在终端屏幕下面 ----------
 * 流程：⌘J 打开，用人话说想做什么，回车，随手 AI 给出一条建议的命令，用户看清后再按回车才执行
 * （Tab 只放进终端的输入行自己改，不执行；Esc 取消）。多行命令回车不执行，必须点「确认执行」。
 * 不自动执行任何东西：写进 pty 只有两个入口，都在用户的按键 / 点击里（isTrusted），且只写进这个终端
 * （TermPane 只为我自己开的终端渲染，send 就是它自己那条输入通道）。
 * 发给模型的终端输出先剥控制序列、只留最后 30 行（term-context.ts）。命令按不可信文本清洗后才显示 / 写入。 */
export default function TermAsk({
  shell,
  cwd,
  getOutput,
  send,
  onClose,
}: {
  shell: string
  cwd: string
  /** 终端最近的原始输出（带控制序列） */
  getOutput: () => string
  /** 写进这个终端（用户自己的 pty） */
  send: (data: string) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'input' })
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const suggest = useRef<HTMLDivElement>(null)
  const ctrl = useRef<AbortController | null>(null)
  const armedAt = useRef(0)
  const used = useRef(false)

  useEffect(() => {
    input.current?.focus()
    return () => ctrl.current?.abort()
  }, [])
  useEffect(() => {
    if (phase.kind === 'input' || phase.kind === 'error') input.current?.focus()
    if (phase.kind === 'suggest') suggest.current?.focus()
  }, [phase.kind])

  function close(): void {
    ctrl.current?.abort()
    onClose()
  }

  async function run(): Promise<void> {
    const instruction = text.trim()
    if (!instruction || phase.kind === 'running') return
    const c = new AbortController()
    ctrl.current?.abort()
    ctrl.current = c
    setPhase({ kind: 'running' })
    const ready = await quickReadiness()
    if (c.signal.aborted) return
    if (!ready.ok) return setPhase({ kind: 'error', message: ready.message, settings: true })
    let buf = ''
    const out = await streamQuick({ kind: 'command', instruction, shell, cwd, output: terminalTail(getOutput()) }, (d) => (buf += d), c.signal)
    if (c.signal.aborted) return
    if (!out.ok) return setPhase({ kind: 'error', message: out.message, settings: needsSettings(out.code) })
    const cmd = sanitizeCommand(buf)
    if (!cmd) return setPhase({ kind: 'error', message: Q.term.noCommand, settings: false })
    armedAt.current = Date.now() + ARM_MS
    setPhase({ kind: 'suggest', cmd })
  }

  /** 写进终端并收起。execute = false：只放进 shell 的输入行（不回车） */
  function put(cmd: SuggestedCommand, execute: boolean): void {
    if (used.current) return
    used.current = true
    send(commandKeystrokes(cmd.command, execute))
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (isQuickKey(e.nativeEvent)) {
      e.preventDefault() // 浏览器自带的 Ctrl+J（下载）不要冒出来
      return
    }
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (phase.kind === 'suggest') {
      if (e.target instanceof HTMLButtonElement) return // 焦点在按钮上：回车 / 空格就是点那个按钮
      if (!e.isTrusted || e.repeat) return
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        // 多行命令：回车不执行，必须点「确认执行」；还没"看清"的第一眼也不执行
        if (!phase.cmd.multiline && Date.now() >= armedAt.current) put(phase.cmd, true)
      } else if (e.key === 'Tab' && !e.shiftKey && !phase.cmd.multiline) {
        e.preventDefault()
        put(phase.cmd, false)
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && (phase.kind === 'input' || phase.kind === 'error') && e.target === input.current) {
      e.preventDefault()
      void run()
    }
  }

  const lines = phase.kind === 'suggest' ? phase.cmd.command.split('\n').length : 0
  return (
    <div className="term-ask" role="dialog" aria-label={Q.term.title} onKeyDown={onKeyDown}>
      <div className="term-ask-head">
        <Icon name="sparkle" size={14} className="term-ask-spark" />
        <input
          ref={input}
          className="term-ask-input"
          type="text"
          value={text}
          maxLength={500}
          placeholder={Q.term.placeholder}
          aria-label={Q.term.title}
          disabled={phase.kind === 'running' || phase.kind === 'suggest'}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" className="project-chip-btn" onClick={close}>
          {Q.reject}
        </button>
      </div>
      {phase.kind === 'running' && (
        <p className="term-ask-status" role="status">
          <span className="quick-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {Q.term.running} <span className="quick-keys">{Q.term.cancelRunning}</span>
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="term-ask-status is-error" role="alert">
          {phase.message}
          {phase.settings && (
            <button
              type="button"
              className="project-chip-btn"
              onClick={() => {
                close()
                openSettings('quick')
              }}
            >
              {Q.openSettings}
            </button>
          )}
        </p>
      )}
      {phase.kind === 'suggest' && (
        <div className="term-ask-suggest" ref={suggest} tabIndex={0} aria-label={Q.term.notExecuted}>
          <pre className="term-ask-cmd">{phase.cmd.command}</pre>
          {phase.cmd.multiline && <p className="term-ask-warn">{Q.term.multiline(lines)}</p>}
          <div className="term-ask-actions">
            {phase.cmd.multiline ? (
              <button type="button" className="quick-btn is-primary" onClick={() => put(phase.cmd, true)}>
                {Q.term.confirmMulti}
              </button>
            ) : (
              <>
                <span className="quick-keys">{Q.term.runKey}</span>
                <span className="quick-keys">{Q.term.editKey}</span>
              </>
            )}
            <span className="quick-keys">{Q.term.cancelKey}</span>
            <span className="term-ask-where">{Q.term.where(shell, cwd)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
