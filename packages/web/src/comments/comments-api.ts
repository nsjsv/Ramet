/* ---------- 评论的 REST 客户端（服务端 routes/comments.ts 与 routes/public.ts；形状同 server/src/comments/store.ts）----------
 * 评论是页面的附属数据，不进 Y.Doc：写成功后服务端在 page:<id> 文档上广播 stateless `{"t":"comments"}`，各端据此重拉。 */

import { request } from '../api'

/** null = 已注销用户。公开接口只给名字（没有 id） */
export type CommentAuthor = { id?: string; name: string } | null

export type Comment = {
  id: string
  author: CommentAuthor
  /** 纯文字 + 换行，@ 成员是记号 `@[名字](user:<id>)`（公开接口已降成 `@名字`） */
  body: string
  createdAt: string
  editedAt: string | null
  /** 首条被删但串里还有回复：留占位，body 为空 */
  deleted: boolean
}

/** 划词评论的锚点：from / to 是 base64 编码的 Yjs 相对位置（to 指向被评论文字的最后一个字），
 *  blockId / text / n 是文字兜底（同 editor/text-anchor.ts 的 TextAnchor） */
export type Anchor = { from: string; to: string; blockId: string; text: string; n: number }

export type Thread = {
  id: string
  kind: 'inline' | 'page'
  anchor: Anchor | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: CommentAuthor
  /** 我上次读到这个串的时刻（收件箱「新」的判定）；公开接口恒为 null */
  readAt: string | null
  comments: Comment[]
}

/** 单条评论上限（按码点数，同服务端） */
export const COMMENT_MAX = 4000

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const commentsApi = {
  list: (pageId: string) => request<{ threads: Thread[] }>(`/api/pages/${pageId}/comments`).then((r) => r.threads),
  listPublic: (pageId: string) => request<{ threads: Thread[] }>(`/api/public/pages/${pageId}/comments`).then((r) => r.threads),
  create: (pageId: string, input: { kind: 'inline' | 'page'; anchor?: Anchor; body: string }) =>
    request<{ thread: Thread }>(`/api/pages/${pageId}/comments`, json(input)).then((r) => r.thread),
  reply: (threadId: string, body: string) =>
    request<{ comment: Comment }>(`/api/comment-threads/${threadId}/replies`, json({ body })).then((r) => r.comment),
  resolve: (threadId: string, resolved: boolean) =>
    request<{ thread: Thread }>(`/api/comment-threads/${threadId}/resolve`, json({ resolved })).then((r) => r.thread),
  read: (threadId: string) => request<unknown>(`/api/comment-threads/${threadId}/read`, { method: 'POST' }),
  edit: (commentId: string, body: string) =>
    request<{ comment: Comment }>(`/api/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) }).then((r) => r.comment),
  remove: (commentId: string) => request<{ threadDeleted: boolean }>(`/api/comments/${commentId}`, { method: 'DELETE' }),
}
