/* ---------- 评论抽屉（右侧，外壳同历史抽屉 .hd-drawer）----------
 * 列出本页全部讨论串（划词 + 整页），分「未解决 / 已解决」。每行是引用原文（整页讨论标「整页讨论」）+ 首条摘要；
 * 划词串点了滚到正文锚点并弹浮层；整页讨论与「原文已删除」的串在抽屉里就地展开。 */

import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { relativeTime } from '../UpdatesFeed'
import { commentRange, scrollToAnchor } from './comment-anchor'
import CommentThread, { type CommentCtx } from './CommentThread'
import type { Thread } from './comments-api'
import { closeDrawer, expandThread, openThread } from './comments-store'

const C = COPY.comments

/** 摘要里的 @ 记号只留名字 */
const plain = (body: string): string => body.replace(/@\[([^\n]*?)\]\(user:[A-Za-z0-9_-]{1,64}\)/g, '@$1')

function Row({ thread, orphan, expanded, ctx, getView }: { thread: Thread; orphan: boolean; expanded: boolean; ctx: CommentCtx; getView: () => EditorView | undefined }) {
  const first = thread.comments[0]
  const replies = Math.max(0, thread.comments.length - 1)
  const inline = thread.kind === 'inline' && !!thread.anchor
  const open = (): void => {
    const view = getView()
    if (inline && !orphan && view && thread.anchor && scrollToAnchor(view, thread.anchor)) openThread(thread.id)
    else expandThread(expanded ? null : thread.id)
  }
  return (
    <li className={'cm-row' + (expanded ? ' is-open' : '')}>
      <button type="button" className="cm-row-head" aria-expanded={expanded} onClick={open}>
        {inline ? (
          <span className="cm-quote">
            {orphan && <span className="cm-orphan">{C.orphan}</span>}
            {thread.anchor?.text}
          </span>
        ) : (
          <span className="cm-row-kind">{C.pageThread}</span>
        )}
        <span className="cm-row-excerpt">
          <b>{first?.author?.name ?? C.deletedUser}</b> {first?.deleted ? C.deleted : plain(first?.body ?? '')}
        </span>
        <span className="cm-row-meta">
          {relativeTime(first?.createdAt ?? thread.createdAt)}
          {replies > 0 && ` · ${C.replies(replies)}`}
        </span>
      </button>
      {expanded && <CommentThread thread={thread} ctx={ctx} />}
    </li>
  )
}

export default function CommentsDrawer({ threads, expanded, ctx, getView }: { threads: Thread[]; expanded: string | null; ctx: CommentCtx; getView: () => EditorView | undefined }) {
  const view = getView()
  const orphanOf = (t: Thread): boolean => t.kind === 'inline' && !!t.anchor && !!view && !commentRange(view, t.anchor)
  const open = threads.filter((t) => !t.resolvedAt)
  const done = threads.filter((t) => t.resolvedAt)
  const group = (title: string, list: Thread[]) =>
    list.length > 0 && (
      <section className="cm-group">
        <h3 className="cm-group-title">
          {title}
          <span className="cm-count">{list.length}</span>
        </h3>
        <ul className="cm-rows">
          {list.map((t) => (
            <Row key={t.id} thread={t} orphan={orphanOf(t)} expanded={expanded === t.id} ctx={ctx} getView={getView} />
          ))}
        </ul>
      </section>
    )
  return (
    <aside className="hd-drawer cm-drawer">
      <div className="vh-header">
        <span className="cm-drawer-title">{C.drawer}</span>
        <button type="button" className="vh-close" onClick={closeDrawer} aria-label={C.cancel}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="cm-drawer-body">
        {threads.length === 0 ? (
          <div className="cm-empty">
            <b>{C.empty}</b>
            <span>{C.emptyHint}</span>
          </div>
        ) : (
          <>
            {group(C.open, open)}
            {group(C.resolvedGroup, done)}
          </>
        )}
      </div>
    </aside>
  )
}
