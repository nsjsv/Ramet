/* ---------- 页面封面：标题上方的横幅 ----------
 *
 * 展示：铺满内容区宽度的一张图，object-fit: cover，垂直位置 = cover.y%。地址只由 coverSrc 拼：
 * 上传图走 /api/files/:id/display（webp 展示版，可能 302 到图床，失败由全局 file-fallback.ts 回退源站），
 * 预设图走静态资源，外链原样（no-referrer：不把本站页面地址带给第三方，也绕开按 Referer 的防盗链）。
 * 外链挂了只剩封面底色，操作按钮还在，可以直接换掉。
 *
 * 编辑（readOnly 时一概不渲染）：悬停出「更换封面 / 调整位置 / 移除」。
 * - 更换：弹层分图库 / 上传 / 链接三栏；
 * - 调整位置：进入拖动态，上下拖图改 y，「保存位置」才提交，「取消」还原；
 * 提交前先本地显示新值（乐观），失败还原并提示；之后由 onChanged 重拉的页面列表接管。 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api, type PageCover as PageCoverValue } from './api'
import { COVER_COPY as C, COVER_PRESETS, presetSrc, presetThumb, randomPreset } from './covers'
import { uploadFile } from './editor/media'

/** 封面的展示地址：唯一拼接处 */
export function coverSrc(cover: PageCoverValue): string {
  if (cover.kind === 'file') return `/api/files/${cover.value}/display`
  if (cover.kind === 'preset') return presetSrc(cover.value)
  return cover.value
}

/** 「添加封面」：先随机放一张预设图（与 Notion 同），想换再从封面上的「更换封面」挑 */
export async function addRandomCover(pageId: string): Promise<void> {
  await api.setPageCover(pageId, { kind: 'preset', value: randomPreset().name, y: 50 })
}

const clamp = (v: number): number => Math.min(100, Math.max(0, v))
const sameCover = (a: PageCoverValue | null, b: PageCoverValue | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.value === b.value && a.y === b.y)

export function PageCover({
  pageId,
  cover,
  readOnly,
  onChanged,
}: {
  pageId?: string
  cover: PageCoverValue | null
  readOnly: boolean
  onChanged?: () => void
}) {
  // 乐观值：提交后、页面列表重拉回来之前先显示它；服务端数据一变就让位
  const [local, setLocal] = useState<PageCoverValue | null | undefined>(undefined)
  const [picker, setPicker] = useState(false)
  const [dragY, setDragY] = useState<number | null>(null) // 非 null = 正在调整位置
  const [error, setError] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startPos: number } | null>(null)

  const shown = local !== undefined ? local : cover
  const src = shown ? coverSrc(shown) : ''

  useEffect(() => {
    setLocal(undefined)
  }, [cover?.kind, cover?.value, cover?.y])

  // 换页：乐观值、弹层、拖动态、错误都是上一页的
  useEffect(() => {
    setLocal(undefined)
    setPicker(false)
    setDragY(null)
    setError(null)
  }, [pageId])

  useEffect(() => setBroken(false), [src])

  async function apply(next: PageCoverValue | null): Promise<void> {
    if (!pageId) return
    const prev = shown
    if (sameCover(prev, next)) return
    setLocal(next)
    setError(null)
    try {
      await api.setPageCover(pageId, next)
      onChanged?.()
    } catch (err) {
      setLocal(prev)
      setError(err instanceof Error && err.message ? err.message : C.saveFailed)
    }
  }

  if (!shown) return null

  const y = dragY ?? shown.y
  const editable = !readOnly && !!pageId

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (dragY === null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startPos: dragY }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current
    const img = imgRef.current
    const box = boxRef.current
    if (!d || !img || !box || !img.naturalWidth) return
    // object-fit: cover 的缩放比取宽高两者里大的那个；图片比框高出的部分才是能上下挪的余量
    const scale = Math.max(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight)
    const overflow = img.naturalHeight * scale - box.clientHeight
    if (overflow <= 0) return
    // 往下拖 = 想看图的更上面一截 = y 变小
    setDragY(clamp(d.startPos - ((e.clientY - d.startY) / overflow) * 100))
  }

  function onPointerUp(): void {
    drag.current = null
  }

  return (
    <div className={'page-cover-wrap' + (dragY !== null ? ' is-repositioning' : '')}>
      <div
        className="page-cover"
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {!broken && (
          <img
            key={src}
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            referrerPolicy={shown.kind === 'url' ? 'no-referrer' : undefined}
            style={{ objectPosition: `center ${y}%` }}
            onError={() => {
              // 站内文件交给 file-fallback（图床失败换源站地址重试，它在 window 捕获阶段先于这里改 src）；
              // 外链 / 预设坏了就只留底色
              if (shown.kind !== 'file') setBroken(true)
            }}
          />
        )}
        {dragY !== null && <div className="page-cover-hint">{C.dragHint}</div>}
      </div>
      {editable && (
        <div className="page-cover-actions">
          {dragY !== null ? (
            <>
              <button
                type="button"
                className="page-cover-btn"
                onClick={() => {
                  const next = { ...shown, y: Math.round(dragY * 10) / 10 }
                  setDragY(null)
                  void apply(next)
                }}
              >
                {C.savePosition}
              </button>
              <button type="button" className="page-cover-btn" onClick={() => setDragY(null)}>
                {C.cancel}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="page-cover-btn" onClick={() => setPicker((v) => !v)}>
                {C.change}
              </button>
              {!broken && (
                <button type="button" className="page-cover-btn" onClick={() => setDragY(shown.y)}>
                  {C.reposition}
                </button>
              )}
              <button type="button" className="page-cover-btn" onClick={() => void apply(null)}>
                {C.remove}
              </button>
            </>
          )}
        </div>
      )}
      {editable && error && <div className="page-cover-error">{error}</div>}
      {editable && picker && <CoverPicker onClose={() => setPicker(false)} onPick={(next) => void apply(next)} />}
    </div>
  )
}

