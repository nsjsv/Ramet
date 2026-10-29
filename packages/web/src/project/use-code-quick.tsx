// 代码查看器里的 ⌘J（随手 AI）：选中几行，在浮层里说想怎么改（或点预设），结果在查看器上方画成就地 diff（原文红、新内容绿）。
// 收下（回车）= 把改写后的整份文件写回机器（POST /project/write，带读到时的 hash，读到之后文件被改过就拒绝），Esc 不要。
// 单次调用，不开 agent 会话、不进对话；落盘只走 write 这一个端点（machine 范围 + 页面可写，连接器那一侧再判一次）。
// 浮层是 editor/quick-popover.ts（纯 DOM，和正文的 ⌘J 同一个），纯文字运算在 code-edit.ts。
// 选区取法：<code> 里的文字等于文件原文（高亮只是给文字套 span），所以选区起点之前的文字长度就是字符偏移。

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ApiError } from '../api'
import { COPY } from '../copy'
import { isQuickKey } from '../editor/quick-keys'
import { QuickPopover, type QuickPreset } from '../editor/quick-popover'
import { needsSettings, quickReadiness, streamQuick, type QuickBody } from '../quick-api'
import { openSettings } from '../settings-bus'
import { CODE_SELECTION_MAX, cleanReplacement, contextAround, previewRows, replaceLines, selectedText, selectionLines, type LineRange } from './code-edit'
import type { DiffLine } from './diff-parse'
import { langOfPath } from './file-tree'
import { errMessage } from './labels'
import { projectApi } from './project-api'

const Q = COPY.quick
const PRESETS: QuickPreset[] = (['concise', 'comment', 'fix'] as const).map((id) => ({ id, label: Q.code.presets[id] }))

/** 浮层锚点用的最小矩形（选区的视口坐标） */
interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

interface Session {
  range: LineRange
  /** 打开时选中行的原文 / 整份文件 / 当时的 hash：收下前核对（文件在生成期间变了就不写） */
  original: string
  snapshot: string
  baseHash: string
  box: Box
  pop: QuickPopover
  ctrl: AbortController | null
  buf: string
  raf: number
  /** 正在写文件：这一步取消不了，Esc / 点外面先忽略 */
  saving: boolean
}

export interface CodeQuickView {
  /** 选区旁「✨ ⌘J」按钮的位置（视口坐标）；没有可改的选区 = null */
  hint: { left: number; top: number } | null
  /** 就地 diff（有会话在跑 / 在等你确认时）；null = 不画。selecting = 还没执行，只是把选中的行标出来（原生选区在焦点进浮层后就没了） */
  preview: { rows: DiffLine[]; count: number; range: LineRange; selecting: boolean } | null
  /** 挂在预览卡上：浮层锚在它旁边 */
  previewRef: RefObject<HTMLDivElement>
  /** 提示（先选中几行再按 ⌘J / 选区太长） */
  note: string
  open: () => void
}

