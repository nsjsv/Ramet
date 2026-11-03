// ---------- 画廊视图的纯计算：卡片宽度、预览从哪来、二维拖放的落点 ----------
// 预览来源（视图的 cover，parseView 已按属性当前类型校验过）：
// - 页面封面：页面列表里这一行的 cover（列表本就在内存里；改封面会广播 changed、列表重拉，卡片跟着变，不需要别的增量）；
// - 文件属性：值里第一个 image/* 的文件（只认图片，别的文件不当预览）；
// - 不显示：不画预览区。前两种取不到 = 占位（行图标放大居中，没图标画浅底）。
// 拖放：卡片排成网格，指针落在哪张卡片的左半 / 右半 = 插在它前 / 后，再换成前后邻居（口径同表格拖行，table-model 的 dropNeighbors）。
import {
  COVER_NONE,
  COVER_PAGE,
  fileList,
  findProp,
  rowValue,
  type CardSize,
  type CollectionRow,
  type CollectionSchema,
  type CollectionView,
  type FileRef,
} from '@ramet/shared/collection-model'
import type { Page, PageCover } from '../../api'
import { dropNeighbors } from '../table/table-model'

/** 卡片的最小宽度（px）：网格按它 auto-fill，剩余宽度均分给每一列 */
export const CARD_WIDTH: Record<CardSize, number> = { s: 180, m: 260, l: 340 }

export type Preview = { kind: 'cover'; cover: PageCover } | { kind: 'file'; file: FileRef } | { kind: 'empty' }

const EMPTY: Preview = { kind: 'empty' }

/** 页面列表里各页的封面（行 id → 封面）：每张卡片按 id 查，不必每张都扫一遍列表 */
export function coversOf(pages: readonly Page[] | null): Map<string, PageCover> {
  const out = new Map<string, PageCover>()
  for (const page of pages ?? []) if (page.cover) out.set(page.id, page.cover)
  return out
}

/** 卡片的预览；null = 视图设成不显示（不画预览区） */
export function previewOf(row: CollectionRow, schema: CollectionSchema, view: CollectionView, covers: ReadonlyMap<string, PageCover>): Preview | null {
  if (view.cover === COVER_NONE) return null
  if (view.cover === COVER_PAGE) {
    const cover = covers.get(row.id)
    return cover ? { kind: 'cover', cover } : EMPTY
  }
  const prop = findProp(schema, view.cover)
  const file = prop ? fileList(rowValue(row, prop))?.find((f) => f.mime.startsWith('image/')) : undefined
  return file ? { kind: 'file', file } : EMPTY
}

export type CardRect = { id: string; left: number; top: number; right: number; bottom: number }
/** 落点：插在 targetId 这张卡片的前（below = false）/ 后 */
export type GalleryDropAt = { targetId: string; below: boolean }

/** 一维距离：点在区间里 = 0 */
const gap = (v: number, lo: number, hi: number): number => (v < lo ? lo - v : v > hi ? v - hi : 0)

/** 指针 → 落点：先取竖直方向最近的那一排（指针在卡片的上下范围里 = 0，网格里同一排的卡片上下对齐），
 *  再取排里水平最近的那张；指针在它左半 = 前、右半 = 后。行尾 / 末排下面的空白落在最近那张的后面。没有卡片 = null */
export function dropAt(x: number, y: number, cards: readonly CardRect[]): GalleryDropAt | null {
  let best: CardRect | null = null
  let bestDy = Infinity
  let bestDx = Infinity
  for (const card of cards) {
    const dy = gap(y, card.top, card.bottom)
    const dx = gap(x, card.left, card.right)
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      best = card
      bestDy = dy
      bestDx = dx
    }
  }
  if (!best) return null
  return { targetId: best.id, below: x > (best.left + best.right) / 2 }
}

/** 拖动中的一次落点：落点 + 落下后的前后邻居；落回原处（或没有卡片）= null，不画提示、落下也不发 */
export function galleryDrop(
  rows: readonly CollectionRow[],
  dragged: string,
  x: number,
  y: number,
  cards: readonly CardRect[],
): { at: GalleryDropAt; neighbors: { after: string | null; before: string | null } } | null {
  const at = dropAt(x, y, cards)
  const neighbors = at ? dropNeighbors(rows, dragged, at.targetId, at.below) : null
  return at && neighbors ? { at, neighbors } : null
}
