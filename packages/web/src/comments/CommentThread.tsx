/* ---------- 一个讨论串 ----------
 * 浮层、右侧卡片、抽屉、整页讨论区共用：评论列表（头像 + 名字 + 相对时间 + 已编辑）+ 回复框 + 解决 / 重新打开；
 * 自己的评论可编辑 / 删除，空间 owner 可删任何人的。readOnly（公开页）只画列表。
 * 首条被删且还有回复时显示「评论已删除」占位（服务端留的 deleted 行）；作者 null = 已注销用户。
 * Genet 以作者名义代发的回复（via）不另标：作者看过原文、点了发送，就是他自己说的话。
 * 空间 AI 写的评论（author.ai）：机器人图标 + 空间 AI 的名字，没有用户头像；没人能改，串的发起人、叫它的人、空间 owner 能删（comment-ai.ts）。
 * @了 Genet 的评论下面一行处理状态（call）：等着时「Genet 正在处理…」，没回成的原因 + 去 AI 页看对话（只有叫的人收得到）。
 * @了空间 AI 的同一行：「<名字> 正在回复…」/「<名字> 没能回复：原因」（成员都看得到，没有对话页可去）。 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Schema } from '@milkdown/kit/prose/model'
import { Avatar } from '../Avatar'
import { markVarStyle } from '../agent-marks'
import { COPY } from '../copy'
import { personOf, selfId, subscribePeople, type Person } from '../people'
import { relativeTime } from '../UpdatesFeed'
import CommentBody from './CommentBody'
import CommentComposer from './CommentComposer'
import { canDeleteComment, canEditComment } from './comment-ai'
import type { Anchor, Comment, CommentAuthor, CommentCall, Thread } from './comments-api'
import { DRAFT_ID, closePopover, createThread, editComment, openThread, removeComment, replyTo, setResolved } from './comments-store'
import { stopReplyDraft } from './reply-draft'
import { confirmDialog } from '../ui/dialog'

const C = COPY.comments

/** 评论 UI 的宿主上下文（编辑页 / 公开页各给一份） */
export type CommentCtx = {
  /** 公开页：只读，没有输入框和任何操作 */
  readOnly: boolean
  spaceId: string | null
  /** 这页在私人区：评论里 @ 的 AI 是自己的 Genet（comment-ai.ts） */
  privatePage: boolean
  /** 当前用户是该空间 owner：能删别人的评论 */
  canModerate: boolean
  getSchema: () => Schema | undefined
  tick: number
}

/** 作者的头像人物：同空间成员给真头像，否则（公开页 / 已离开空间）只用名字画首字 */
export function personFor(author: CommentAuthor, spaceId: string | null): Person | null {
  if (!author) return null
  const known = author.id && spaceId ? personOf(spaceId, author.id) : null
  return known ?? { id: author.id ?? '', username: author.name, avatar: null }
}

/** 评论作者的头像：空间 AI 是机器人图标（同回复块抬头的 mark），人是头像 */
export function CommentAvatar({ author, spaceId }: { author: CommentAuthor; spaceId: string | null }) {
  if (author?.ai) {
    return (
      <span className="cm-ai-avatar" aria-hidden="true">
        <span className="agent-mark" style={markVarStyle('bot')} />
      </span>
    )
  }
  return <Avatar person={personFor(author, spaceId)} size={20} />
}

function CallLine({ call }: { call: CommentCall }) {
  if (call.ai !== undefined) {
    return <div className={'cm-call' + (call.state === 'waiting' ? ' is-waiting' : '')}>{call.state === 'waiting' ? C.aiCallWaiting(call.ai) : C.aiCallFailed(call.ai, call.reason)}</div>
  }
  if (call.state === 'waiting') return <div className="cm-call is-waiting">{C.callWaiting}</div>
  return (
    <div className="cm-call">
      <span>{call.state === 'done' ? C.callDone : C.callFailed(call.reason)}</span>
      <Link className="cm-link" to="/ai">
        {C.callOpen}
      </Link>
    </div>
  )
}

/** threadBy = 串的发起人（首条评论的作者）：空间 AI 写的评论他能删 */
function CommentItem({ comment, threadBy, ctx }: { comment: Comment; threadBy: string | undefined; ctx: CommentCtx }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canDelete = !ctx.readOnly && canDeleteComment(comment, threadBy, selfId(), ctx.canModerate)
  const canEdit = !ctx.readOnly && canEditComment(comment, selfId())

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
        <CommentAvatar author={comment.author} spaceId={ctx.spaceId} />
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
          privatePage={ctx.privatePage}
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
      {!editing && comment.call && <CallLine call={comment.call} />}
      {error && <div className="cm-error">{error}</div>}
    </div>
  )
}

export default function CommentThread({ thread, ctx, autoFocus, onEscape }: { thread: Thread; ctx: CommentCtx; autoFocus?: boolean; onEscape?: () => void }) {
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
          <CommentItem key={c.id} comment={c} threadBy={thread.comments[0]?.author?.id} ctx={ctx} />
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
              privatePage={ctx.privatePage}
              placeholder={C.replyPlaceholder}
              autoFocus={autoFocus}
              submitLabel={C.reply}
              onEscape={onEscape}
              draftFor={{ target: thread.id }}
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

/** 给刚选中的字写第一条评论（浮层与右侧草稿卡片共用）：发出后激活新串，取消 / Esc 收起（代回复的草稿还在生成就一起停掉）。
 *  initial = 框里预先写好的字（正文里 @空间 AI 开的框预填它的记号） */
export function DraftComposer({ anchor, ctx, initial }: { anchor: Anchor; ctx: CommentCtx; initial?: string }) {
  return (
    <CommentComposer
      getSchema={ctx.getSchema}
      tick={ctx.tick}
      spaceId={ctx.spaceId}
      privatePage={ctx.privatePage}
      placeholder={C.placeholder}
      initial={initial}
      autoFocus
      draftFor={{ target: DRAFT_ID, anchor }}
      onCancel={() => {
        stopReplyDraft(DRAFT_ID)
        closePopover()
      }}
      onSubmit={async (text) => {
        const created = await createThread('inline', text, anchor)
        openThread(created.id)
      }}
    />
  )
}
