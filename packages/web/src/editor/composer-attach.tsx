/* ---------- 输入框里的图片附件（截图直接给模型看）+ 托盘 ----------
 * 粘贴 / 拖入图片：先以本地预览插进输入框（光标 / 落点处，composer-input.tsx 的 insertImage），同时上传（media.ts 的 uploadFile），
 * 传完 patchImage 换上正式地址。图片就是输入框正文的一部分：发送时随记号落在消息原位，服务端按出现顺序把它们作为图片块发给能收图的 agent。
 * 上传中不能发送；失败的标红、不随消息发出；一条消息至多 MAX_ATTACH 张（服务端也只带这么多）。
 * 托盘（摆法 tray，attach-layout.ts）把附件排成卡片放在输入卡上方，卡片与 A 摆法下气泡上方的是同一份（att-cards.ts）。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { attCard, attKey, attLabels, type AttItem } from './att-cards'
import type { ComposerInputHandle } from './composer-input'
import { uploadFile } from './media'

export const MAX_ATTACH = 4

const C = {
  failed: '上传失败',
  tooMany: (n: number) => `一条消息最多带 ${n} 张图`,
}

type Result = { src: string; preview: string } | { failed: true }

let seq = 0

export function useAttachments(composer: RefObject<ComposerInputHandle | null>, onError: (message: string) => void) {
  const [items, setItems] = useState<AttItem[]>([])
  const live = useRef(items)
  // 上传结果按 key 记着：撤销后再重做，图会以上传前的样子回来，见到就补上
  const done = useRef(new Map<string, Result>())
  // 本地预览：失败的图一直显示它，卸载时统一回收（传成功的当场回收）
  const blobs = useRef(new Set<string>())
  useEffect(() => {
    const own = blobs.current
    return () => own.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const add = useCallback(
    (files: File[], at?: number) => {
      const room = MAX_ATTACH - live.current.filter((a) => a.kind === 'image').length
      if (files.length > room) onError(C.tooMany(MAX_ATTACH))
      files.slice(0, Math.max(0, room)).forEach((file, i) => {
        const key = `a${++seq}`
        const preview = URL.createObjectURL(file)
        blobs.current.add(preview)
        // 落点只给第一张：插完光标落在它后面，后面几张顺着接
        composer.current?.insertImage(key, preview, i === 0 ? at : undefined)
        const settle = (result: Result): void => {
          done.current.set(key, result)
          composer.current?.patchImage(key, result)
        }
        uploadFile(file).then(
          (meta) => {
            settle({ src: meta.url, preview: meta.display })
            blobs.current.delete(preview)
            URL.revokeObjectURL(preview)
          },
          (err: unknown) => {
            settle({ failed: true })
            onError(err instanceof Error ? err.message : C.failed)
          },
        )
      })
    },
    [composer, onError],
  )

  /** 输入框报来的附件清单（ComposerInput 的 onAtts） */
  const onAtts = useCallback(
    (next: AttItem[]) => {
      live.current = next
      setItems(next)
      const stale = next.flatMap((a) => (a.kind === 'image' && a.state === 'uploading' && done.current.has(a.key) ? [a.key] : []))
      // 正在派发事务的途中，不能再派发：下一个微任务补
      if (stale.length) queueMicrotask(() => stale.forEach((key) => composer.current?.patchImage(key, done.current.get(key)!)))
    },
    [composer],
  )

  return { items, add, onAtts, uploading: items.some((a) => a.kind === 'image' && a.state === 'uploading') }
}

/** 托盘：输入卡上方一排卡片，第 i 张对应框里第 i 个附件（悬停联动见 att-hover.ts）。
 *  卡片是纯 DOM（与气泡上方同一份），按身份复用：没变的卡片不重建，入场动画只给新来的 */
export function AttachTray({ items, onRemove }: { items: AttItem[]; onRemove: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const remove = useRef(onRemove)
  remove.current = onRemove

  useLayoutEffect(() => {
    const host = ref.current
    if (!host) {
      cards.current.clear()
      return
    }
    const labels = attLabels(items)
    const seen = new Map<string, number>()
    const next = new Map<string, HTMLElement>()
    const els = items.map((item, i) => {
      const base = attKey(item, labels[i]!)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      const key = `${base}#${n}` // 同一个文件引用两次：两张卡
      let card = cards.current.get(key)
      if (!card) {
        const el = attCard(item, labels[i]!, () => remove.current([...host.children].indexOf(el)))
        el.classList.add('is-new')
        el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true })
        card = el
      }
      next.set(key, card)
      return card
    })
    cards.current = next
    host.replaceChildren(...els)
  }, [items])

  if (items.length === 0) return null
  return <div className="att-tray" ref={ref} />
}
