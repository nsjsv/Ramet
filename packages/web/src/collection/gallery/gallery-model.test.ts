import { describe, expect, test } from 'vitest'
import { parseCollection, pickView, type CollectionRow } from '@ramet/shared/collection-model'
import type { Page, PageCover } from '../../api'
import { coversOf, dropAt, galleryDrop, previewOf, type CardRect } from './gallery-model'

/* 不变量：预览三种来源——页面封面取页面列表里这一行的封面，文件属性只取第一张图片，不显示 = 不画预览区；
 * 取不到画占位。拖放：落在卡片左半 = 前、右半 = 后，指针不在卡片上时取最近的那一排里最近的那张；落回原处不发请求。 */

const IMG = { id: '00000000-0000-4000-8000-000000000001', name: 'a.png', mime: 'image/png', size: 10 }
const IMG2 = { id: '00000000-0000-4000-8000-000000000002', name: 'b.jpg', mime: 'image/jpeg', size: 10 }
const PDF = { id: '00000000-0000-4000-8000-000000000003', name: 'c.pdf', mime: 'application/pdf', size: 10 }

const schema = parseCollection({
  props: {
    fil001: { name: '图片', type: 'files', pos: 0 },
    txt001: { name: '备注', type: 'text', pos: 1 },
  },
  views: {
    page: { name: '封面', layout: 'gallery', pos: 0 },
    files: { name: '文件', layout: 'gallery', pos: 1, cover: 'fil001' },
    none: { name: '不显示', layout: 'gallery', pos: 2, cover: 'none' },
    wrong: { name: '不是文件', layout: 'gallery', pos: 3, cover: 'txt001' },
  },
})

const row = (id: string, props: Record<string, unknown> = {}, position = 0): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

const COVER: PageCover = { kind: 'preset', value: 'dolomites', y: 30 }
const page = (id: string, cover: PageCover | null): Page => ({ id, cover }) as unknown as Page

describe('预览来源', () => {
  const covers = coversOf([page('a', COVER), page('b', null), page('x', COVER)])

  test('页面封面：有封面给封面，没有画占位', () => {
    const view = pickView(schema, 'page')
    expect(previewOf(row('a'), schema, view, covers)).toEqual({ kind: 'cover', cover: COVER })
    expect(previewOf(row('b'), schema, view, covers)).toEqual({ kind: 'empty' })
    expect(previewOf(row('c'), schema, view, covers)).toEqual({ kind: 'empty' })
    expect(coversOf(null).size).toBe(0)
  })

  test('文件属性：第一张图片（跳过前面的非图片）；没有图片 / 空值画占位', () => {
    const view = pickView(schema, 'files')
    expect(previewOf(row('a', { fil001: [PDF, IMG2, IMG] }), schema, view, covers)).toEqual({ kind: 'file', file: IMG2 })
    expect(previewOf(row('a', { fil001: [PDF] }), schema, view, covers)).toEqual({ kind: 'empty' })
    expect(previewOf(row('a'), schema, view, covers)).toEqual({ kind: 'empty' })
  })

  test('不显示 = null；引用的属性不是文件 = 回到页面封面', () => {
    expect(previewOf(row('a'), schema, pickView(schema, 'none'), covers)).toBeNull()
    expect(pickView(schema, 'wrong').cover).toBe('page')
    expect(previewOf(row('a'), schema, pickView(schema, 'wrong'), covers)).toEqual({ kind: 'cover', cover: COVER })
  })
})

describe('拖放落点', () => {
  // 两排：a b c / d（每张 100 宽、80 高，间隔 20）
  const rect = (id: string, col: number, line: number): CardRect => ({
    id,
    left: col * 120,
    top: line * 100,
    right: col * 120 + 100,
    bottom: line * 100 + 80,
  })
  const cards = [rect('a', 0, 0), rect('b', 1, 0), rect('c', 2, 0), rect('d', 0, 1)]
  const rows = ['a', 'b', 'c', 'd'].map((id, i) => row(id, {}, i))

  test('卡片上：左半 = 前、右半 = 后', () => {
    expect(dropAt(130, 40, cards)).toEqual({ targetId: 'b', below: false })
    expect(dropAt(190, 40, cards)).toEqual({ targetId: 'b', below: true })
  })

  test('不在卡片上：最近那一排里水平最近的那张；行尾空白 = 最后一张之后，排间空隙按上下距离归排', () => {
    expect(dropAt(108, 40, cards)).toEqual({ targetId: 'a', below: true }) // a、b 之间的空隙，离 a 近
    expect(dropAt(400, 40, cards)).toEqual({ targetId: 'c', below: true })
    expect(dropAt(300, 120, cards)).toEqual({ targetId: 'd', below: true }) // 第二排行尾
    expect(dropAt(130, 85, cards)).toEqual({ targetId: 'b', below: false }) // 离第一排更近
    expect(dropAt(130, 300, cards)).toEqual({ targetId: 'd', below: true }) // 末排下面
    expect(dropAt(0, 0, [])).toBeNull()
  })

  test('落点 → 邻居：换到两张卡片之间；落回原处 = null', () => {
    expect(galleryDrop(rows, 'a', 190, 40, cards)).toEqual({ at: { targetId: 'b', below: true }, neighbors: { after: 'b', before: 'c' } })
    expect(galleryDrop(rows, 'd', 10, 40, cards)).toEqual({ at: { targetId: 'a', below: false }, neighbors: { after: null, before: 'a' } })
    expect(galleryDrop(rows, 'a', 190, 140, cards)).toEqual({ at: { targetId: 'd', below: true }, neighbors: { after: 'd', before: null } })
    expect(galleryDrop(rows, 'b', 108, 40, cards)).toBeNull() // a 之后 = b 原来的位置
    expect(galleryDrop(rows, 'b', 150, 40, cards)).toBeNull() // 落在自己身上
    expect(galleryDrop(rows, 'b', 0, 0, [])).toBeNull()
  })
})
