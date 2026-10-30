/* ---------- 页面图标：唯一渲染组件 + 编辑器标题上方的设置入口 ----------
 *
 * 展示：emoji 渲染成自托管的 Twemoji SVG（emoji.ts；缺图时退回文本字符）；图片图标只有一个读入口
 * /api/files/:id/icon（服务端方形 160px webp 派生版，immutable 缓存）。全站所有出现页面的位置都用
 * 这一个组件，URL 拼接与 kind 判别不散到各调用点。
 *
 * 设置：PageIconHeader = 标题上方的「＋ 图标 / 图标」触发器 + 弹层（emoji-mart 选择器、
 * 粘贴任意 emoji、上传图片、移除）。提交后 onChanged() 重拉页面列表，侧栏 / 面包屑 / 标签标题
 * 与编辑器内 page_ref 块都从这一份数据源跟着更新（多端由服务端广播驱动）。 */

import { useEffect, useRef, useState } from 'react'
import { api, type PageIcon as PageIconValue } from './api'
import { uploadFile } from './editor/media'
import { twemojiUrl } from './emoji'
import { EmojiPicker } from './EmojiPicker'
import { COVER_COPY } from './covers'
import { Icon } from './icons'

/** 服务端校验的同一上限（码点）——这里只做交互先行提示，真闸门在服务端 */
const EMOJI_MAX_CODE_POINTS = 8

/** 图片图标的展示地址：唯一入口，组件外不要另拼 */
export function pageIconSrc(fileId: string): string {
  return `/api/files/${fileId}/icon`
}

export function PageIcon({
  icon,
  size = 'sm',
  placeholder = false,
  className,
}: {
  icon: PageIconValue | null
  /** sm = 列表/面包屑 18px；lg = 标题上方 56px */
  size?: 'sm' | 'lg'
  /** 无图标时画通用文档 glyph（列表类入口用它保持列宽恒定，标题处不用） */
  placeholder?: boolean
  className?: string
}) {
  const base = `page-icon page-icon-${size}${className ? ` ${className}` : ''}`
  if (!icon) return placeholder ? <span className={`${base} page-icon-glyph`} aria-hidden="true" /> : null
  return icon.kind === 'emoji' ? (
    <EmojiIcon key={icon.value} value={icon.value} base={base} />
  ) : (
    <img className={`${base} page-icon-img`} src={pageIconSrc(icon.value)} alt="" loading="lazy" decoding="async" />
  )
}

/** emoji 图标：Twemoji SVG。Twemoji 15 没有的新 emoji（404）退回文本字符，不留破图。
 * 调用处以 value 作 key：换 emoji 时重新挂载，上一个的失败态不会留下来 */
function EmojiIcon({ value, base }: { value: string; base: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span className={`${base} page-icon-emoji`} aria-hidden="true">
      {value}
    </span>
  ) : (
    <img
      className={`${base} page-icon-img page-icon-twemoji`}
      src={twemojiUrl(value)}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

/** 编辑器标题上方的图标位：只读（viewer）时退化为纯展示 */
export function PageIconHeader({
  pageId,
  icon,
  readOnly,
  onChanged,
  onAddCover,
}: {
  pageId: string
  icon: PageIconValue | null
  readOnly: boolean
  onChanged: () => void
  /** 页面还没有封面时给：同一行出「＋ 封面」幽灵按钮 */
  onAddCover?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 换页关弹层：icon/error 都是上一页的遗留态
  useEffect(() => {
    setOpen(false)
    setError(null)
    setDraft('')
  }, [pageId])

  // 点弹层外收起（与侧栏搜索同款）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function apply(next: PageIconValue | null): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.setPageIcon(pageId, next)
      setOpen(false)
      setDraft('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '图标保存失败')
    } finally {
      setBusy(false)
    }
  }

  function submitEmoji(): void {
    const value = draft.trim()
    if (!value) return
    if ([...value].length > EMOJI_MAX_CODE_POINTS) {
      setError(`最多 ${EMOJI_MAX_CODE_POINTS} 个字符`)
      return
    }
    void apply({ kind: 'emoji', value })
  }

  async function submitImage(file: File): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      // 复用附件同一条上传链路（10MB 闸门、查重、原图直传都在那里）
      const meta = await uploadFile(file)
      await api.setPageIcon(pageId, { kind: 'image', value: meta.id })
      setOpen(false)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片上传失败')
    } finally {
      setBusy(false)
    }
  }

  if (readOnly) {
    return icon ? (
      <div className="icon-header has-icon">
        <span className="icon-header-static">
          <PageIcon icon={icon} size="lg" />
        </span>
      </div>
    ) : null
  }

  return (
    <div className={'icon-header' + (icon ? ' has-icon' : '')} ref={boxRef}>
      <button
        type="button"
        className={'icon-header-trigger' + (icon ? ' has-icon' : '')}
        title={icon ? '更换图标' : '添加图标'}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
      >
        {icon ? <PageIcon icon={icon} size="lg" /> : <span className="icon-header-add"><Icon name="plus" size={14} /> 图标</span>}
      </button>
      {onAddCover && (
        <button type="button" className="icon-header-trigger icon-header-cover" title={COVER_COPY.addTitle} onClick={onAddCover}>
          <span className="icon-header-add">
            <Icon name="plus" size={14} /> {COVER_COPY.add}
          </span>
        </button>
      )}
      {open && (
        <div className="icon-picker-pop" role="dialog" aria-label="页面图标">
          <EmojiPicker onPick={(emoji) => !busy && void apply({ kind: 'emoji', value: emoji })} />
          <div className="icon-picker-row">
            <input
              className="icon-picker-input"
              placeholder="粘贴任意 emoji"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitEmoji()
              }}
            />
            <button type="button" className="icon-picker-btn" disabled={busy || !draft.trim()} onClick={submitEmoji}>
              使用
            </button>
          </div>
          <div className="icon-picker-row">
            <button
              type="button"
              className="icon-picker-btn"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              上传图片
            </button>
            {icon && (
              <button
                type="button"
                className="icon-picker-btn danger"
                disabled={busy}
                onClick={() => void apply(null)}
              >
                移除图标
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // 允许重复选同一张
                if (file) void submitImage(file)
              }}
            />
          </div>
          {error && <div className="icon-picker-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
