/* ---------- 规则的动作、变量与事件载荷（纯函数） ---------- */
import { describe, expect, it } from 'vitest'
import { ASSISTANT_ID } from '../agents/assistant-agent.js'
import { actionReason, describeAction, hasAi, parseActions, type Action } from './actions.js'
import { cleanPayload, detailLines, eventCause } from './payload.js'
import { expand, expandValue, jsonEscape, templateVars } from './template.js'

describe('parseActions', () => {
  it('六种动作都认得，去掉两头空白、page: 前缀；缺省的 row = event、to = owner', () => {
    const parsed = parseActions([
      { type: 'genet', instruction: '  看看  ' },
      { type: 'agent', page: 'page:p1', agent: 'fake', instruction: '巡检' },
      { type: 'set_props', set: { 状态: '完成', 数量: 3, 标签: ['a', 'b'], 勾选: true, 清空: null } },
      { type: 'create_page', parent: 'c1', title: '{{text}}', template: '', props: { 状态: '新' } },
      { type: 'notify', text: '有新评论', to: ['u1', 'u1', ' u2 '] },
      { type: 'webhook', url: 'https://example.com/hook', body: '{"t":"{{text}}"}' },
    ])
    expect(parsed).toEqual([
      { type: 'genet', instruction: '看看' },
      { type: 'agent', page: 'p1', agent: 'fake', instruction: '巡检' },
      { type: 'set_props', row: 'event', set: { 状态: '完成', 数量: 3, 标签: ['a', 'b'], 勾选: true, 清空: null } },
      { type: 'create_page', parent: 'c1', title: '{{text}}', props: { 状态: '新' } },
      { type: 'notify', text: '有新评论', to: ['u1', 'u2'] },
      { type: 'webhook', url: 'https://example.com/hook', body: '{"t":"{{text}}"}' },
    ])
    expect(parseActions([{ type: 'notify', text: 'x' }])).toEqual([{ type: 'notify', to: 'owner', text: 'x' }])
  })

  it('拒绝：空 / 超过 10 个、类型不认、字段缺失或超长、叫 agent 指定 Genet、webhook 不是 http(s)、属性值是对象；多个动作时写明第几个', () => {
    const bad = (raw: unknown): string => {
      const r = parseActions(raw)
      return 'error' in r ? r.error : ''
    }
    expect(bad([])).toBe('至少要有一个动作')
    expect(bad(null)).toBe('至少要有一个动作')
    expect(bad(Array.from({ length: 11 }, () => ({ type: 'genet', instruction: 'x' })))).toContain('最多 10 个')
    expect(bad([{ type: 'shell' }])).toContain('动作类型只能是')
    expect(bad([{ type: 'genet', instruction: ' ' }])).toBe('给 Genet 的指令不能为空')
    expect(bad([{ type: 'genet', instruction: 'x'.repeat(4001) }])).toContain('最多 4000 个字')
    expect(bad([{ type: 'agent', page: 'p', agent: ASSISTANT_ID, instruction: 'x' }])).toContain('叫 Genet')
    expect(bad([{ type: 'agent', page: 'p', instruction: 'x' }])).toContain('agent')
    expect(bad([{ type: 'set_props', set: {} }])).toContain('至少改一个')
    expect(bad([{ type: 'set_props', set: { a: { b: 1 } } }])).toContain('写法不对')
    expect(bad([{ type: 'create_page', parent: 'p' }])).toBe('标题不能为空')
    expect(bad([{ type: 'notify', text: 'x', to: [] }])).toContain('通知发给谁')
    expect(bad([{ type: 'webhook', url: 'ftp://x' }])).toContain('http(s)')
    expect(bad([{ type: 'webhook', url: 'not a url' }])).toContain('http(s)')
    expect(bad([{ type: 'genet', instruction: 'x' }, { type: 'webhook', url: 'x' }])).toMatch(/^第 2 个动作：/)
  })

  it('hasAi / actionReason / describeAction', () => {
    const genet: Action = { type: 'genet', instruction: 'x' }
    const note: Action = { type: 'notify', to: 'owner', text: '有新评论' }
    expect(hasAi([note])).toBe(false)
    expect(hasAi([note, genet])).toBe(true)
    expect(actionReason([genet], 0, '原因')).toBe('原因')
    expect(actionReason([note, genet], 1, '原因')).toBe('第 2 个动作（叫 Genet）：原因')
    expect(describeAction(note)).toBe('通知我：有新评论')
    expect(describeAction({ type: 'agent', page: 'p', agent: 'fake', instruction: '跑' }, { page: () => '周报', agent: () => 'Fake' })).toBe('叫 Fake 在《周报》：跑')
  })
})

