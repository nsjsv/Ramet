import { expect, test } from 'vitest'
import { parseCollection, type CollectionRow } from '@ramet/shared/collection-model'
import { hasReverse, normalizeRelation, splitWrite, withValues } from './relation-write'

/* store 写关联的换算（relation-write.ts）：正向整份写；反向按这一行现在的值换算成增删、乐观地改 computed；
 * 正向的乐观行去掉 computed 里的旧值。 */

const B = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
const schema = parseCollection({
  props: {
    rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: B, reverse: null, single: false } },
    one001: { name: '负责项目', type: 'relation', pos: 1, cfg: { target: B, reverse: null, single: true } },
    rev001: { name: '父', type: 'relation', pos: 2, cfg: { target: B, mirror: 'x00001' } },
    txt001: { name: '备注', type: 'text', pos: 3 },
  },
})
const prop = (id: string) => schema.props.find((p) => p.id === id)!

const row: CollectionRow = {
  id: 'a1',
  title: 'A1',
  icon: null,
  props: { rel001: ['b1', 'gone'], txt001: 'x' },
  position: 0,
  created_at: '',
  edited_at: '',
  has_body: false,
  computed: { rel001: ['b1'], rev001: ['s1', 's2'] },
}

test('规范化：正向校验形状与只能关联一行（是不是对方的活行交给服务端），反向原样', () => {
  expect(normalizeRelation(prop('rel001'), ['b1', 'b1', 'b2'])).toEqual({ ok: true, value: ['b1', 'b2'] })
  expect(normalizeRelation(prop('rel001'), [])).toEqual({ ok: true, value: null })
  expect(normalizeRelation(prop('one001'), ['b1', 'b2']).ok).toBe(false)
  expect(normalizeRelation(prop('rel001'), 'b1').ok).toBe(false)
  const many = Array.from({ length: 500 }, (_, i) => `s${i}`)
  expect(normalizeRelation(prop('rev001'), many)).toEqual({ ok: true, value: many })
})

test('拆分：正向与别的属性原样，反向换算成增删（没变的不发）、乐观值单独给', () => {
  const split = splitWrite(schema, { rel001: ['b2'], txt001: null, rev001: ['s2', 's3'] }, row)
  expect(split).toEqual({
    stored: { rel001: ['b2'], txt001: null },
    wire: { rel001: ['b2'], txt001: null, rev001: { add: ['s3'], remove: ['s1'] } },
    shown: { rev001: ['s2', 's3'] },
  })
  expect(splitWrite(schema, { rev001: ['s1', 's2'] }, row)).toEqual({ stored: {}, wire: {}, shown: {} })
  expect(splitWrite(schema, { rev001: null }, row)).toEqual({ stored: {}, wire: { rev001: { remove: ['s1', 's2'] } }, shown: { rev001: [] } })
  // 这一行哪都没加载：按空算
  expect(splitWrite(schema, { rev001: ['s1'] }, undefined)).toEqual({ stored: {}, wire: { rev001: { add: ['s1'] } }, shown: { rev001: ['s1'] } })
  expect(typeof splitWrite(schema, { rev001: Array.from({ length: 101 }, (_, i) => `n${i}`) }, row)).toBe('string')
  expect(hasReverse(schema, { rev001: null })).toBe(true)
  expect(hasReverse(schema, { rel001: null, txt001: 'y' })).toBe(false)
})

test('乐观的行：props 套新值、prev 是旧值；改过存储值的关联去掉 computed 里的旧值；反向直接改 computed', () => {
  const up = withValues(row, { rel001: ['b2'], txt001: null }, { rev001: ['s9'] }, 5)
  expect(up.prev).toEqual({ rel001: ['b1', 'gone'], txt001: 'x' })
  expect(up.row.props).toEqual({ rel001: ['b2'] })
  expect(up.row.computed).toEqual({ rev001: ['s9'] })
  expect(up.row.position).toBe(5)
  expect(withValues({ ...row, computed: undefined }, { txt001: 'y' }).row.computed).toBeUndefined()
  expect(row.computed).toEqual({ rel001: ['b1'], rev001: ['s1', 's2'] })
})
