import { describe, expect, test } from 'vitest'
import type { Action } from '../automation-api'
import {
  actionOf,
  changedFields,
  defaultScheduleDraft,
  dormantFix,
  draftOf,
  errorIndex,
  finishedOnce,
  groupRules,
  hasEventRow,
  insertVar,
  moveItem,
  newAction,
  normalizeTime,
  pageChoices,
  ruleSpace,
  scheduleDraftOf,
  scheduleOf,
  valueText,
  varsFor,
} from './rule-model'
import { CREATABLE, isFail, triggerSpec } from './triggers'

const MSG = { noAt: 'noAt', badTime: 'badTime', noDays: 'noDays', badMinutes: 'badMinutes' }
const NOW = new Date(2026, 10, 6, 14, 3)
const strip = <T extends { uid: string }>(d: T): Omit<T, 'uid'> => {
  const { uid: _uid, ...rest } = d
  return rest
}

describe('来源分组', () => {
  test('按组排好、只留非空的组，组内保持原顺序；认不出的来源归「其他」', () => {
    const rules = [
      { id: '1', source: 'comment' },
      { id: '2', source: 'timer' },
      { id: '3', source: 'webhook' },
      { id: '4', source: 'future_thing' },
      { id: '5', source: 'timer' },
    ]
    expect(groupRules(rules).map((g) => [g.group, g.rules.map((r) => r.id)])).toEqual([
      ['timer', ['2', '5']],
      ['event', ['1', '3']],
      ['other', ['4']],
    ])
    expect(groupRules([])).toEqual([])
  })

  test('内置规则单独一组排在最前，不跟同来源的普通规则混', () => {
    const rules = [
      { id: 'b1', source: 'comment', builtin: 'comment' },
      { id: 'b2', source: 'mention', builtin: 'mention' },
      { id: '1', source: 'timer', builtin: null },
      { id: '2', source: 'webhook' },
    ]
    expect(groupRules(rules).map((g) => [g.group, g.rules.map((r) => r.id)])).toEqual([
      ['builtin', ['b1', 'b2']],
      ['timer', ['1']],
      ['event', ['2']],
    ])
  })

  test('还不能生效的补救按 code 认：没模型连接去设置、没 Genet 页去打开 Genet，认不出的不给按钮', () => {
    expect(dormantFix({ code: 'no_connection', text: '配好模型连接后生效' })).toBe('settings')
    expect(dormantFix({ code: 'no_genet_page', text: '打开一次 AI 页后生效' })).toBe('genet')
    expect(dormantFix({ code: 'later', text: '配好模型连接后生效' })).toBeNull()
    expect(dormantFix(null)).toBeNull()
    expect(dormantFix(undefined)).toBeNull()
  })

  test('已经触发过的一次性定时不给开关', () => {
    const base = { source: 'timer', config: { kind: 'once', at: '2026-11-07T09:00' }, enabled: false, last: { status: 'delivered' as const, reason: '', at: 'x', results: [] } }
    expect(finishedOnce(base)).toBe(true)
    expect(finishedOnce({ ...base, last: null })).toBe(false)
    expect(finishedOnce({ ...base, enabled: true })).toBe(false)
    expect(finishedOnce({ ...base, config: { kind: 'daily', time: '09:00' } })).toBe(false)
  })
})

describe('触发注册表', () => {
  test('定时、盯页面、收到外部请求、合集里有变化能新建（评论 / 正文提及登记了表单，但只有内置规则）；缺省是每天 09:00，config 往返不变', () => {
    expect(CREATABLE).toEqual(['timer', 'page_watch', 'collection', 'webhook'])
    // 收到外部请求的配置由服务端写：草稿只拿末 4 位来显示，发回去永远是空对象
    const hook = triggerSpec('webhook')!
    expect(hook.draftOf({ hint: 'ab_c' }, new Date())).toEqual({ hint: 'ab_c' })
    expect(hook.configOf(hook.draftOf({ hint: 'ab_c' }, new Date()))).toEqual({})
    expect(triggerSpec('comment')?.builtinOnly).toBe(true)
    expect(triggerSpec('mention')?.builtinOnly).toBe(true)
    expect(triggerSpec('ai_block')).toBeNull()
    // 按钮的规则只从按钮上建
    expect(triggerSpec('button')?.hidden).toBe(true)
    const spec = triggerSpec('timer')!
    expect(spec.configOf(spec.initial(NOW))).toEqual({ kind: 'daily', time: '09:00' })
    for (const config of [
      { kind: 'once', at: '2026-11-07T09:00' },
      { kind: 'daily', time: '07:30' },
      { kind: 'weekly', days: [1, 3], time: '09:00' },
      { kind: 'every', minutes: 120 },
    ]) {
      expect(spec.configOf(spec.draftOf(config, NOW))).toEqual(config)
    }
    expect(isFail(spec.configOf({ ...defaultScheduleDraft(NOW), kind: 'weekly', days: [] }))).toBe(true)
  })

  test('缺省草稿：一次 = 明天 09:00，每周 = 工作日，每隔 = 60 分钟', () => {
    const d = defaultScheduleDraft(NOW)
    expect(d.at).toBe('2026-11-07T09:00')
    expect(d.days).toEqual([1, 2, 3, 4, 5])
    expect(d.minutes).toBe(60)
    expect(scheduleDraftOf({ kind: 'nonsense' }, NOW)).toEqual(d)
  })
})

