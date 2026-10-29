import { COPY } from '../copy'
import { Icon } from '../icons'
import { errMessage } from './labels'
import { openPreviewTab, previewLabel, type PreviewItem } from './preview-api'

const C = COPY.project.preview

/** 一条共享中的预览：地址、谁共享的、查看 / 新标签打开 / 停止。panel 里的预览分页和顶栏的「预览」弹层共用 */
export default function PreviewRow({
  item,
  on = false,
  onView,
  onStop,
  pageId,
  onError,
}: {
  item: PreviewItem
  on?: boolean
  onView?: () => void
  onStop?: () => void
  pageId: string
  onError: (message: string) => void
}) {
  return (
    <li className={'preview-row' + (on ? ' is-on' : '')}>
      <div className="preview-row-main">
        <span className="preview-target">{previewLabel(item)}</span>
        <span className="preview-meta">
          {item.mine ? C.mine : C.by(item.shared_by)}
          {!item.online && ` · ${C.offline}`}
        </span>
      </div>
      <div className="preview-row-actions">
        {onView && (
          <button type="button" className="project-chip-btn" onClick={onView}>
            {C.view}
          </button>
        )}
        <button
          type="button"
          className="project-icon-btn"
          title={C.openTab}
          aria-label={`${C.openTab}：${previewLabel(item)}`}
          onClick={() => void openPreviewTab(pageId, item.id).catch((err: unknown) => onError(errMessage(err)))}
        >
          <Icon name="external" size={14} />
        </button>
        {onStop && item.can_stop && (
          <button type="button" className="project-chip-btn" onClick={onStop}>
            {C.stop}
          </button>
        )}
      </div>
    </li>
  )
}
