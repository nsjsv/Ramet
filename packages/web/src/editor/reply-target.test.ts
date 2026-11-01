import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { isLastReply, lastReply, redoableUserIds, replyTargetOf, resumableReply, resumes } from './reply-target'

/* 不变量：用户气泡的「重新回复」—— 后面有回复 = 重新生成它；最后一条且没回复 = 直接发；
 * 没回复又不是最后一条 = 不给（continue 只认最后一条）。redoableUserIds 与 replyTargetOf 同口径 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    user_message: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, agent: { default: '' } } },
    agent_reply: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, team: { default: '' } } },
    text: { group: 'inline' },
  },
})

const para = (text = '') => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const message = (id: string, text = '问', agent = '') => schema.node('user_message', { id, agent }, [para(text)])
const reply = (id: string, team = '') => schema.node('agent_reply', { id, team }, [para('答')])
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

/* 不变量：续跑只给页面上最后一块回复（之后没有用户消息 / 回复；普通段落、空段落不算），与服务端 resumeTarget 同口径；
 * 带队轮不续 */

test('最后一块回复：之后只有普通段落仍是最后一块；之后有回复 / 用户消息就不是', () => {
  expect(isLastReply(doc(message('u1'), reply('r1')), 'r1')).toBe(true)
  expect(isLastReply(doc(message('u1'), reply('r1'), para(), para('旁注')), 'r1')).toBe(true)
  expect(isLastReply(doc(message('u1'), reply('r1'), reply('r2')), 'r1')).toBe(false)
  expect(isLastReply(doc(message('u1'), reply('r1'), reply('r2')), 'r2')).toBe(true)
  expect(isLastReply(doc(message('u1'), reply('r1'), message('u2')), 'r1')).toBe(false)
  expect(isLastReply(doc(message('u1'), reply('r1'), message('u2', '')), 'r1')).toBe(false)
  expect(isLastReply(doc(message('u1')), 'r1')).toBe(false)
  expect(isLastReply(doc(message('u1'), reply('r1')), 'nope')).toBe(false)
  expect(isLastReply(doc(message('u1'), reply('')), '')).toBe(false)
})

test('续跑：最后一块且不是带队轮；装饰用的 resumes 与点击时现算的 resumableReply 一致', () => {
  const d = doc(message('u1'), reply('r1'), message('u2'), reply('r2'))
  const last = lastReply(d)
  expect(last?.attrs.id).toBe('r2')
  expect(resumableReply(d, 'r2')).toBe(true)
  expect(resumableReply(d, 'r1')).toBe(false)
  d.forEach((node) => {
    if (node.type.name === 'agent_reply') expect(resumes(node, last)).toBe(resumableReply(d, String(node.attrs.id)))
  })
  const team = doc(message('u1'), reply('r1', '{"status":"done"}'))
  expect(isLastReply(team, 'r1')).toBe(true)
  expect(resumableReply(team, 'r1')).toBe(false)
  expect(resumes(team.child(1), lastReply(team))).toBe(false)
})