describe('时间表', () => {
  test('几点的写法规整成 HH:MM', () => {
    expect(normalizeTime('9:00')).toBe('09:00')
    expect(normalizeTime('09：30')).toBe('09:30')
    expect(normalizeTime('9')).toBe('09:00')
    expect(normalizeTime('930')).toBe('09:30')
    expect(normalizeTime('2359')).toBe('23:59')
    expect(normalizeTime('24:00')).toBeNull()
    expect(normalizeTime('9:60')).toBeNull()
    expect(normalizeTime('早上')).toBeNull()
  })

  test('草稿 → 时间表：每周去重排序，没填 / 写错给原因', () => {
    const d = defaultScheduleDraft(NOW)
    expect(scheduleOf({ ...d, kind: 'weekly', days: [5, 1, 5], time: '8' }, MSG)).toEqual({ kind: 'weekly', days: [1, 5], time: '08:00' })
    expect(scheduleOf({ ...d, kind: 'once', at: null }, MSG)).toEqual({ error: 'noAt' })
    expect(scheduleOf({ ...d, kind: 'daily', time: 'x' }, MSG)).toEqual({ error: 'badTime' })
    expect(scheduleOf({ ...d, kind: 'weekly', days: [] }, MSG)).toEqual({ error: 'noDays' })
    expect(scheduleOf({ ...d, kind: 'every', minutes: 30 }, MSG)).toEqual({ error: 'badMinutes' })
    expect(scheduleOf({ ...d, kind: 'every', minutes: 10081 }, MSG)).toEqual({ error: 'badMinutes' })
    expect(scheduleOf({ ...d, kind: 'every', minutes: null }, MSG)).toEqual({ error: 'badMinutes' })
    expect(scheduleOf({ ...d, kind: 'every', minutes: 90 }, MSG)).toEqual({ kind: 'every', minutes: 90 })
  })
})

describe('动作草稿 ↔ JSON', () => {
  const all: Action[] = [
    { type: 'genet', instruction: '看看 {{page}}' },
    { type: 'agent', page: 'p1', agent: 'codex', instruction: '跑测试' },
    { type: 'set_props', row: 'event', set: { 状态: '完成', 分数: '5' } },
    { type: 'create_page', parent: 'c1', title: '{{now}} 日报', template: 't1', props: { 标签: 'a, b' } },
    { type: 'create_page', parent: 'd1', title: '记录' },
    { type: 'notify', to: 'owner', text: '到点了' },
    { type: 'notify', to: ['u1', 'u2'], text: '{{actor}} 改了' },
    { type: 'webhook', url: 'https://example.com/hook', body: '{"t":"{{text}}"}' },
    { type: 'webhook', url: 'https://example.com/hook' },
  ]

  test('往返不变', () => {
    for (const a of all) expect(actionOf(draftOf(a))).toEqual(a)
  })

  test('非文字的属性值显示成文字（服务端按属性类型换回去）', () => {
    expect(valueText(5)).toBe('5')
    expect(valueText(true)).toBe('true')
    expect(valueText(null)).toBe('')
    expect(valueText(['a', 'b'])).toBe('a, b')
    expect(actionOf(draftOf({ type: 'set_props', row: 'r1', set: { 分数: 5, 完成: true, 标签: ['x', 'y'], 空: null } }))).toEqual({
      type: 'set_props',
      row: 'r1',
      set: { 分数: '5', 完成: 'true', 标签: 'x, y', 空: '' },
    })
  })

  test('转 JSON 时去两头空白、丢掉两边都空的属性行，空模板 / 空请求体不带', () => {
    const d = newAction('create_page', 'timer')
    expect(actionOf({ ...d, parent: 'p', title: '  标题 ', pairs: [{ key: '', value: '' }, { key: ' 状态 ', value: '完成' }] } as typeof d)).toEqual({
      type: 'create_page',
      parent: 'p',
      title: '标题',
      props: { 状态: '完成' },
    })
    expect(actionOf({ ...newAction('webhook', 'timer'), url: ' https://x.test ', body: '  ' } as ReturnType<typeof newAction>)).toEqual({ type: 'webhook', url: 'https://x.test' })
  })

  test('新动作的空表单：事件不带合集行的来源（定时、评论、正文提及）改属性缺省要指定行，别的缺省是事件所在的行', () => {
    expect(strip(newAction('set_props', 'timer'))).toEqual({ type: 'set_props', row: '', pairs: [{ key: '', value: '' }] })
    expect(strip(newAction('set_props', 'comment'))).toMatchObject({ row: '' })
    expect(strip(newAction('set_props', 'mention'))).toMatchObject({ row: '' })
    expect(strip(newAction('set_props', 'page_watch'))).toMatchObject({ row: '' })
    expect(strip(newAction('set_props', 'collection'))).toMatchObject({ row: 'event' })
    expect(hasEventRow('webhook')).toBe(false)
    expect(hasEventRow('collection')).toBe(true)
    expect(strip(newAction('notify', 'timer'))).toEqual({ type: 'notify', to: 'owner', members: [], text: '' })
    expect(newAction('genet', 'timer').uid).not.toBe(newAction('genet', 'timer').uid)
  })
})

