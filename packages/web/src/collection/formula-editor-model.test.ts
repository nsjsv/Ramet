import { describe, expect, test } from 'vitest'
import { checkFormula, complete, FUNCTION_DOCS, parseCollection, toStored, type CollectionRow } from '@ramet/shared/collection-model'
import { FORMULA_FN_DOCS } from './formula-docs'
import { applySuggestion, docGroups, insertText, markParts, previewRow, stepIndex, summary } from './formula-editor-model'

const T = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'

/** 函数说明的示例里用到的属性（同名同类型），外加正在编辑的公式 fx0001 */
const schema = parseCollection({
  props: {
    pri: { name: '单价', type: 'number', pos: 0 },
    qty: { name: '数量', type: 'number', pos: 1 },
    don: { name: '完成', type: 'checkbox', pos: 2 },
    beg: { name: '开始', type: 'date', pos: 3 },
    tag: { name: '标签', type: 'multi_select', pos: 4, options: { ta: { name: '重要', pos: 0 } } },
    sts: {
      name: '状态',
      type: 'status',
      pos: 5,
      options: { st: { name: '进行中', group: 'doing', pos: 0 }, sd: { name: '已完成', group: 'done', pos: 0 } },
    },
    txt: { name: '备注', type: 'text', pos: 6 },
    uid: { name: '编号', type: 'unique_id', pos: 7 },
    sub: { name: '子任务', type: 'relation', pos: 8, cfg: { target: T, reverse: null, single: false } },
    fx0001: { name: '结果', type: 'formula', pos: 9, cfg: { expr: '' } },
  },
  views: { v1: { name: '表格', layout: 'board', groupBy: 'sts', pos: 0 } },
})

describe('函数说明', () => {
  test('每个函数都有中文说明与示例，没有多余的', () => {
    const names = FUNCTION_DOCS.map((d) => d.name)
    expect(Object.keys(FORMULA_FN_DOCS).sort()).toEqual([...names].sort())
    for (const name of names) {
      const doc = FORMULA_FN_DOCS[name]!
      expect(doc.desc.trim(), name).not.toBe('')
      expect(doc.example.trim(), name).not.toBe('')
    }
  })

  test('示例都写得对：在一份带这些属性的定义里编译通过，并且真的用到了这个函数', () => {
    for (const [name, doc] of Object.entries(FORMULA_FN_DOCS)) {
      const check = checkFormula(doc.example, schema, 'fx0001')
      expect(check.ok ? 'ok' : `${name}: ${check.error.message}`).toBe('ok')
      expect(doc.example.toUpperCase()).toContain(`${name}(`)
    }
  })

  test('检索：按函数名或说明里的字，分组顺序同函数表', () => {
    const all = docGroups('')
    expect(all.map((g) => g.group)).toEqual(['logic', 'math', 'text', 'date', 'list'])
    expect(all.flatMap((g) => g.items).length).toBe(FUNCTION_DOCS.length)
    expect(docGroups('date').flatMap((g) => g.items.map((i) => i.name))).toEqual(['DATE', 'DATEDIF', 'DATEADD'])
    expect(docGroups('  round ').flatMap((g) => g.items.map((i) => i.name))).toEqual(['ROUND', 'ROUNDUP', 'ROUNDDOWN'])
    // 说明里的字也能搜到
    expect(docGroups('平方根').flatMap((g) => g.items.map((i) => i.name))).toEqual(['SQRT'])
    expect(docGroups('没有这种函数')).toEqual([])
    expect(all[0]!.items[0]).toMatchObject({ name: 'IF', signature: 'IF(条件, 真值, [假值])', example: 'IF([完成], "✅", "⏳")' })
  })
})

