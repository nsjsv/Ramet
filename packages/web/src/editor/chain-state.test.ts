import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { chainRestAfter } from './chain-state'

// 失败条上继续剩下的只在这条失败回复是文档里最后一条回复、且最后一条用户消息点名的 agent 还没轮完时才有，
// 规则与服务端同一个函数（@ramet/shared/mention-chain）。

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    user_message: { group: 'block', content: 'paragraph+' },
    agent_reply: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' } } },
    agent_mention: { group: 'inline', inline: true, atom: true, attrs: { agentId: { default: '' }, label: { default: '' } } },
    text: { group: 'inline' },
  },
})

const para = (...inline: PMNode[]) => schema.node('paragraph', null, inline)
const mention = (agentId: string) => schema.node('agent_mention', { agentId, label: agentId })
const message = (...agents: string[]) => schema.node('user_message', null, [para(schema.text('写'), ...agents.map(mention))])
const reply = (id: string) => schema.node('agent_reply', { id }, [para()])
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)

test('点名两家，第一家失败：失败条上剩 1 个；链走完 / 不是最后一条回复 / 没点名 → 0', () => {
  expect(chainRestAfter(doc(message('a', 'b'), reply('r1')), 'r1')).toBe(1)
  expect(chainRestAfter(doc(message('a', 'b', 'c'), reply('r1')), 'r1')).toBe(2)
  expect(chainRestAfter(doc(message('a', 'b'), reply('r1'), reply('r2')), 'r2')).toBe(0) // 第二家也轮过了
  expect(chainRestAfter(doc(message('a', 'b'), reply('r1'), reply('r2')), 'r1')).toBe(0) // r1 后面已经有别的回复
  expect(chainRestAfter(doc(message(), reply('r1')), 'r1')).toBe(0) // 没点名
  expect(chainRestAfter(doc(message('a', 'b'), reply('r1'), message('c'), reply('r2')), 'r2')).toBe(0) // 只认最后一条消息的链
})