type Tab = 'gallery' | 'upload' | 'link'

function CoverPicker({ onPick, onClose }: { onPick: (cover: PageCoverValue) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('gallery')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 点弹层外 / Esc 收起（与图标弹层同款）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      // 点「更换封面」按钮本身交给按钮的开关逻辑，否则这里先关、按钮又打开
      if (!boxRef.current?.contains(target) && !target?.closest?.('.page-cover-actions')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function pick(cover: PageCoverValue): void {
    onPick(cover)
    onClose()
  }

  async function upload(file: File): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      // 与附件 / 图标同一条上传链路（10MB 闸门、查重、图床镜像都在那里）
      const meta = await uploadFile(file)
      pick({ kind: 'file', value: meta.id, y: 50 })
    } catch (err) {
      setError(err instanceof Error ? err.message : C.saveFailed)
    } finally {
      setBusy(false)
    }
  }

  function submitLink(): void {
    const value = link.trim()
    let ok = false
    try {
      const url = new URL(value)
      ok = url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) {
      setError(C.linkInvalid)
      return
    }
    pick({ kind: 'url', value, y: 50 })
  }

  const tabs: [Tab, string][] = [
    ['gallery', C.tabGallery],
    ['upload', C.tabUpload],
    ['link', C.tabLink],
  ]

  return (
    <div className="cover-picker" ref={boxRef} role="dialog" aria-label={C.change}>
      <div className="cover-picker-tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={'cover-picker-tab' + (tab === key ? ' is-active' : '')}
            onClick={() => {
              setTab(key)
              setError(null)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'gallery' && (
        <div className="cover-picker-grid">
          {COVER_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="cover-picker-item"
              title={p.title}
              onClick={() => pick({ kind: 'preset', value: p.name, y: 50 })}
            >
              <img src={presetThumb(p.name)} alt={p.title} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      {tab === 'upload' && (
        <div className="cover-picker-pane">
          <button type="button" className="icon-picker-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? C.uploading : C.uploadPick}
          </button>
          <div className="cover-picker-hint">{C.uploadHint}</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // 允许重复选同一张
              if (file) void upload(file)
            }}
          />
        </div>
      )}
      {tab === 'link' && (
        <div className="cover-picker-pane icon-picker-row">
          <input
            className="icon-picker-input"
            type="url"
            placeholder={C.linkPlaceholder}
            value={link}
            spellCheck={false}
            autoFocus
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitLink()
            }}
          />
          <button type="button" className="icon-picker-btn" disabled={!link.trim()} onClick={submitLink}>
            {C.linkSubmit}
          </button>
        </div>
      )}
      {error && <div className="icon-picker-error">{error}</div>}
    </div>
  )
}