export function useCodeQuick(o: {
  pageId: string
  agent: string
  path: string
  /** 现在显示的文件；没有 hash（二进制 / 太大被截断）= 不能改 */
  file: { text: string; hash: string | undefined }
  /** 有写权 + 面板可见 */
  enabled: boolean
  codeRef: RefObject<HTMLElement | null>
  rootRef: RefObject<HTMLElement | null>
  /** 写成功：新的整份文本与 hash */
  onWritten: (text: string, hash: string) => void
  /** 文件已经不是读到的那一版：让查看器重新读 */
  onStale: () => void
}): CodeQuickView {
  const { path, file, enabled, codeRef, rootRef } = o
  const editable = enabled && file.hash !== undefined && file.text !== ''
  const [sel, setSel] = useState<{ range: LineRange; box: Box } | null>(null)
  const [preview, setPreview] = useState<CodeQuickView['preview']>(null)
  const [note, setNote] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)
  const sess = useRef<Session | null>(null)
  const latest = useRef({ ...o, editable })
  latest.current = { ...o, editable }
  const selRef = useRef(sel)
  selRef.current = sel

  useEffect(() => {
    if (!editable) {
      setSel(null)
      return
    }
    let raf = 0
    const measure = (): void => {
      raf = 0
      if (sess.current) return // 会话期间焦点在浮层里，文档选区会变，别跟着变
      const code = codeRef.current
      const s = document.getSelection()
      if (!code || !s || s.rangeCount === 0 || s.isCollapsed) return setSel(null)
      const range = s.getRangeAt(0)
      if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) return setSel(null)
      const before = document.createRange()
      before.selectNodeContents(code)
      before.setEnd(range.startContainer, range.startOffset)
      const start = before.toString().length
      const lines = selectionLines(file.text, start, start + range.toString().length)
      if (!lines) return setSel(null)
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      const first = rects[0] ?? last
      setSel({ range: lines, box: { left: last.left, right: last.right, top: first.top, bottom: last.bottom } })
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    document.addEventListener('selectionchange', schedule)
    const scroller = codeRef.current?.closest('.project-code')
    scroller?.addEventListener('scroll', schedule)
    return () => {
      document.removeEventListener('selectionchange', schedule)
      scroller?.removeEventListener('scroll', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [editable, file.text, codeRef])

  const close = useCallback((force = false): void => {
    const s = sess.current
    if (!s || (s.saving && !force)) return
    sess.current = null
    s.ctrl?.abort()
    if (s.raf) cancelAnimationFrame(s.raf)
    s.pop.destroy()
    setPreview(null)
  }, [])

  const paint = useCallback((s: Session, final: boolean): void => {
    const replacement = cleanReplacement(s.buf, s.original, !final)
    setPreview({ rows: previewRows(s.snapshot, s.range, replacement, { trim: final }), count: s.range.to - s.range.from + 1, range: s.range, selecting: false })
    s.pop.reposition()
  }, [])

  const run = useCallback(
    (s: Session, instruction: string): void => {
      s.ctrl?.abort()
      const ctrl = new AbortController()
      s.ctrl = ctrl
      s.buf = ''
      const pa = latest.current.path
      const ctx = contextAround(s.snapshot, s.range)
      const language = langOfPath(pa)
      const body: QuickBody = {
        kind: 'code',
        instruction,
        text: ctx.text,
        before: ctx.before,
        after: ctx.after,
        file: { path: pa, ...(language ? { language } : {}) },
      }
      s.pop.setPhase({ kind: 'running' })
      paint(s, false)
      void streamQuick(
        body,
        (d) => {
          if (s.ctrl !== ctrl) return
          s.buf += d
          if (!s.raf) {
            s.raf = requestAnimationFrame(() => {
              s.raf = 0
              if (sess.current === s) paint(s, false)
            })
          }
        },
        ctrl.signal,
      ).then((out) => {
        if (sess.current !== s || s.ctrl !== ctrl) return
        if (!out.ok && out.code === 'aborted') return
        if (s.raf) {
          cancelAnimationFrame(s.raf)
          s.raf = 0
        }
        if (!out.ok) {
          s.buf = ''
          setPreview(null)
          s.pop.setPhase({ kind: 'error', message: out.message, settings: needsSettings(out.code) })
          return
        }
        if (!cleanReplacement(s.buf, s.original)) {
          setPreview(null)
          s.pop.setPhase({ kind: 'error', message: Q.code.noResult })
          return
        }
        paint(s, true)
        s.pop.setPhase({ kind: 'review' })
      })
    },
    [paint],
  )

  const accept = useCallback(
    (s: Session): void => {
      const cur = latest.current
      const replacement = cleanReplacement(s.buf, s.original)
      if (!replacement || s.saving) return
      // 生成期间文件被刷新过（别人 / agent 改了，或者重新读了一遍）：对不上就不写，免得盖掉新的改动
      if (cur.file.text !== s.snapshot || cur.file.hash !== s.baseHash) {
        s.pop.setPhase({ kind: 'error', message: Q.code.stale })
        return
      }
      const next = replaceLines(s.snapshot, s.range, replacement)
      if (next === s.snapshot) {
        close()
        return
      }
      s.saving = true
      s.pop.setPhase({ kind: 'running', text: Q.code.saving })
      projectApi.write(cur.pageId, cur.agent, cur.path, s.baseHash, next).then(
        (res) => {
          s.saving = false
          cur.onWritten(next, res.hash)
          setNote(Q.code.saved)
          close(true)
        },
        (err: unknown) => {
          s.saving = false
          if (sess.current !== s) return
          s.pop.setPhase({ kind: 'error', message: errMessage(err) })
          // 文件已经不是读到的那一版：后台重新读一遍，让用户重新选中再来
          if (err instanceof ApiError && err.code === 'conflict') cur.onStale()
        },
      )
    },
    [close],
  )

  const open = useCallback((): void => {
    const cur = latest.current
    const picked = selRef.current
    if (!cur.editable || !picked || sess.current || cur.file.hash === undefined) return
    const original = selectedText(cur.file.text, picked.range)
    if (original.length > CODE_SELECTION_MAX) {
      setNote(Q.code.tooLong)
      return
    }
    setNote('')
    const box = picked.box
    const pop = new QuickPopover({
      input: true,
      presets: PRESETS,
      placeholder: Q.code.placeholder,
      anchor: () => previewRef.current?.getBoundingClientRect() ?? new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top),
      onRun: (text, preset) => {
        const s = sess.current
        if (s) run(s, preset ? Q.code.presetInstructions[preset.id as keyof typeof Q.code.presetInstructions] : text)
      },
      onAccept: () => {
        const s = sess.current
        if (s) accept(s)
      },
      onClose: () => close(),
      onSettings: () => {
        close()
        openSettings('quick')
      },
    })
    const s: Session = { range: picked.range, original, snapshot: cur.file.text, baseHash: cur.file.hash, box, pop, ctrl: null, buf: '', raf: 0, saving: false }
    sess.current = s
    setSel(null)
    document.getSelection()?.removeAllRanges()
    // 先把选中的行标出来（用"新旧一样"的 diff：全是上下文行，选中的那几行由查看器高亮）
    setPreview({
      rows: previewRows(s.snapshot, s.range, original.replace(/\r\n/g, '\n').replace(/\n$/, ''), { trim: true }),
      count: s.range.to - s.range.from + 1,
      range: s.range,
      selecting: true,
    })
    pop.reposition()
    pop.focus()
    void quickReadiness().then((r) => {
      if (!r.ok && sess.current === s) pop.setPhase({ kind: 'error', message: r.message, settings: true })
    })
  }, [run, accept, close])

  // 换文件 / 面板收起 / 卸载：会话跟着结束（正在写的那一步不取消，让它自己落完）
  useEffect(() => () => close(), [path, editable, close])
  useEffect(() => () => close(true), [close])

  // ⌘J：有可改的选区就开；查看器里没选中东西就提示一句（也别让浏览器的 Ctrl+J 弹出下载页）
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!isQuickKey(e)) return
      if (sess.current) {
        e.preventDefault()
        sess.current.pop.focus()
        return
      }
      const root = rootRef.current
      const inside = root !== null && root.contains(document.activeElement)
      if (selRef.current) {
        e.preventDefault()
        open()
      } else if (inside) {
        e.preventDefault()
        setNote(Q.code.selectFirst)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled, open, rootRef])

  useEffect(() => {
    if (!note) return
    const timer = window.setTimeout(() => setNote(''), 2600)
    return () => window.clearTimeout(timer)
  }, [note])

  return {
    hint: sel && !sess.current ? { left: Math.max(8, Math.min(sel.box.right, window.innerWidth - 84)), top: sel.box.bottom + 6 } : null,
    preview,
    previewRef,
    note,
    open,
  }
}
