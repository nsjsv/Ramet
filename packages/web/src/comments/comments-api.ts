/* ---------- 评论的 REST 客户端（服务端 routes/comments.ts 与 routes/public.ts；形状同 server/src/comments/store.ts）----------
 * 评论是页面的附属数据，不进 Y.Doc：写成功后服务端在 page:<id> 文档上广播 stateless `{"t":"comments"}`，各端据此重拉。 */

import { request } from '../api'
import { ASSISTANT_AGENT, ASSISTANT_ID, SPACE_AI_ID } from '../assistant/identity'

/** null = 已注销用户。公开接口只给名字（没有 id）。ai = 'space'：空间 AI 写的（没有 id，名字是它此刻的名字） */
export type CommentAuthor = { id?: string; name: string; ai?: 'space' } | null

export type Comment = {
  id: string
  author: CommentAuthor
  /** 纯文字 + 换行，@ 成员是记号 `@[名字](user:<id>)`（公开接口已降成 `@名字`） */
  body: string
  createdAt: string
  editedAt: string | null
  /** 首条被删但串里还有回复：留占位，body 为空 */
  deleted: boolean
  /** 'genet' = Genet 以作者的名义代发（作者批过原文，或作者在串里叫了它）；只做记录，界面上不另标；本人写的没有这个键 */
  via?: 'genet'
  /** 空间 AI 写的评论是谁叫它写的（他能删这条）；人写的、公开接口没有这个键 */
  invoker?: string
  /** 这条评论 @了 Genet / 空间 AI 的处理状态。回了 / 公开接口没有这个键 */
  call?: CommentCall
}

/** waiting 人人看得到。ai = 空间 AI 此刻的名字（叫的是空间 AI）：failed 与原因成员都看得到；
 *  没有 ai = 叫的是 Genet：没回成（done = 看过了没回在这里、failed）只给叫的人 */
export type CommentCall = { state: 'waiting' | 'done' | 'failed'; reason: string; ai?: string }

/** 叫 Genet 的记号（评论框里的 Genet chip；服务端 comments/store.ts 同口径）：发出去就叫写评论的人自己的 Genet 处理这个串 */
export const GENET_MARK = `@[${ASSISTANT_AGENT.label}](agent:${ASSISTANT_ID})`

/** 叫空间 AI 的记号（团队空间评论框里的 AI chip）：发出去就叫这个空间的 AI 回这个串（服务端 comments/space-ai-call.ts） */
export const spaceAiMark = (name: string): string => `@[${name}](agent:${SPACE_AI_ID})`

/** 正文里的提及记号：成员 `@[名字](user:<id>)`、Genet 与空间 AI。名字里可能带 `]`：按收口的 `](` 定位；
 *  几种记号用同一个正则一起扫，免得一种的非贪婪匹配吞掉另一种（同服务端解析口径） */
export const MENTION_MARK = new RegExp(String.raw`@\[([^\n]*?)\]\((user:[A-Za-z0-9_-]{1,64}|agent:${ASSISTANT_ID}|agent:${SPACE_AI_ID})\)`, 'g')

/** 记号只留名字（摘要用） */
export const plainBody = (body: string): string => body.replace(MENTION_MARK, '@$1')

/** 划词评论的锚点：from / to 是 base64 编码的 Yjs 相对位置（to 指向被评论文字的最后一个字），
 *  blockId / text / n 是文字兜底（同 editor/text-anchor.ts 的 TextAnchor） */
export type Anchor = { from: string; to: string; blockId: string; text: string; n: number }

export type Thread = {
  id: string
  kind: 'inline' | 'page'
  anchor: Anchor | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: { id?: string; name: string } | null
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
