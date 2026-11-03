// ---------- 画廊的一张卡片：预览区 + 看板卡片 ----------
// 卡片本体（标题、属性、就地编辑、多选、拖动、「打开」按钮）就是看板卡片 BoardCard，这里只多画顶上的预览：
// 页面封面 / 文件属性的第一张图 / 占位（行图标放大居中，没图标只有浅底）；视图设成不显示就没有这一块（gallery-model 的 previewOf）。
// 预览区高 = 宽 × 0.6（CSS aspect-ratio），图按 object-fit: cover 裁，页面封面带着它的垂直位置。
import { useState, type ComponentProps } from 'react'
import type { RowIcon } from '@ramet/shared/collection-model'
import { coverSrc } from '../../PageCover'
import { PageIcon } from '../../PageIcon'
import BoardCard from '../board/BoardCard'
import type { Preview } from './gallery-model'

type Props = Omit<ComponentProps<typeof BoardCard>, 'preview'> & { preview: Preview | null }

type Image = { src: string; y: number; external: boolean }

function imageOf(preview: Preview): Image | null {
  if (preview.kind === 'cover') return { src: coverSrc(preview.cover), y: preview.cover.y, external: preview.cover.kind === 'url' }
  if (preview.kind === 'file') return { src: `/api/files/${preview.file.id}/display`, y: 50, external: false }
  return null
}

function Placeholder({ icon }: { icon: RowIcon }) {
  return <span className="cl-card-placeholder">{icon && <PageIcon icon={icon} size="lg" />}</span>
}

function PreviewImage({ image, icon }: { image: Image; icon: RowIcon }) {
  const [errors, setErrors] = useState(0)
  // 站内文件第一次失败是图床那头（file-fallback 换成源站地址重试），第二次才是真取不到；外链 / 预设图失败一次就是
  if (errors >= (image.src.startsWith('/api/files/') ? 2 : 1)) return <Placeholder icon={icon} />
  return (
    <img
      src={image.src}
      alt=""
      loading="lazy"
      decoding="async"
      // 整张卡片可拖：图片自己的拖动会抢走它（拖出去的是这张图）
      draggable={false}
      // 外链不把本站页面地址带给第三方，也绕开按 Referer 的防盗链（同页面封面）
      referrerPolicy={image.external ? 'no-referrer' : undefined}
      style={{ objectPosition: `center ${image.y}%` }}
      onError={() => setErrors((n) => n + 1)}
    />
  )
}

export default function GalleryCard({ preview, ...card }: Props) {
  const image = preview ? imageOf(preview) : null
  const body = preview && (
    <div className="cl-card-preview">
      {/* 换了图就重新挂载：上一张的失败次数不带过来 */}
      {image ? <PreviewImage key={image.src} image={image} icon={card.row.icon} /> : <Placeholder icon={card.row.icon} />}
    </div>
  )
  return <BoardCard {...card} preview={body} />
}