describe('出错区段', () => {
  test('按位置切三段；空区段至少标一个字，在末尾标一个空格', () => {
    expect(markParts('1 + [单价', [4, 7])).toEqual({ before: '1 + ', mark: '[单价', after: '' })
    expect(markParts('IF(1, 2', [2, 2])).toEqual({ before: 'IF', mark: '(', after: '1, 2' })
    expect(markParts('1 +', [3, 3])).toEqual({ before: '1 +', mark: ' ', after: '' })
    // 越界的位置收进文本里
    expect(markParts('ab', [5, 9])).toEqual({ before: 'ab', mark: ' ', after: '' })
    expect(markParts('ab', undefined)).toBeNull()
  })

  test('与 checkFormula 的位置对得上（显示形）', () => {
    const check = checkFormula('[单价] + [备注] * 2', schema, 'fx0001')
    expect(check.ok).toBe(false)
    if (!check.ok) expect(markParts('[单价] + [备注] * 2', check.error.at)?.mark).toBe('[备注] * 2')
  })
})

describe('补全与插入', () => {
  test('接受属性补全：换掉没写完的引用（含已有的右括号）', () => {
    const [s] = complete('1 + [单', 6, schema, 'fx0001')
    expect(applySuggestion('1 + [单', s!)).toEqual({ text: '1 + [单价]', caret: 8 })
    const [t] = complete('[单] * 2', 2, schema, 'fx0001')
    expect(applySuggestion('[单] * 2', t!)).toEqual({ text: '[单价] * 2', caret: 4 })
  })

  test('接受函数补全：补上左括号；后面已有左括号就不再补，光标越过它', () => {
    const [s] = complete('1 + su', 6, schema)
    expect(applySuggestion('1 + su', s!)).toEqual({ text: '1 + SUM(', caret: 8 })
    const [t] = complete('rou(1)', 3, schema)
    expect(t!.label).toBe('ROUND')
    expect(applySuggestion('rou(1)', t!)).toEqual({ text: 'ROUND(1)', caret: 6 })
  })

  test('点函数说明：插到光标处 / 换掉选中的字', () => {
    expect(insertText('1 + ', 4, 4, 'ABS(')).toEqual({ text: '1 + ABS(', caret: 8 })
    expect(insertText('a b c', 2, 3, 'X')).toEqual({ text: 'a X c', caret: 3 })
    expect(insertText('ab', 9, 9, 'X')).toEqual({ text: 'abX', caret: 3 })
  })

  test('上下移动绕回', () => {
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(1, 1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })

  test('存储形写的是 id：补全出来的显示形保存后改名也不坏', () => {
    expect(toStored('[单价] * [数量]', schema)).toEqual({ ok: true, expr: '[@pri] * [@qty]' })
  })
})

describe('预览用哪一行', () => {
  const row = (id: string): CollectionRow => ({ id, title: id, icon: null, props: {}, position: null, created_at: '', edited_at: '', has_body: false })
  const view = schema.views[0]!
  const win = (rows: CollectionRow[]) => ({ window: { rows } })

  test('不按组取的窗口有行就用它的第一行', () => {
    const source = { windowState: (_v: string, scope?: { group?: string }) => (scope?.group === undefined ? win([row('a'), row('b')]) : win([])) }
    expect(previewRow(source, schema, view)?.id).toBe('a')
  })

  test('看板按组取：按组的顺序找第一张卡片；都没有 = undefined', () => {
    const byGroup: Record<string, CollectionRow[]> = { st: [], sd: [row('c')] }
    const source = { windowState: (_v: string, scope?: { group?: string }) => (scope?.group === undefined ? { window: null } : win(byGroup[scope.group] ?? [])) }
    expect(previewRow(source, schema, view)?.id).toBe('c')
    expect(previewRow({ windowState: () => ({ window: null }) }, schema, view)).toBeUndefined()
    expect(previewRow({ windowState: () => ({ window: null }) }, schema, { ...view, groupBy: null })).toBeUndefined()
  })
})

test('摘要：空白并成一个空格，超长按码点截断加省略号', () => {
  expect(summary('IF([完成],\n  "✅",\n  "⏳")')).toBe('IF([完成], "✅", "⏳")')
  expect(summary('😀'.repeat(60), 10)).toBe(`${'😀'.repeat(9)}…`)
  expect(summary('   ')).toBe('')
})
