import { describe, expect, test } from 'vitest'
import { compileFormulas, parseCollection, type CollectionRow, type CollectionSchema } from '@ramet/shared/collection-model'
import { applyRowsDelta, fillFormulas, queryWindow, type RowsWindow } from '@ramet/shared/collection-query'
import { mkRow, NOW } from './collection-formula-fixtures'

/* 恶意文档（任何成员都能往集合文档里写任何表达式，服务端每次窗口查询给每行算全部公式）：
 * 表达式长度、嵌套、公式个数有上限，每行的工作量也有上限 —— 再坏的公式，一行也只算得了很短的一会儿，
 * 用完的格子为空，服务端窗口与客户端单独算这一行结果一样。这里的耗时上限放得很宽（CI 机器慢），
 * 挡的是「一行几十毫秒、几千行拖住进程几分钟」那个量级。 */

const OPTIONS = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`o${i}`, { name: `选项${i}`, pos: i }]))
const PROPS: Record<string, Record<string, unknown>> = {
  t: { name: '备注', type: 'text', pos: 0 },
  n: { name: '数量', type: 'number', pos: 1 },
  m: { name: '标签', type: 'multi_select', pos: 2, options: OPTIONS },
  d: { name: '开始', type: 'date', pos: 3 },
}
const TAGS = Object.keys(OPTIONS)
const LONG = 'x'.repeat(1999) + '😀'

/** 直接给存储形（成员能写进文档的就是存储形），公式 id 依次是 f0、f1… */
function schemaOf(exprs: string[]): CollectionSchema {
  const props: Record<string, Record<string, unknown>> = { ...PROPS }
  exprs.forEach((expr, i) => (props[`f${i}`] = { name: `公式${i}`, type: 'formula', pos: 10 + i, cfg: { expr } }))
  return parseCollection({ props })
}

/** 把 piece 一直接在 head 后面，直到快到 2,000 字（单个表达式的上限） */
function pad(head: string, piece: string, tail = ''): string {
  let out = head
  while (out.length + piece.length + tail.length <= 1990) out += piece
  return out + tail
}

/** 算一批行，返回耗时（毫秒）与结果 */
function timed(schema: CollectionSchema, rows: CollectionRow[]): { ms: number; out: CollectionRow[] } {
  const started = performance.now()
  const out = fillFormulas(rows, schema, { now: NOW })
  return { ms: performance.now() - started, out }
}

const rowsOf = (n: number, extra: Partial<CollectionRow>): CollectionRow[] => Array.from({ length: n }, (_, i) => mkRow({ id: `r${i}`, ...extra }))

