/* ---------- 行属性值 → 文字（自动化载荷的口径） ---------- */
import { describe, expect, it } from 'vitest'
import { parseCollection, type CollectionRow } from '@ramet/shared/collection-model'
import { INVALID, rawText, referenced, rowTexts, type TextCtx } from './value-text.js'

const schema = parseCollection({
  v: 1,
  props: {
    st: {
      name: '状态',
      type: 'status',
      pos: 0,
      options: { a1: { name: '未开始', color: 'gray', pos: 0, group: 'todo' }, a2: { name: '完成', color: 'green', pos: 1, group: 'done' } },
    },
    ms: { name: '标签', type: 'multi_select', pos: 1, options: { t1: { name: '前端', color: 'blue', pos: 0 }, t2: { name: '后端', color: 'red', pos: 1 } } },
    pp: { name: '负责人', type: 'person', pos: 2 },
    ck: { name: '紧急', type: 'checkbox', pos: 3 },
    dt: { name: '日期', type: 'date', pos: 4 },
    rl: { name: '关联', type: 'relation', pos: 5, cfg: { target: '0b6f5a52-1c1e-4a39-9a43-1f2d3c4b5a69' } },
    fl: { name: '附件', type: 'files', pos: 6 },
    no: { name: '编号', type: 'unique_id', pos: 7, cfg: { prefix: 'T' } },
    fx: { name: '公式', type: 'formula', pos: 8, cfg: { expr: '1' } },
  },
  views: {},
})

const ctx: TextCtx = { name: (id) => ({ u1: 'alice' })[id], title: (id) => ({ p1: '设计稿', p2: '' })[id] }

const row: CollectionRow = {
  id: 'r1',
  title: '写报告',
  icon: null,
  props: {
    st: 'a2',
    ms: ['t2', 't1'],
    pp: ['u1', 'gone'],
    ck: true,
    dt: '2026-11-07/2026-11-09',
    rl: ['p1', 'p2', 'p3'],
    fl: [{ id: '1b6f5a52-1c1e-4a39-9a43-1f2d3c4b5a69', name: 'a.png', mime: 'image/png', size: 3 }],
  },
  position: 0,
  created_at: '',
  edited_at: '',
  has_body: false,
  number: 12,
}

describe('value-text', () => {
  it('整行：名称在前，选项 / 人 / 是否 / 日期 / 关联 / 文件 / 编号写成文字，公式不写', () => {
    expect(rowTexts(schema, row, ctx)).toEqual({
      名称: '写报告',
      状态: '完成',
      标签: '后端、前端',
      负责人: 'alice、已不在空间的人',
      紧急: '是',
      日期: '2026-11-07 → 2026-11-09',
      关联: '设计稿、无标题、已不在的行',
      附件: 'a.png',
      编号: 'T-12',
    })
  })

  it('原始值：空 = 空串、读不出 = 已失效；列出提到的人与行', () => {
    const st = schema.props.find((p) => p.id === 'st')!
    expect(rawText(st, null, ctx)).toBe('')
    expect(rawText(st, 'deleted-option', ctx)).toBe(INVALID)
    expect(rawText(st, 'a1', ctx)).toBe('未开始')
    const refs = referenced(schema, [row.props])
    expect([...refs.users]).toEqual(['u1', 'gone'])
    expect([...refs.pages]).toEqual(['p1', 'p2', 'p3'])
  })
})