describe('变量与载荷', () => {
  const payload = cleanPayload(
    {
      source: 'comment',
      actor: { id: 'u1', name: 'bob' },
      page: { id: 'p1', title: '周报' },
      row: { id: 'r1', props: { 状态: '进行中', 数量: 3 } },
      text: '请看一下 "这里"',
      changes: [{ prop: '状态', from: '', to: '进行中' }, { nope: 1 }],
      junk: 'x',
    },
    'timer',
  )

  it('cleanPayload 只留认得的键、值都成文字；来源认不出用缺省', () => {
    expect(payload).toEqual({
      source: 'comment',
      actor: { id: 'u1', name: 'bob' },
      page: { id: 'p1', title: '周报' },
      row: { id: 'r1', props: { 状态: '进行中', 数量: '3' } },
      text: '请看一下 "这里"',
      changes: [{ prop: '状态', from: '', to: '进行中' }],
    })
    expect(cleanPayload({ source: 'nope', text: 'x'.repeat(5000) }, 'webhook')).toMatchObject({ source: 'webhook' })
    expect([...(cleanPayload({ text: 'x'.repeat(5000) }, 'webhook').text ?? '')].length).toBe(4001)
    expect(eventCause(payload)).toBe('bob 在《周报》的评论')
    expect(eventCause({ source: 'webhook' })).toBe('外部请求')
    expect(eventCause({ source: 'button', page: { id: 'p', title: '' } })).toBe('在《无标题》的按钮')
    expect(eventCause({ source: 'timer' })).toBe('定时')
    expect(detailLines(payload)).toEqual(['行 row:r1 · 状态：进行中 · 数量：3', '状态：（空） → 进行中'])
  })

  it('extra 是 [说明, 值] 的列表：顺序照来源给的（JSONB 不会重排数组），空说明丢掉；对象也收', () => {
    const extra = [['评论串', 't1'], ['为什么找你', '评论里 @了你'], ['', 'x'], ['链接', '/page/p1?comment=t1'], 'junk']
    const p = cleanPayload({ source: 'comment', extra }, 'timer')
    expect(p.extra).toEqual([['评论串', 't1'], ['为什么找你', '评论里 @了你'], ['链接', '/page/p1?comment=t1']])
    expect(detailLines(p)).toEqual(['评论串：t1', '为什么找你：评论里 @了你', '链接：/page/p1?comment=t1'])
    expect(cleanPayload({ extra: { 按钮: '发布', 次数: 2 } }, 'button').extra).toEqual([['按钮', '发布'], ['次数', '2']])
    expect(cleanPayload({ extra: [] }, 'button').extra).toBeUndefined()
  })

  it('expand：认得的变量展开、row.<名> 取行属性、认不出的原样留着；JSON 转义', () => {
    const vars = templateVars(payload, '评论找我', new Date('2026-11-06T06:03:00Z'), 'Asia/Shanghai')
    expect(expand('{{actor}} 在 {{page}}：{{text}}（{{rule}} · {{now}}）', vars)).toBe('bob 在 周报：请看一下 "这里"（评论找我 · 2026-11-06 周五 14:03）')
    expect(expand('{{ row.状态 }} / {{row.数量}} / {{row.没有}} / {{nope}}', vars)).toBe('进行中 / 3 / {{row.没有}} / {{nope}}')
    expect(expand('{{page_link}}', vars)).toBe('[@周报](page:p1)')
    expect(expand('{"t":"{{text}}"}', vars, jsonEscape)).toBe('{"t":"请看一下 \\"这里\\""}')
    expect(JSON.parse(expand('{"t":"{{text}}"}', vars, jsonEscape))).toEqual({ t: '请看一下 "这里"' })
    expect(expandValue(['{{actor}}', 3], vars)).toEqual(['bob', 3])
    const timer = templateVars({ source: 'timer' }, '早报', new Date(), 'UTC')
    expect(expand('[{{actor}}]', timer)).toBe('[]')
  })
})
