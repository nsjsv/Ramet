import { expect, test } from 'vitest'
import { parseCollection } from '@ramet/shared/collection-model'
import type { Page } from '../api'
import { depsChanged, depsSnapshot, depTargets } from './collection-deps'

/* 依赖的集合变没变（collection-deps.ts）：对方集合的行进出、对方集合本身不在了或换了空间 = 变；
 * 对方行改名只在有汇总读「名称」时才算；别的页面怎么变都不算；没有关联不比；一边还没有快照不算。 */

const B = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
const S = '1b0c3c1e-6f7a-4b2c-9d8e-112233445566'

const schema = parseCollection({
  props: {
    rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: B, reverse: null } },
    rev001: { name: '父', type: 'relation', pos: 1, cfg: { target: S, mirror: 'x00001' } },
    sum001: { name: '数', type: 'rollup', pos: 2, cfg: { relation: 'rel001', prop: 'title', fn: 'count' } },
    txt001: { name: '备注', type: 'text', pos: 3 },
  },
})

const page = (id: string, parent: string | null, title = id, kind: Page['kind'] = 'doc', space = 's1'): Page => ({
  id,
  parent_id: parent,
  title,
  kind,
  created_at: '',
  space_id: space,
  published: false,
  publish_includes_runs: false,
  icon: null,
})

const BASE: Page[] = [page(B, null, '项目', 'collection'), page('b1', B), page('b2', B), page(S, null, '源', 'collection'), page('s1', S), page('x', null)]
const changed = (next: Page[]): boolean => depsChanged(depsSnapshot(schema, BASE), depsSnapshot(schema, next))
const swap = (id: string, patch: Partial<Page>): Page[] => BASE.map((p) => (p.id === id ? { ...p, ...patch } : p))

test('公式引用了关联（直接或经别的公式）：那一端要比标题（公式里关联的值就是对方行的标题）', () => {
  const s = parseCollection({
    props: {
      rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: B, reverse: null } },
      rev001: { name: '父', type: 'relation', pos: 1, cfg: { target: S, mirror: 'x00001' } },
      fx0001: { name: '数', type: 'formula', pos: 2, cfg: { expr: 'COUNT([@rel001])' } },
      fx0002: { name: '父们', type: 'formula', pos: 3, cfg: { expr: '"父：" & [@fx0003]' } },
      fx0003: { name: '父名', type: 'formula', pos: 4, cfg: { expr: 'JOIN([@rev001])' } },
    },
  })
  expect([...depTargets(s)]).toEqual([
    [B, true],
    [S, true],
  ])
})

test('依赖哪些集合：关联（正向 / 反向）的另一端；挂着读「名称」的汇总的那一端要比标题', () => {
  expect([...depTargets(schema)]).toEqual([
    [B, true],
    [S, false],
  ])
  expect(depsSnapshot(parseCollection({ props: { txt001: { name: 'x', type: 'text', pos: 0 } } }), BASE)).toBeNull()
})

test('对方的行进出、改名，对方集合不在了 / 换了空间：变了', () => {
  expect(changed([...BASE, page('b3', B)])).toBe(true)
  expect(changed(BASE.filter((p) => p.id !== 's1'))).toBe(true)
  expect(changed(swap('b1', { title: '新名字' }))).toBe(true)
  expect(changed(swap('b1', { parent_id: S }))).toBe(true)
  expect(changed(BASE.filter((p) => p.id !== B && p.parent_id !== B))).toBe(true)
  expect(changed(swap(B, { space_id: 's2' }))).toBe(true)
})

test('无关的变化不算：别的页面、对方集合的过程页、对方集合自己改名、没有汇总读名称的那一端的行改名', () => {
  expect(changed(BASE)).toBe(false)
  expect(changed(swap('s1', { title: '新名字' }))).toBe(false)
  expect(changed(swap('x', { title: '别的' }))).toBe(false)
  expect(changed([...BASE, page('run1', B, '过程', 'run')])).toBe(false)
  expect(changed(swap(B, { title: '改名的集合' }))).toBe(false)
})

test('一边没有快照（刚有关联、列表刚到）不算', () => {
  expect(depsChanged(null, depsSnapshot(schema, BASE))).toBe(false)
  expect(depsChanged(depsSnapshot(schema, BASE), null)).toBe(false)
  expect(depsSnapshot(schema, null)).toBeNull()
})
