/* 页面封面契约（唯一定义处）
 *
 * 存储是三列（pages.cover_kind / cover_value / cover_y），对外折成一个派生字段：
 *
 *   cover: { kind: 'file' | 'url' | 'preset', value: string, y: number } | null
 *
 * - file：value 是 files.id（不是 URL，展示路径由前端 coverSrc 拼，走 display 版与图床）
 * - url：value 是外链图片的 http(s) 绝对地址，浏览器直接外链
 * - preset：value 是预设名（图库清单只在前端，随静态资源发布；服务端只管名字的形状）
 * - y：垂直位置 0–100（CSS object-position 的百分比），缺省 50
 *
 * 所有返回页面形状的端点经 toApiPage（page-icon.ts）带出 cover，消费方不直接读三列。
 */

export type CoverKind = 'file' | 'url' | 'preset'
export type PageCover = { kind: CoverKind; value: string; y: number }

/** 封面三列的形状 */
export type CoverColumns = { cover_kind: string | null; cover_value: string | null; cover_y: number | null }

export const COVER_COLUMNS = ['cover_kind', 'cover_value', 'cover_y'] as const

export const DEFAULT_COVER_Y = 50

const KINDS: ReadonlySet<string> = new Set<CoverKind>(['file', 'url', 'preset'])

/** 三列 → 对外单字段（缺列 / 空列 = null） */
export function pageCoverOf(row: Partial<CoverColumns>): PageCover | null {
  const kind = row.cover_kind
  const value = row.cover_value
  if (!kind || !value || !KINDS.has(kind)) return null
  const y = typeof row.cover_y === 'number' && Number.isFinite(row.cover_y) ? row.cover_y : DEFAULT_COVER_Y
  return { kind: kind as CoverKind, value, y }
}

/** 一条 UPDATE 同时写三列：清除时位置回到缺省，换下一张图不会继承上一张的裁切 */
export const SET_PAGE_COVER = 'UPDATE pages SET cover_kind = $1, cover_value = $2, cover_y = $3 WHERE id = $4'

export function coverParams(cover: PageCover | null): [string | null, string | null, number] {
  return cover ? [cover.kind, cover.value, cover.y] : [null, null, DEFAULT_COVER_Y]
}

/** 外链地址上限：正常图片地址远小于此，挡住拿超长串塞库 */
const URL_MAX = 2048
const PRESET_RE = /^[a-z0-9-]{1,40}$/

export type ParsedCover = { ok: true; cover: PageCover | null } | { ok: false; error: string }

/** PATCH body 的 cover 字段 → 合法输入（格式层；file 的「文件存在且是图片」要查库，在路由里做） */
export function parseCoverInput(raw: unknown): ParsedCover {
  if (raw === null) return { ok: true, cover: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'cover must be an object or null' }
  const { kind, value, y } = raw as { kind?: unknown; value?: unknown; y?: unknown }
  if (typeof kind !== 'string' || !KINDS.has(kind)) return { ok: false, error: 'cover.kind must be file, url or preset' }
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'cover.value must be a non-empty string' }
  let pos = DEFAULT_COVER_Y
  if (y !== undefined) {
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 100) return { ok: false, error: 'cover.y must be a number in [0, 100]' }
    pos = y
  }
  const v = value.trim()
  if (kind === 'url') {
    // 控制字符（含换行）进了 src 属性就是垃圾；javascript: / data: 之类不是图片地址
    if (v.length > URL_MAX || /[\u0000-\u001f\u007f\s]/.test(v)) return { ok: false, error: 'cover.value is not a valid url' }
    let url: URL
    try {
      url = new URL(v)
    } catch {
      return { ok: false, error: 'cover.value is not a valid url' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'cover url must be http(s)' }
  }
  if (kind === 'preset' && !PRESET_RE.test(v)) return { ok: false, error: 'cover.value is not a valid preset' }
  return { ok: true, cover: { kind: kind as CoverKind, value: v, y: pos } }
}
