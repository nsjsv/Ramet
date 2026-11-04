/* ---------- 一个讨论串 ----------
 * 浮层、抽屉、整页讨论区共用：评论列表（头像 + 名字 + 相对时间 + 已编辑）+ 回复框 + 解决 / 重新打开；
 * 自己的评论可编辑 / 删除，空间 owner 可删任何人的。readOnly（公开页）只画列表。
 * 首条被删且还有回复时显示「评论已删除」占位（服务端留的 deleted 行）；作者 null = 已注销用户。 */

import { useEffect, useState } from 'react'
import type { Schema } from '@milkdown/kit/prose/model'
import { Avatar } from '../Avatar'
import { COPY } from '../copy'
import { personOf, selfId, subscribePeople, type Person } from '../people'
import { relativeTime } from '../UpdatesFeed'
import CommentBody from './CommentBody'
import CommentComposer from './CommentComposer'
import type { Comment, CommentAuthor, Thread } from './comments-api'
import { editComment, removeComment, replyTo, setResolved } from './comments-store'
import { confirmDialog } from '../ui/dialog'

const C = COPY.comments

/** 评论 UI 的宿主上下文（编辑页 / 公开页各给一份） */
export type CommentCtx = {
  /** 公开页：只读，没有输入框和任何操作 */
  readOnly: boolean
  spaceId: string | null
  /** 当前用户是该空间 owner：能删别人的评论 */
  canModerate: boolean
  getSchema: () => Schema | undefined
  tick: number
}

/** 作者的头像人物：同空间成员给真头像，否则（公开页 / 已离开空间）只用名字画首字 */
function personFor(author: CommentAuthor, spaceId: string | null): Person | null {
  if (!author) return null
  const known = author.id && spaceId ? personOf(spaceId, author.id) : null
  return known ?? { id: author.id ?? '', username: author.name, avatar: null }
}

function CommentItem({ comment, ctx }: { comment: Comment; ctx: CommentCtx }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = !!comment.author?.id && comment.author.id === selfId()
  const canDelete = !ctx.readOnly && !comment.deleted && (mine || ctx.canModerate)
  const canEdit = !ctx.readOnly && !comment.deleted && mine

  async function remove(): Promise<void> {
    if (!(await confirmDialog({ message: C.confirmRemove, danger: true }))) return
    setError(null)
    try {
      await removeComment(comment.id)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : C.failed)
    }
  }

  if (comment.deleted) return <div className="cm-item is-deleted">{C.deleted}</div>
  return (
    <div className="cm-item">
      <div className="cm-meta">
        <Avatar person={personFor(comment.author, ctx.spaceId)} size={20} />
        <span className="cm-name">{comment.author?.name ?? C.deletedUser}</span>
        <span className="cm-time" data-tip={new Date(comment.createdAt).toLocaleString()}>
          {relativeTime(comment.createdAt)}
        </span>
        {comment.editedAt && <span className="cm-time">{C.edited}</span>}
        {(canEdit || canDelete) && !editing && (
          <span className="cm-item-acts">
            {canEdit && (
              <button type="button" className="cm-link" onClick={() => setEditing(true)}>
                {C.edit}
              </button>
            )}
            {canDelete && (
              <button type="button" className="cm-link is-danger" onClick={() => void remove()}>
                {C.remove}
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <CommentComposer
          getSchema={ctx.getSchema}
          tick={ctx.tick}
          spaceId={ctx.spaceId}
          placeholder={C.placeholder}
          initial={comment.body}
          autoFocus
          submitLabel={C.save}
          onCancel={() => setEditing(false)}
          onSubmit={async (text) => {
            await editComment(comment.id, text)
            setEditing(false)
          }}
        />
      ) : (
        <CommentBody body={comment.body} />
      )}
      {error && <div className="cm-error">{error}</div>}
    </div>
  )
}

export default function CommentThread({ thread, ctx, autoFocus }: { thread: Thread; ctx: CommentCtx; autoFocus?: boolean }) {
  // 成员名单晚到：到了重画一次（头像从首字换成真图）
  const [, setPeopleTick] = useState(0)
  useEffect(() => subscribePeople(() => setPeopleTick((t) => t + 1)), [])
  const [error, setError] = useState<string | null>(null)
  const resolved = !!thread.resolvedAt

  async function toggleResolved(): Promise<void> {
    setError(null)
    try {
      await setResolved(thread.id, !resolved)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : C.failed)
    }
  }

  return (
    <div className={'cm-thread' + (resolved ? ' is-resolved' : '')}>
      <div className="cm-list">
        {thread.comments.map((c) => (
          <CommentItem key={c.id} comment={c} ctx={ctx} />
        ))}
      </div>
      {resolved && <div className="cm-resolved-line">{C.resolvedBy(thread.resolvedBy?.name ?? C.deletedUser)}</div>}
      {error && <div className="cm-error">{error}</div>}
      {!ctx.readOnly && (
        <div className="cm-thread-foot">
          {!resolved && (
            <CommentComposer
              getSchema={ctx.getSchema}
              tick={ctx.tick}
              spaceId={ctx.spaceId}
              placeholder={C.replyPlaceholder}
              autoFocus={autoFocus}
              submitLabel={C.reply}
              onSubmit={(text) => replyTo(thread.id, text)}
            />
          )}
          <button type="button" className="cm-btn cm-resolve" onClick={() => void toggleResolved()}>
            {resolved ? C.reopen : C.resolve}
          </button>
        </div>
      )}
    </div>
  )
}
