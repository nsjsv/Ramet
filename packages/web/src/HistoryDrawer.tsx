import { useCallback, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import UpdatesFeed from './UpdatesFeed'
import VersionHistory, { type RowHistory } from './VersionHistory'
import CollectionHistory from './collection/CollectionHistory'
import { Icon } from './icons'

type Base = {
  pageId: string
  /** viewer：历史版本 Tab 隐藏恢复/存版入口（服务端 POST 本就 403，这里只锁入口） */
  readOnly: boolean
  /** 当前登录用户名：更新条目里自己的操作显示「你」 */
  username: string
  onClose: () => void
}

/** 两种形态：文档页（含集合的行，row 给了就带属性）与集合页（history: 'collection'：没有正文，版本是属性定义、视图与名称） */
type Props = Base &
  (
    | {
        history?: 'doc'
        /** 仅用于取正文视图的 schema（解码快照用）；恢复由 EditorPage 对两个视图 dispatch */
        getViews: () => { body: EditorView | undefined; title: EditorView | undefined }
        onRestore: (body: ProsemirrorNode, title: ProsemirrorNode, props?: Record<string, unknown>) => void
        onRestoreBlock: (node: ProsemirrorNode, afterId: string | null) => boolean
        /** 集合的行页面：版本预览 / 恢复带属性，「更新」里的属性项按集合当前定义显示 */
        row?: RowHistory | null
      }
    | {
        history: 'collection'
        /** 写回集合页：snapshot = 那个版本 Y.Map('collection') 的 JSON，title = 那个版本的标题 */
        onRestoreCollection: (snapshot: unknown, title: ProsemirrorNode) => void
      }
  )

/** 右侧抽屉壳：头部「更新 | 历史版本」Tab + 关闭按钮；内容面板按 Tab 二选一挂载，切换即重拉 */
export default function HistoryDrawer(props: Props) {
  const { pageId, readOnly, username, onClose } = props
  const [tab, setTab] = useState<'updates' | 'history'>('updates')
  // 更新条目时钟 → 记目标快照并切 Tab；历史面板选中后经 onJumped 复位，避免下次打开重复跳
  const [jumpSnapshotId, setJumpSnapshotId] = useState<string | null>(null)
  const handleJump = useCallback((id: string) => {
    setJumpSnapshotId(id)
    setTab('history')
  }, [])
  const handleJumped = useCallback(() => setJumpSnapshotId(null), [])
  const row = props.history === 'collection' ? null : (props.row ?? null)

  let body
  if (tab === 'updates') {
    body = (
      <UpdatesFeed
        pageId={pageId}
        username={username}
        onJump={handleJump}
        collectionId={row?.collectionId ?? null}
        spaceId={row?.spaceId ?? null}
      />
    )
  } else if (props.history === 'collection') {
    body = (
      <CollectionHistory
        pageId={pageId}
        readOnly={readOnly}
        onClose={onClose}
        onRestore={props.onRestoreCollection}
        jumpToId={jumpSnapshotId}
        onJumped={handleJumped}
      />
    )
  } else {
    body = (
      <VersionHistory
        pageId={pageId}
        readOnly={readOnly}
        getViews={props.getViews}
        onClose={onClose}
        onRestore={props.onRestore}
        onRestoreBlock={props.onRestoreBlock}
        row={row}
        jumpToId={jumpSnapshotId}
        onJumped={handleJumped}
      />
    )
  }

  return (
    <aside className="hd-drawer">
      <div className="vh-header">
        <div className="hd-tabs">
          <button
            type="button"
            className={`hd-tab${tab === 'updates' ? ' active' : ''}`}
            onClick={() => setTab('updates')}
          >
            更新
          </button>
          <button
            type="button"
            className={`hd-tab${tab === 'history' ? ' active' : ''}`}
            onClick={() => setTab('history')}
          >
            历史版本
          </button>
        </div>
        <button type="button" className="vh-close" onClick={onClose} aria-label="关闭">
          <Icon name="x" size={16} />
        </button>
      </div>
      {body}
    </aside>
  )
}
