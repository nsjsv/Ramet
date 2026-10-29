import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { insertIntoComposer } from '../editor/composer-bridge'
import { hydrateCode } from '../editor/code-highlight'
import { QUICK_KEY_LABEL } from '../editor/quick-keys'
import { langOfPath, sizeLabel } from './file-tree'
import { errMessage } from './labels'
import { projectApi, type ReadResult } from './project-api'
import { useCodeQuick } from './use-code-quick'

const C = COPY.project.files

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: ReadResult }

/* ---------- 文件查看器：行号 + 语法高亮（复用编辑器代码块的 lowlight 与配色）----------
 * 查看器本身只读；唯一能改文件的是选中几行后的 ⌘J（随手 AI，use-code-quick.tsx）：就地 diff，↵ 收下才写回。
 * 行号和代码是并排的两个 <pre>（同字体同行高，不换行，一起横向滚），代码那个交给 hydrateCode 画高亮。
 * hydrateCode 直接改 DOM（把文字切成带 class 的 span），所以 <code> 的内容由 effect 手动写，React 不碰它的子节点。
 * 二进制不显示内容；超过 1 MB 只给前 1 MB 并说明。 */
export default function FileViewer({
  pageId,
  agent,
  path,
  active,
  tick,
  canWrite,
  onWritten,
  onBack,
}: {
  pageId: string
  agent: string
  path: string
  active: boolean
  /** 刷新信号（点刷新 / 本页一轮结束）：文件可能被 agent 改了，重读 */
  tick: number
  /** 页面可写（不是只读成员）：只有这时 ⌘J 才能把改写写回文件 */
  canWrite: boolean
  /** 随手 AI 把改写写进了文件：改动分页据此刷新 */
  onWritten: () => void
  onBack: () => void
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [hint, setHint] = useState('')
  const [reload, setReload] = useState(0)
  const loaded = useRef('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const key = `${path}|${tick}|${reload}`
    if (!active || loaded.current === key) return
    loaded.current = key
    let cancelled = false
    let finished = false
    projectApi.read(pageId, agent, path).then(
      (data) => {
        finished = true
        if (!cancelled) setState({ status: 'ok', data })
      },
      (err: unknown) => {
        finished = true
        if (!cancelled) setState({ status: 'error', message: errMessage(err) })
      },
    )
    return () => {
      cancelled = true
      if (!finished) loaded.current = '' // 在飞的这次结果被丢了：下次激活要重来
    }
  }, [pageId, agent, path, active, tick, reload])

  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(''), 2200)
    return () => window.clearTimeout(timer)
  }, [hint])

  /** 把文件 @ 引用进输入卡；文档模式没有输入卡时退回复制（粘贴进 >> 消息） */
  function reference(): void {
    const mark = `@${path} `
    if (insertIntoComposer(mark)) setHint(C.referenced)
    else void copyText(mark.trim()).then((ok) => ok && setHint(C.copied))
  }

  return (
    <div className="project-viewer" ref={rootRef}>
      <div className="project-viewer-head">
        <button type="button" className="project-icon-btn" onClick={onBack} title={C.back} aria-label={C.back}>
          <Icon name="chevron" className="project-back-ico" />
        </button>
        <span className="project-viewer-path" title={path}>
          {path}
        </span>
        {hint && <span className="project-hint">{hint}</span>}
        <button type="button" className="project-chip-btn" onClick={reference} title={C.referenceTitle}>
          {C.reference}
        </button>
      </div>
      {state.status === 'loading' && <p className="project-note">{COPY.loading}</p>}
      {state.status === 'error' && <p className="project-note is-error">{COPY.project.loadFailed(state.message)}</p>}
      {state.status === 'ok' && (
        <Content
          pageId={pageId}
          agent={agent}
          path={path}
          data={state.data}
          canWrite={canWrite && active}
          rootRef={rootRef}
          onSaved={(text, hash) => {
            setState((cur) =>
              cur.status === 'ok' ? { status: 'ok', data: { ...cur.data, text, hash, size: new TextEncoder().encode(text).length } } : cur,
            )
            onWritten()
          }}
          onStale={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  )
}

function Content({
  pageId,
  agent,
  path,
  data,
  canWrite,
  rootRef,
  onSaved,
  onStale,
}: {
  pageId: string
  agent: string
  path: string
  data: ReadResult
  canWrite: boolean
  rootRef: RefObject<HTMLElement | null>
  onSaved: (text: string, hash: string) => void
  onStale: () => void
}) {
  const codeRef = useRef<HTMLElement>(null)
  const lang = langOfPath(path)
  const quick = useCodeQuick({
    pageId,
    agent,
    path,
    file: { text: data.text, hash: data.hash },
    enabled: canWrite && !data.binary && !data.truncated,
    codeRef,
    rootRef,
    onWritten: onSaved,
    onStale,
  })
  const lineCount = useMemo(() => (data.text ? data.text.split('\n').length - (data.text.endsWith('\n') ? 1 : 0) : 0), [data.text])
  const gutter = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])

  // 写文字 → 画高亮。库还没到（首次要拉 lowlight）时 hydrateCode 自己会等它到了再画一遍
  useLayoutEffect(() => {
    const code = codeRef.current
    if (!code) return
    code.textContent = data.text
    delete code.dataset.hl
    if (code.parentElement) hydrateCode(code.parentElement)
  }, [data.text, lang])

  if (data.binary) return <p className="project-note">{C.binary(sizeLabel(data.size))}</p>
  return (
    <>
      {data.truncated && <p className="project-note is-warn">{C.big(sizeLabel(data.size))}</p>}
      {quick.note && <p className="project-note" role="status">{quick.note}</p>}
      {quick.preview && (
        <div className="project-quick-diff" ref={quick.previewRef} tabIndex={-1}>
          <p className="project-quick-title">
            {quick.preview.selecting ? COPY.quick.code.selectedTitle(quick.preview.count) : COPY.quick.code.previewTitle(quick.preview.count)}
          </p>
          <div className="project-diff">
            {quick.preview.rows.map((l, i) =>
              l.kind === 'hunk' ? (
                <div key={i} className="project-diff-hunk">
                  <span className="project-diff-no" />
                  <span className="project-diff-no" />
                  <span className="project-diff-text">⋯</span>
                </div>
              ) : l.kind === 'note' ? null : (
                <div
                  key={i}
                  className={`project-diff-line is-${l.kind}` + (quick.preview?.selecting && l.new !== undefined && l.new >= quick.preview.range.from && l.new <= quick.preview.range.to ? ' is-picked' : '')}
                >
                  <span className="project-diff-no">{l.old ?? ''}</span>
                  <span className="project-diff-no">{l.new ?? ''}</span>
                  <span className="project-diff-text">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}{l.text}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
      {quick.hint && (
        <button
          type="button"
          className="project-quick-hint"
          style={{ left: quick.hint.left, top: quick.hint.top }}
          title={COPY.quick.code.menuTitle}
          onMouseDown={(e) => e.preventDefault()}
          onClick={quick.open}
        >
          <Icon name="sparkle" size={14} />
          <span>{QUICK_KEY_LABEL}</span>
        </button>
      )}
      {data.text === '' ? (
        <p className="project-note">{C.emptyFile}</p>
      ) : (
        <div className="project-code" tabIndex={0} aria-label={path}>
          <pre className="project-gutter" aria-hidden="true">
            {gutter}
          </pre>
          <pre className="project-source" data-language={lang}>
            <code ref={codeRef} />
          </pre>
        </div>
      )}
      <div className="project-viewer-foot">
        <span>{C.lines(lineCount)}</span>
        <span>{sizeLabel(data.size)}</span>
      </div>
    </>
  )
}
