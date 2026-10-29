/* ---------- 输入卡的图片附件（截图直接给模型看）----------
 * 输入框里粘贴 / 拖入图片后立刻上传（media.ts 的 uploadFile），输入框上方显示一排可删的缩略图。
 * 发送时附件随消息写进文档（消息末尾一段图片，agent-bar 的 appendUserMessage），服务端把它们作为图片块发给能收图的 agent。
 * 上传中不能发送；一条消息至多 MAX_ATTACH 张（服务端也只带这么多）。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { uploadFile } from './media'

export const MAX_ATTACH = 4

const C = {
  remove: '移除这张图',
  uploading: '上传中…',
  failed: '上传失败',
  tooMany: (n: number) => `一条消息最多带 ${n} 张图`,
}

export type Attachment = {
  key: string
  /** 本地预览（object URL），发送 / 移除时回收 */
  preview: string
  /** 上传完成后的地址（`/api/files/<id>`），没有表示还在传或失败了 */
  url?: string
  failed?: boolean
}

let seq = 0

export function useAttachments(onError: (message: string) => void) {
  const [items, setItems] = useState<Attachment[]>([])
  const live = useRef(items)
  live.current = items
  // 组件卸载时回收还没发出去的本地预览
  useEffect(() => () => live.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  const add = useCallback(
    (files: File[]) => {
      const room = MAX_ATTACH - live.current.length
      if (files.length > room) onError(C.tooMany(MAX_ATTACH))
      for (const file of files.slice(0, Math.max(0, room))) {
        const key = `a${++seq}`
        setItems((prev) => [...prev, { key, preview: URL.createObjectURL(file) }])
        uploadFile(file).then(
          (meta) => setItems((prev) => prev.map((a) => (a.key === key ? { ...a, url: meta.url } : a))),
          (err: unknown) => {
            setItems((prev) => prev.map((a) => (a.key === key ? { ...a, failed: true } : a)))
            onError(err instanceof Error ? err.message : C.failed)
          },
        )
      }
    },
    [onError],
  )

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const hit = prev.find((a) => a.key === key)
      if (hit) URL.revokeObjectURL(hit.preview)
      return prev.filter((a) => a.key !== key)
    })
  }, [])

  /** 撤回的排队消息：已上传的图回到附件（预览用展示版） */
  const restore = useCallback((urls: string[]) => {
    setItems((prev) => [...prev, ...urls.slice(0, Math.max(0, MAX_ATTACH - prev.length)).map((url) => ({ key: `a${++seq}`, preview: `${url}/display`, url }))])
  }, [])

  /** 发送后清空，返回上传好的地址（失败的丢掉） */
  const take = useCallback((): string[] => {
    const urls = live.current.flatMap((a) => (a.url ? [a.url] : []))
    live.current.forEach((a) => URL.revokeObjectURL(a.preview))
    setItems([])
    return urls
  }, [])

  return { items, add, remove, restore, take, uploading: items.some((a) => !a.url && !a.failed) }
}

export function AttachStrip({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null
  return (
    <div className="chat-attach">
      {items.map((a) => (
        <div key={a.key} className={`chat-attach-item${a.url ? '' : a.failed ? ' is-failed' : ' is-uploading'}`} title={a.failed ? C.failed : a.url ? '' : C.uploading}>
          <img src={a.preview} alt="" />
          <button type="button" className="chat-attach-x" onClick={() => onRemove(a.key)} aria-label={C.remove} title={C.remove}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
