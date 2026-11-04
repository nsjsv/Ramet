// ---------- 文件格里的一项：图片画缩略图（点开看大图），别的文件是文件名小块（点了下载） ----------
// 地址同正文里的图片 / 附件：缩略图走 /display（webp 压缩版），看大图复用正文的灯箱，下载固定走源站（?direct=1：
// 图床跨域跳转后 download 指定的文件名会失效）。值里的 id 服务端不核对，取不到的图（连回退到源站也失败）显示「文件不可用」。
import { useState } from 'react'
import type { FileRef } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { openLightbox } from '../../editor/media'
import { directUrl } from '../../file-fallback'
import { Icon } from '../../icons'

const C = COPY.collection.cell.files

export const fileUrl = (id: string): string => `/api/files/${id}`
export const isImage = (file: FileRef): boolean => file.mime.startsWith('image/')
export const downloadUrl = (file: FileRef): string => directUrl(fileUrl(file.id)) ?? fileUrl(file.id)

/** interactive = false（编辑弹层里）：只是预览，不响应点击 */
export function FileItem({ file, interactive = true }: { file: FileRef; interactive?: boolean }) {
  // 第一次失败是图床那头（file-fallback 会换成源站地址重试），第二次才是真取不到
  const [errors, setErrors] = useState(0)
  const broken = errors >= 2
  if (isImage(file) && !broken) {
    const img = <img src={`${fileUrl(file.id)}/display`} alt={file.name} loading="lazy" draggable={false} onError={() => setErrors((n) => n + 1)} />
    return interactive ? (
      <button
        type="button"
        className="cl-file-thumb"
        data-tip={file.name}
        onClick={(e) => {
          e.stopPropagation()
          openLightbox(fileUrl(file.id))
        }}
      >
        {img}
      </button>
    ) : (
      <span className="cl-file-thumb">{img}</span>
    )
  }
  const body = (
    <>
      <Icon name="paperclip" size={12} />
      <span className="cl-file-name">{file.name || C.unavailable}</span>
    </>
  )
  if (broken || !interactive) {
    return (
      <span className={'cl-file-chip' + (broken ? ' is-broken' : '')} data-tip={broken ? C.unavailable : file.name}>
        {body}
      </span>
    )
  }
  return (
    <a className="cl-file-chip" href={downloadUrl(file)} download={file.name} data-tip={file.name} onClick={(e) => e.stopPropagation()}>
      {body}
    </a>
  )
}
