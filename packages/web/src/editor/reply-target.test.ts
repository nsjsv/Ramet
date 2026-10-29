import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { redoableUserIds, replyTargetOf } from './reply-target'

/* 不变量：用户气泡的「重新回复」—— 后面有回复 = 重新生成它；最后一条且没回复 = 直接发；
 * 没回复又不是最后一条 = 不给（continue 只认最后一条）。redoableUserIds 与 replyTargetOf 同口径 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    user_message: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, agent: { default: '' } } },
    agent_reply: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' } } },
    text: { group: 'inline' },
  },
})

const para = (text = '') => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const message = (id: string, text = '问', agent = '') => schema.node('user_message', { id, agent }, [para(text)])
const reply = (id: string) => schema.node('agent_reply', { id }, [para('答')])
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)

test('后面有回复 → 重新生成那一条；点名链多条回复取第一条；中间隔着普通段落也算', () => {
  expect(replyTargetOf(doc(message('u1'), reply('r1')), 'u1')).toEqual({ kind: 'regen', replyId: 'r1' })
  expect(replyTargetOf(doc(message('u1'), reply('r1'), reply('r2')), 'u1')).toEqual({ kind: 'regen', replyId: 'r1' })
  expect(replyTargetOf(doc(message('u1'), para('旁注'), reply('r1')), 'u1')).toEqual({ kind: 'regen', replyId: 'r1' })
})

test('回复被删掉：最后一条直接发（带消息自己指定的 agent）；不是最后一条 / 空消息 / 不存在 → null', () => {
  expect(replyTargetOf(doc(message('u1', '问', 'codex')), 'u1')).toEqual({ kind: 'send', agent: 'codex' })
  expect(replyTargetOf(doc(message('u1'), reply('r1'), message('u2')), 'u2')).toEqual({ kind: 'send', agent: '' })
  expect(replyTargetOf(doc(message('u1'), message('u2'), reply('r2')), 'u1')).toBeNull()
  expect(replyTargetOf(doc(message('u1', '')), 'u1')).toBeNull()
  expect(replyTargetOf(doc(message('u1')), 'nope')).toBeNull()
})

test('redoableUserIds 一趟扫出的集合与逐条 replyTargetOf 一致', () => {
  const d = doc(message('u1'), reply('r1'), message('u2'), message('u3'), reply('r3'), message('u4'))
  expect([...redoableUserIds(d)].sort()).toEqual(['u1', 'u3', 'u4'])
  for (const id of ['u1', 'u2', 'u3', 'u4']) expect(redoableUserIds(d).has(id)).toBe(replyTargetOf(d, id) !== null)
  expect([...redoableUserIds(doc(message('u1'), message('u2', '')))]).toEqual([])
})