describe('列表与错误', () => {
  test('上下移，越界不动', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })

  test('服务端「第 N 个动作」的错误认得出是哪一个', () => {
    expect(errorIndex('第 2 个动作：webhook 地址要是 http(s) 开头的完整地址')).toBe(1)
    expect(errorIndex('第 10 个动作（发通知）：x')).toBe(9)
    expect(errorIndex('名字不能为空')).toBeNull()
  })

  test('只发改了的字段', () => {
    const actions: Action[] = [{ type: 'genet', instruction: 'x' }]
    const baseline = { name: '早报', config: JSON.stringify({ kind: 'daily', time: '09:00' }), actions: JSON.stringify(actions) }
    expect(changedFields(baseline, { name: ' 早报 ', config: { kind: 'daily', time: '09:00' }, actions })).toEqual({})
    expect(changedFields(baseline, { name: '晚报', config: { kind: 'daily', time: '21:00' }, actions })).toEqual({ name: '晚报', config: { kind: 'daily', time: '21:00' } })
    const more: Action[] = [...actions, { type: 'notify', to: 'owner', text: 'y' }]
    expect(changedFields(baseline, { name: '早报', config: undefined, actions: more })).toEqual({ actions: more })
  })
})

describe('变量', () => {
  test('定时器只有现在与规则名，事件来源全有；评论 / 正文提及没有合集行', () => {
    expect(varsFor('timer')).toEqual(['now', 'rule'])
    expect(varsFor('comment')).toEqual(['actor', 'page', 'page_link', 'text', 'now', 'rule'])
    expect(varsFor('mention')).not.toContain('row.属性名')
    expect(varsFor('page_watch')).toEqual(['actor', 'page', 'page_link', 'text', 'now', 'rule'])
    expect(varsFor('collection')).toContain('row.属性名')
  })

  test('在选区处插入，光标落在变量后面', () => {
    expect(insertVar('看看', 2, 2, 'page')).toEqual({ text: '看看{{page}}', caret: 10 })
    expect(insertVar('abc', 1, 2, 'now')).toEqual({ text: 'a{{now}}c', caret: 8 })
    expect(insertVar('', 5, 9, 'rule')).toEqual({ text: '{{rule}}', caret: 8 })
  })
})

describe('选页与空间', () => {
  const pages = [
    { id: 'd1', parent_id: null, kind: 'doc', space_id: 's1' },
    { id: 'c1', parent_id: 'd1', kind: 'collection', space_id: 's1' },
    { id: 'r1', parent_id: 'c1', kind: 'doc', space_id: 's1' },
    { id: 't1', parent_id: null, kind: 'doc', space_id: 's2', is_template: true },
    { id: 'run', parent_id: 'd1', kind: 'run', space_id: 's1' },
  ]

  test('各个选择框列哪些页', () => {
    expect(pageChoices(pages, 'doc').map((p) => p.id)).toEqual(['d1', 'r1', 't1'])
    expect(pageChoices(pages, 'parent').map((p) => p.id)).toEqual(['d1', 'c1', 'r1', 't1'])
    expect(pageChoices(pages, 'row').map((p) => p.id)).toEqual(['r1'])
    expect(pageChoices(pages, 'template').map((p) => p.id)).toEqual(['t1', 'd1', 'r1'])
  })

  test('规则所在空间：挂靠页 > 第一个带页面的动作 > 个人空间', () => {
    const genet = draftOf({ type: 'genet', instruction: 'x' })
    const agent = draftOf({ type: 'agent', page: 't1', agent: 'a', instruction: 'x' })
    const row = draftOf({ type: 'set_props', row: 'event', set: { a: '1' } })
    expect(ruleSpace([genet], null, pages, 'me')).toBe('me')
    expect(ruleSpace([genet, row, agent], null, pages, 'me')).toBe('s2')
    expect(ruleSpace([agent], 'd1', pages, 'me')).toBe('s1')
  })
})
