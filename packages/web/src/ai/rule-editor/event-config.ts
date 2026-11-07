/* ---------- 事件触发的配置草稿 ↔ JSON（纯函数，有单测）：评论找我、正文 @我、盯页面 ----------
 * 只看哪些空间：空 = 全部空间（以后新加入的空间也算）。命中原因至少选一种。
 * 盯页面：选一页、含不含子页、别人停手多久算改完（下拉里的几档；库里的值不在档里时照样保留）。
 * 认不出的配置回落缺省（全部原因、全部空间；含子页、10 分钟），与服务端读库时的口径一致；最终校验在服务端。 */

import type { Condition } from '@ramet/shared/collection-model'
import { COMMENT_REASONS, type CollectionConfig, type CommentConfig, type CommentReason, type MentionConfig, type WatchConfig } from '../automation-api'
import type { Fail } from './rule-model'

export type CommentDraft = { reasons: CommentReason[]; spaces: string[] }
export type MentionDraft = { spaces: string[] }
export type WatchDraft = { page: string; subtree: boolean; quiet: number }
/** 合集里有变化：on = 新增了一行 / 属性改了；props 空 = 任意属性；conds = 改成满足这些条件（同视图筛选） */
export type CollectionDraft = { collection: string; on: 'added' | 'edited'; props: string[]; conds: Condition[] }

/** 「停手多久算改完」的几档（分钟） */
export const QUIET_CHOICES = [5, 10, 30, 60] as const
const QUIET_DEFAULT = 10

const record = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {})

function spacesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
}

export const defaultCommentDraft = (): CommentDraft => ({ reasons: [...COMMENT_REASONS], spaces: [] })

export function commentDraftOf(config: unknown): CommentDraft {
  const c = record(config)
  const reasons = Array.isArray(c.reasons) ? COMMENT_REASONS.filter((r) => (c.reasons as unknown[]).includes(r)) : []
  // 一个都认不出 = 坏配置：按全部原因（服务端派发时也这么读）
  return { reasons: reasons.length > 0 ? reasons : [...COMMENT_REASONS], spaces: spacesOf(c.spaces) }
}

/** 原因按固定顺序发（往返稳定，「改了什么」才比得准） */
export function commentConfigOf(d: CommentDraft, noReason: string): CommentConfig | Fail {
  const reasons = COMMENT_REASONS.filter((r) => d.reasons.includes(r))
  return reasons.length > 0 ? { reasons, spaces: [...d.spaces] } : { error: noReason }
}

export const defaultMentionDraft = (): MentionDraft => ({ spaces: [] })

export const mentionDraftOf = (config: unknown): MentionDraft => ({ spaces: spacesOf(record(config).spaces) })

export const mentionConfigOf = (d: MentionDraft): MentionConfig => ({ spaces: [...d.spaces] })

export function toggleReason(list: readonly CommentReason[], r: CommentReason): CommentReason[] {
  return list.includes(r) ? list.filter((x) => x !== r) : COMMENT_REASONS.filter((x) => x === r || list.includes(x))
}

export const defaultWatchDraft = (): WatchDraft => ({ page: '', subtree: true, quiet: QUIET_DEFAULT })

export function watchDraftOf(config: unknown): WatchDraft {
  const c = record(config)
  const quiet = typeof c.quiet === 'number' && Number.isInteger(c.quiet) && c.quiet > 0 ? c.quiet : QUIET_DEFAULT
  return { page: typeof c.page === 'string' ? c.page : '', subtree: c.subtree !== false, quiet }
}

export function watchConfigOf(d: WatchDraft, noPage: string): WatchConfig | Fail {
  return d.page ? { page: d.page, subtree: d.subtree, quiet: d.quiet } : { error: noPage }
}

export const defaultCollectionDraft = (): CollectionDraft => ({ collection: '', on: 'added', props: [], conds: [] })

export function collectionDraftOf(config: unknown): CollectionDraft {
  const c = record(config)
  const all = record(c.filter).all
  return {
    collection: typeof c.collection === 'string' ? c.collection : '',
    on: c.on === 'edited' ? 'edited' : 'added',
    props: Array.isArray(c.props) ? c.props.filter((p): p is string => typeof p === 'string') : [],
    conds: Array.isArray(all) ? (all.filter((x) => x && typeof x === 'object') as Condition[]) : [],
  }
}

/** 「新增了一行」不带属性与条件（切过去再切回来填的那些不发） */
export function collectionConfigOf(d: CollectionDraft, noCollection: string): CollectionConfig | Fail {
  if (!d.collection) return { error: noCollection }
  return d.on === 'added'
    ? { collection: d.collection, on: 'added', props: [], filter: { all: [] } }
    : { collection: d.collection, on: 'edited', props: [...d.props], filter: { all: d.conds.map((c) => ({ ...c })) } }
}

export function toggleProp(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

/** 下拉里的档：库里的值不在档里时补上它（不然打开再保存会悄悄改掉） */
export function quietChoices(current: number): number[] {
  return [...new Set([...QUIET_CHOICES, current])].sort((a, b) => a - b)
}

/** 空间多选：点「全部空间」= 清空；全部状态下点某个空间 = 只看它；取消到一个不剩 = 回到全部 */
export function toggleSpace(list: readonly string[], id: string | null): string[] {
  if (id === null) return []
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
