/* 页面图标契约（唯一定义处）
 *
 * 存储是两列（pages.icon_emoji / pages.icon_file_id）：emoji 是字面量、图片是对 files 行的引用，
 * 两类数据分开存，DB CHECK 保证至多一个非空。但对外只暴露一个派生字段：
 *
 *   icon: { kind: 'emoji' | 'image', value: string } | null
 *
 * value 是 emoji 字符本身，或图片的文件 id（不是 URL，展示路径由前端 PageIcon 组件拼）。
 * 所有返回页面形状的端点都必须过 toApiPage，消费方不做「先看 emoji 再看图片」的优先级判断，
 * 否则同一个不变量会散成多份副本。
 */

export type PageIcon = { kind: 'emoji'; value: string } | { kind: 'image'; value: string }

/** 图标两列的形状（任何带图标列的行都能过 toApiPage / pageIconOf） */
export type IconColumns = { icon_emoji: string | null; icon_file_id: string | null }

/** PATCH 入参：null 清除图标 */
export type IconInput = PageIcon | null

/** 图标两列 → 对外单字段 */
export function pageIconOf(row: IconColumns): PageIcon | null {
  if (row.icon_emoji) return { kind: 'emoji', value: row.icon_emoji }
  if (row.icon_file_id) return { kind: 'image', value: row.icon_file_id }
  return null
}

/* 对外的页面形状（唯一定义处）：页面列表 / 建页 / 改页 / admin 空间预览 / 建集合都只出这些字段 + icon。
 * 用白名单而不是原样展开，否则 content_text（全文）、agent_session 会随每次 changed 后的整表重拉发给每个客户端。
 * pages 以后加列，不登记在这里就不会出去。
 * 同时也是页面变更日志的触发条件（db.ts 的 page_changes 触发器 WHEN 由它拼出）：这里的列变了，
 * 增量同步（page-sync.ts）才会把该页再下发一次。position 在内：客户端合并增量后要按服务端同一口径排序 */
export const API_PAGE_FIELDS = [
  'id',
  'parent_id',
  'title',
  'created_at',
  'owner_id',
  'space_id',
  'published',
  'kind',
  'publish_includes_runs',
  'in_page_tree',
  'is_template',
  'full_width',
  'position',
] as const

export type ApiPageField = (typeof API_PAGE_FIELDS)[number]

/** 返回页面形状的查询用的列清单（对外字段 + 图标两列）；alias = 表别名 */
export function apiPageColumns(alias: string): string {
  return [...API_PAGE_FIELDS, 'icon_emoji', 'icon_file_id'].map((col) => `${alias}.${col}`).join(', ')
}

export type ApiPage = Record<ApiPageField, unknown> & { icon: PageIcon | null }

/** 行 → 对外形状：只挑白名单字段，图标两列折成 icon 单字段（缺省列的行得到 icon: null） */
export function toApiPage(row: object): ApiPage {
  const src = row as Record<string, unknown> & Partial<IconColumns>
  const out = {} as Record<ApiPageField, unknown>
  for (const key of API_PAGE_FIELDS) if (key in src) out[key] = src[key]
  return { ...out, icon: pageIconOf({ icon_emoji: src.icon_emoji ?? null, icon_file_id: src.icon_file_id ?? null }) }
}

/** 任一页面的图标（回收站条目、搜索命中的行可能只查了部分列） */
export function rowIcon(row: Partial<IconColumns> | undefined | null): PageIcon | null {
  return row ? pageIconOf({ icon_emoji: row.icon_emoji ?? null, icon_file_id: row.icon_file_id ?? null }) : null
}

/** 一条 UPDATE 同时写两列：三种意图各一组参数，不存在先清一列再写另一列的中间态，
 * DB 的互斥约束因此不会被本模块经手的写入触发 */
export const SET_PAGE_ICON = 'UPDATE pages SET icon_emoji = $1, icon_file_id = $2 WHERE id = $3'

/** 图标图片源必须已存在于 files（uuid 即权限边界，与文件下载一致）。mime 必须是图片，
 * 非图片当图标必然渲染成破图，要在写入前挡住 */
export const SELECT_ICON_SOURCE_MIME = 'SELECT mime FROM files WHERE id = $1'
export function isIconSourceMime(mime: string | undefined): boolean {
  return !!mime && mime.startsWith('image/')
}

export function iconParams(icon: IconInput): [string | null, string | null] {
  if (icon === null) return [null, null]
  return icon.kind === 'emoji' ? [icon.value, null] : [null, icon.value]
}

/** emoji 上限：够任何 ZWJ 组合序列（家庭 / 旗帜 / 职业），挡住拿长文本当图标的滥用。
 * 按码点而非 UTF-16 单元数，代理对（emoji 基本都在辅助平面）才不会被算成两个 */
const EMOJI_MAX_CODE_POINTS = 8

export type ParsedIcon = { ok: true; icon: IconInput } | { ok: false; error: string }

/** PATCH body 的 icon 字段 → 合法输入（格式层校验；图片的「文件存在且是图片」需查库，在路由里做） */
export function parseIconInput(raw: unknown): ParsedIcon {
  if (raw === null) return { ok: true, icon: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'icon must be an object or null' }
  const { kind, value } = raw as { kind?: unknown; value?: unknown }
  if (kind !== 'emoji' && kind !== 'image') return { ok: false, error: 'icon.kind must be emoji or image' }
  if (typeof value !== 'string') return { ok: false, error: 'icon.value must be a string' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, error: 'icon.value must not be empty' }
  if (kind === 'emoji') {
    // 控制字符（含换行 / 制表）会把图标列变成垃圾文本
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, error: 'icon.value is not an emoji' }
    if ([...trimmed].length > EMOJI_MAX_CODE_POINTS) return { ok: false, error: 'icon.value is too long' }
    return { ok: true, icon: { kind: 'emoji', value: trimmed } }
  }
  return { ok: true, icon: { kind: 'image', value: trimmed } }
}