describe('每行的工作量有上限', () => {
  test('对长文本连写几百次文字处理：编译通过，算得很快，超出的格子为空', () => {
    const hostile = [pad('LEN([@t])', '+LEN([@t])'), pad('LEN(MID([@t],1,2000))', '+LEN(MID([@t],1,2000))'), pad('LEN(TRIM(UPPER([@t])))', '+LEN(TRIM(UPPER([@t])))')]
    const schema = schemaOf(hostile)
    expect([...compileFormulas(schema).values()].every((c) => c.ok)).toBe(true)
    const { ms, out } = timed(schema, rowsOf(500, { props: { t: LONG } }))
    expect(out[0]!.computed).toEqual({})
    expect(ms).toBeLessThan(2000)
  })

  test('很长的标题、很长的列表逐项转文字：同样有上限', () => {
    const schema = schemaOf([pad('LEN([@title])', '+LEN([@title])'), pad('LEN(TEXT([@m]))', '+LEN(TEXT([@m]))'), pad('SUM([@m]', ',[@m]', ')')])
    const { ms, out } = timed(schema, rowsOf(200, { title: 'y'.repeat(100_000), props: { m: TAGS } }))
    expect(out[0]!.computed).toEqual({})
    expect(ms).toBeLessThan(2000)
  })

  test('长列表配长分隔符：先估长度，超出就为空，不先拼出几十万字', () => {
    const schema = schemaOf(['SUBSTITUTE([@t], "x", "xxxxx")', 'LEN(JOIN([@m], [@f0]))', 'LEN(CONCAT([@f0], [@f0], [@f0]))'])
    const { out } = timed(schema, rowsOf(1, { props: { t: 'x'.repeat(1999), m: TAGS } }))
    expect(out[0]!.computed?.f0).toHaveLength(2000)
    expect(out[0]!.computed?.f1).toBeUndefined()
    expect(out[0]!.computed?.f2).toBeUndefined()
  })

  test('正常的公式不受影响：对 2,000 字的文本做几十次文字处理照常算出来，emoji 按一个字算', () => {
    const exprs = Array.from({ length: 8 }, () => 'LEN([@t]) + LEN(LEFT([@t], 3)) + LEN(RIGHT([@t], 2)) + IF(CONTAINS(LOWER([@t]), "x"), 1, 0)')
    const schema = schemaOf([...exprs, 'RIGHT([@t], 1) & MID([@t], 1999, 5) & LEFT("😀a", 1)', 'JOIN([@m], "/")'])
    const { out } = timed(schema, rowsOf(1, { props: { t: LONG, m: TAGS.slice(0, 3) } }))
    expect(out[0]!.computed?.f0).toBe(2000 + 3 + 2 + 1)
    expect(out[0]!.computed?.f7).toBe(2006)
    expect(out[0]!.computed?.f8).toBe('😀x😀😀')
    expect(out[0]!.computed?.f9).toBe('选项0/选项1/选项2')
  })

  test('按码点取字（不展开成数组的写法）与展开成数组的口径一致：emoji、孤立的代理项、超出末尾', () => {
    const units = ['a', '好', '😀', '\uD83D', '\uDE00', 'b']
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const schema = schemaOf(['LEN([@title])', 'LEFT([@title], [@n])', 'RIGHT([@title], [@n])', 'MID([@title], [@n] + 1, 3)'])
    for (let k = 0; k < 300; k++) {
      const title = Array.from({ length: rand(12) }, () => units[rand(units.length)]!).join('')
      const n = rand(8)
      const chars = [...title]
      const want = [chars.length, chars.slice(0, n).join(''), chars.slice(Math.max(0, chars.length - n)).join(''), chars.slice(n, n + 3).join('')]
      const got = fillFormulas([mkRow({ title, props: { n } })], schema, { now: NOW })[0]!.computed ?? {}
      // 空文本不写进 computed，读出来是 undefined
      expect(['f0', 'f1', 'f2', 'f3'].map((id) => got[id] ?? (id === 'f0' ? 0 : ''))).toEqual(want)
    }
  })

  test('两端一样：用完工作量的那一行，在整批窗口里与单独套增量时算出同样的值', () => {
    const exprs = [pad('LEN([@t])', '+LEN([@t])'), '[@n] * 2', pad('LEN([@t])', '+LEN([@t])'), '[@n] + 1']
    const schema = schemaOf(exprs)
    const rows = [mkRow({ id: 'a', props: { t: LONG, n: 1 } }), mkRow({ id: 'b', props: { t: 'abc', n: 2 } })]
    const view = parseCollection({ props: PROPS, views: { v1: {} } }).views[0]!
    const server = queryWindow(rows, view, schema, {}, { now: NOW })
    const empty: RowsWindow = { rows: [], next: null, total: 0 }
    const client = applyRowsDelta(empty, { t: 'collection.rows', up: rows.map((row) => ({ row, prev: {} })), rm: [] }, view, schema, { now: NOW })
    const byId = (w: RowsWindow) => Object.fromEntries(w.rows.map((r) => [r.id, r.computed]))
    expect(byId(client)).toEqual(byId(server))
    // 第一行：前面的公式把工作量用完了，后面的都为空；第二行文本很短，全部算得出
    expect(byId(server)['b']).toEqual({ f0: 3 * 199, f1: 4, f2: 3 * 199, f3: 3 })
  })
})

describe('别的恶意写法', () => {
  test('超大的日期运算：为空，不抛', () => {
    const schema = schemaOf([
      'DATEADD([@d], 9999999, "M")',
      'DATEADD([@d], 1e300, "D")',
      'DATE(1e10, 1e10, 1e10)',
      'DATEADD(DATE(9999, 12, 31), 1, "D")',
      'DATEADD(DATE(1, 1, 1), -1, "M")',
      'DATEDIF(DATE(1, 1, 1), DATE(9999, 12, 31), "M")',
      'POWER(10, 400)',
      'MID([@t], 1e308, 1e308)',
    ])
    const { out } = timed(schema, rowsOf(1, { props: { d: '2026-01-31', t: 'abc' } }))
    expect(out[0]!.computed).toEqual({ f5: 119987 })
  })

  test('写在 IFS / SWITCH 里的长分支链、几千项的列表比较：照常算完', () => {
    const schema = schemaOf([pad('IFS(FALSE, 1', ', FALSE, 1', ', 2)'), pad('SWITCH([@n]', ', 0, 0', ', 9)'), '[@m] = [@m]'])
    const { out } = timed(schema, rowsOf(1, { props: { n: 5, m: TAGS } }))
    expect(out[0]!.computed).toEqual({ f0: 2, f1: 9, f2: true })
  })

  test('一个集合里写满一百个最长的公式：解析、编译、算一行都不抛', () => {
    const exprs = Array.from({ length: 100 }, (_, i) => (i % 2 ? pad('1', '+1') : pad('(', '(', '1') + ')'.repeat(49)))
    const schema = schemaOf(exprs)
    const compiled = [...compileFormulas(schema).values()]
    expect(compiled.filter((c) => !c.ok).every((c) => !c.ok && (c.error.code === 'too_long' || c.error.code === 'too_deep' || c.error.code === 'syntax'))).toBe(true)
    expect(() => fillFormulas(rowsOf(10, {}), schema, { now: NOW })).not.toThrow()
  })
})
