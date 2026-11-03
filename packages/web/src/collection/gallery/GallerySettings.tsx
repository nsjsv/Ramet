// ---------- 画廊的专属设置（视图设置弹层里，接在「布局」后面）：卡片预览、卡片大小 ----------
// 写集合文档（所有成员同一份，同筛选排序）；点的就是当前值不写（schema-ops 里同值不写，免得白出一个集合页版本）。
// 预览可选页面封面、每个「文件与媒体」属性（取第一张图片）、不显示。
import type * as Y from 'yjs'
import { CARD_SIZES, COVER_NONE, COVER_PAGE, type CollectionSchema, type CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { TYPE_ICON } from '../prop-meta'
import { setCardSize, setViewCover } from '../schema-ops'

const C = COPY.collection

const check = <Icon name="check" size={14} className="cl-picker-check" />

export default function GallerySettings({ doc, schema, view }: { doc: Y.Doc; schema: CollectionSchema; view: CollectionView }) {
  const files = schema.props.filter((p) => p.type === 'files')
  return (
    <>
      <div className="pop-section">{C.views.cover}</div>
      <button type="button" className="pop-row" onClick={() => setViewCover(doc, view.id, COVER_PAGE)}>
        <Icon name="image" size={14} />
        {C.views.coverPage}
        {view.cover === COVER_PAGE && check}
      </button>
      {files.map((p) => (
        <button key={p.id} type="button" className="pop-row" onClick={() => setViewCover(doc, view.id, p.id)}>
          <Icon name={TYPE_ICON[p.type]} size={14} />
          {p.name || C.types[p.type]}
          {view.cover === p.id && check}
        </button>
      ))}
      <button type="button" className="pop-row" onClick={() => setViewCover(doc, view.id, COVER_NONE)}>
        <Icon name="eye-off" size={14} />
        {C.views.coverNone}
        {view.cover === COVER_NONE && check}
      </button>
      <div className="pop-section">{C.views.cardSize}</div>
      {CARD_SIZES.map((size) => (
        <button key={size} type="button" className="pop-row" onClick={() => setCardSize(doc, view.id, size)}>
          {C.views.cardSizes[size]}
          {view.cardSize === size && check}
        </button>
      ))}
    </>
  )
}
