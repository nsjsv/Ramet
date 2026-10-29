import { Fragment, Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { carryBlockIds } from './block-carry'

// 不变量：整段 / 整篇重新解析写回时，内容没变的块保住 id（含嵌套列表项）；夹在锚点之间一一对应的改动块按位置接上；
// 真正新增的块没有 id；每个旧 id 最多用一次；单块替换第一块无条件继承

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', attrs: { id: { default: '' } } },
    heading: { group: 'block', content: 'text*', attrs: { id: { default: '' }, level: { default: 1 } } },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { id: { default: '' } } },
    list_item: { content: 'paragraph block*', attrs: { id: { default: '' } } },
    agent_reply: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, plan: { default: '' }, team: { default: '' } } },
    text: {},
  },
  marks: { strong: {} },
})

const p = (text: string, id = '') => schema.node('paragraph', { id }, text ? [schema.text(text)] : [])
const h = (text: string, level = 1, id = '') => schema.node('heading', { id, level }, [schema.text(text)])
const li = (text: string, id = '', ...nested: PMNode[]) => schema.node('list_item', { id }, [p(text), ...nested])
const ul = (id: string, ...items: PMNode[]) => schema.node('bullet_list', { id }, items)
const frag = (...nodes: PMNode[]) => Fragment.fromArray(nodes)
const ids = (f: Fragment): string[] => {
  const out: string[] = []
  f.descendants?.((n) => {
    if (typeof n.attrs.id === 'string' && n.attrs.id) out.push(n.attrs.id)
  })
  return out
}
const topIds = (f: Fragment): string[] => f.content.map((n) => String(n.attrs.id))

test('内容相同的块保住 id（含嵌套列表项）；位置移动、中间插入新块不影响对上的', () => {
  const old = frag(p('第一段', 'a'), h('标题', 2, 'b'), ul('c', li('条目', 'c1', ul('', li('嵌套', 'c2')))), p('末段', 'd'))
  const fresh = frag(p('第一段'), p('新插入的'), h('标题', 2), ul('', li('条目', '', ul('', li('嵌套')))), p('末段'))
  const out = carryBlockIds(old, fresh)
  expect(topIds(out)).toEqual(['a', '', 'b', 'c', 'd'])
  expect(ids(Fragment.from(out.child(3)))).toEqual(['c', 'c1', 'c2'])
})

test('改了几个字的块按位置接上（数量与类型一一对应的空隙）；改了标题级别 / 加了粗体也还是同一块', () => {
  const old = frag(p('开头', 'a'), p('旧的话', 'b'), p('结尾', 'c'), h('小标题', 3, 'd'))
  const fresh = frag(p('开头'), p('改过的话'), p('结尾'), h('小标题', 2))
  expect(topIds(carryBlockIds(old, fresh))).toEqual(['a', 'b', 'c', 'd'])
  const bold = frag(schema.node('paragraph', { id: '' }, [schema.text('开头', [schema.mark('strong')])]))
  expect(topIds(carryBlockIds(frag(p('开头', 'a')), bold))).toEqual(['a'])
})

test('数量对不上的改动不乱配：新增的块没有 id，旧 id 不会被两个块抢用', () => {
  const old = frag(p('甲', 'a'), p('乙', 'b'))
  const fresh = frag(p('甲'), p('完全不同的一段'), p('又一段'))
  expect(topIds(carryBlockIds(old, fresh))).toEqual(['a', '', ''])
  const dup = carryBlockIds(frag(p('同', 'x')), frag(p('同'), p('同')))
  expect(topIds(dup).filter((id) => id === 'x')).toHaveLength(1)
})

test('forceFirst：单块替换时第一块无条件继承旧 id（标题改成正文也是同一块），其余是新块', () => {
  const out = carryBlockIds(frag(h('标题', 2, 'h1')), frag(p('改成正文了'), p('又多出一段')), { forceFirst: true })
  expect(topIds(out)).toEqual(['h1', ''])
  // 不开 forceFirst 时类型不同不会接
  expect(topIds(carryBlockIds(frag(h('标题', 2, 'h1')), frag(p('改成正文了'))))).toEqual([''])
})

test('AI 回复块的计划清单（plan 属性）跟着 id 一起带过去；对不上的回复块不借用别人的计划', () => {
  const reply = (text: string, id = '', plan = '') => schema.node('agent_reply', { id, plan }, [p(text)])
  const plan = '[{"content":"读代码","status":"completed"}]'
  const old = frag(reply('回答一', 'r1', plan), p('中间', 'm'), reply('回答二', 'r2'))
  const fresh = frag(reply('回答一'), p('中间'), reply('回答二'))
  const out = carryBlockIds(old, fresh)
  expect(out.child(0).attrs).toMatchObject({ id: 'r1', plan })
  expect(out.child(2).attrs).toMatchObject({ id: 'r2', plan: '' })
  // 新解析出来的块自己带了 plan 就不覆盖
  const own = frag(reply('回答一', '', '[]'))
  expect(carryBlockIds(frag(reply('回答一', 'r1', plan)), own).child(0).attrs.plan).toBe('[]')
})

test('AI 回复块的带队进度（team 属性）同 plan：对上了就一起带过去，新块自带的不覆盖', () => {
  const reply = (text: string, id = '', team = '') => schema.node('agent_reply', { id, team }, [p(text)])
  const team = '{"planId":"p1","title":"计划","leader":"claude","status":"done","tasks":[]}'
  const out = carryBlockIds(frag(reply('回答一', 'r1', team), reply('回答二', 'r2')), frag(reply('回答一'), reply('回答二')))
  expect(out.child(0).attrs).toMatchObject({ id: 'r1', team })
  expect(out.child(1).attrs).toMatchObject({ id: 'r2', team: '' })
  expect(carryBlockIds(frag(reply('回答一', 'r1', team)), frag(reply('回答一', '', '{}'))).child(0).attrs.team).toBe('{}')
})
