import { describe, expect, test } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import type { AgentInfo, Page, Space } from '../api'
import { findAgent, pickAgent } from '../default-agent'
import { catalogForPage } from '../editor/agent-bar'
import { agentBadge, agentName } from '../editor/agent-badge'
import { mentionAgents } from '../editor/mention-sources'
import { nextMention } from '../editor/chain-state'
import { replyAgentOf, spaceAiOffReason } from '../editor/space-ai-run'
import { ASSISTANT_ID, builtinAgent, capsOf, pageCatalog, SPACE_AI_ID, spaceAiName } from './identity'
import { normalizeSpaceAiName, spaceAiOfPage, spaceAiOfSpace, subscribeSpaceAi, syncSpaceAi } from './space-ai'

const space = (id: string, ai: Space['ai'], personal = false): Space =>
  ({ id, name: id, owner_id: 'u1', is_personal: personal, created_at: '', my_role: 'member', ai }) as Space
const page = (id: string, spaceId: string, title = id): Page => ({ id, space_id: spaceId, title }) as Page

const TEAM_ON = space('team', { enabled: true, name: '小助手' })
const TEAM_OFF = space('off', { enabled: false, name: 'AI' })
const MINE = space('mine', null, true)
const PAGES = [page('p-team', 'team'), page('p-off', 'off'), page('p-mine', 'mine')]

const codex: AgentInfo = { id: 'c:m1:codex', label: '机器 · Codex' }
const claude: AgentInfo = { id: 'claude', label: 'Claude' }
const catalog = [codex, claude]
const NONE = { choice: null, lock: '' }
const ids = (list: readonly AgentInfo[]) => list.map((a) => a.id)

describe('空间 AI 的数据：按页面所在空间', () => {
  test('个人空间没有空间 AI；团队空间没配过 / 老缓存里没有 ai 按没启用、名字 AI', () => {
    expect(spaceAiOfSpace(MINE)).toBeNull()
    expect(spaceAiOfSpace(undefined)).toBeNull()
    expect(spaceAiOfSpace(TEAM_ON)).toEqual({ spaceId: 'team', enabled: true, name: '小助手' })
    expect(spaceAiOfSpace(space('old', undefined))).toEqual({ spaceId: 'old', enabled: false, name: 'AI' })
  })

  test('页面 → 空间 → 空间 AI；不知道这一页在哪（公开页、列表没到）是 null', () => {
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES)
    expect(spaceAiOfPage('p-team')).toMatchObject({ enabled: true, name: '小助手' })
    expect(spaceAiOfPage('p-off')).toMatchObject({ enabled: false })
    expect(spaceAiOfPage('p-mine')).toBeNull()
    expect(spaceAiOfPage('nowhere')).toBeNull()
    expect(spaceAiOfPage(undefined)).toBeNull()
  })

  test('只在归属或配置真变了才通知；内容没变沿用同一个对象', () => {
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES)
    const before = spaceAiOfPage('p-team')
    let calls = 0
    const off = subscribeSpaceAi(() => calls++)
    // 改标题：换了一份页面列表，归属没变
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES.map((p) => ({ ...p, title: p.title + '!' })))
    // 重拉了一份内容相同的空间列表
    syncSpaceAi([{ ...TEAM_ON }, { ...TEAM_OFF }, { ...MINE }], PAGES)
    expect(calls).toBe(0)
    expect(spaceAiOfPage('p-team')).toBe(before)
    // 改名
    syncSpaceAi([space('team', { enabled: true, name: '新名字' }), TEAM_OFF, MINE], PAGES)
    expect(calls).toBe(1)
    expect(spaceAiOfPage('p-team')?.name).toBe('新名字')
    // 页面搬到别的空间
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], [page('p-team', 'off'), page('p-off', 'off'), page('p-mine', 'mine')])
    expect(calls).toBe(2)
    expect(spaceAiOfPage('p-team')?.spaceId).toBe('off')
    off()
  })

  test('名字：trim、压空白、1–20 个字（同服务端）', () => {
    expect(normalizeSpaceAiName('  小  助手 ')).toBe('小 助手')
    expect(normalizeSpaceAiName('   ')).toBeNull()
    expect(normalizeSpaceAiName('一'.repeat(20))).toBe('一'.repeat(20))
    expect(normalizeSpaceAiName('一'.repeat(21))).toBeNull()
  })
})

describe('空间 AI 的身份：名字跟着页面所在的空间', () => {
  test('名字按这一页的空间现取，取不到写 AI；头像是机器人；能力同 Genet', () => {
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES)
    expect(spaceAiName('p-team')).toBe('小助手')
    expect(spaceAiName('p-mine')).toBe('AI')
    expect(spaceAiName()).toBe('AI')
    expect(builtinAgent(SPACE_AI_ID, 'p-team')?.label).toBe('小助手')
    expect(findAgent(SPACE_AI_ID, 'p-team')?.label).toBe('小助手')
    expect(agentName(SPACE_AI_ID, 'p-team')).toBe('小助手')
    expect(agentName(SPACE_AI_ID)).toBe('AI')
    expect(agentBadge(SPACE_AI_ID)).toEqual({ kind: 'mark', key: 'bot' })
    expect(capsOf(builtinAgent(SPACE_AI_ID))).toEqual({ workspace: false, toolProfile: false, team: false })
    // 同一个名字同一个对象（chip 的 useMemo / useSyncExternalStore 靠引用）
    expect(builtinAgent(SPACE_AI_ID, 'p-team')).toBe(builtinAgent(SPACE_AI_ID, 'p-team'))
  })

  test('改名后新旧回复的名字都是新的（名字不存在回复块里，现取）', () => {
    syncSpaceAi([space('team', { enabled: true, name: '改过了' }), TEAM_OFF, MINE], PAGES)
    expect(agentName(SPACE_AI_ID, 'p-team')).toBe('改过了')
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES)
  })
})

describe('这一页的目录：空间 AI 追加在末尾，只能点名 / 选中', () => {
  test('团队空间开着才有；没开、个人空间、不知道在哪的页都没有', () => {
    syncSpaceAi([TEAM_ON, TEAM_OFF, MINE], PAGES)
    expect(ids(catalogForPage(catalog, 'p-team', NONE))).toEqual(['c:m1:codex', 'claude', SPACE_AI_ID])
    expect(catalogForPage(catalog, 'p-team', NONE).at(-1)?.label).toBe('小助手')
    expect(ids(catalogForPage(catalog, 'p-off', NONE))).toEqual(['c:m1:codex', 'claude'])
    expect(ids(catalogForPage(catalog, 'p-mine', NONE))).toEqual(['c:m1:codex', 'claude'])
    expect(pageCatalog(catalog, false, null)).toBe(catalog)
  })

  test('Genet 页只有 Genet；锁定成别的工具时空间 AI 不在，锁定成它时只剩它', () => {
    expect(ids(catalogForPage(catalog, 'p-team', { choice: ASSISTANT_ID, lock: '' }))).toEqual([ASSISTANT_ID])
    expect(ids(catalogForPage(catalog, 'p-team', { choice: '', lock: 'claude' }))).toEqual(['claude'])
    expect(ids(catalogForPage(catalog, 'p-team', { choice: '', lock: SPACE_AI_ID }))).toEqual([SPACE_AI_ID])
    // 锁定成它而它被关了：空目录（chip 显示「这个空间还没有启用 AI」）
    expect(ids(catalogForPage(catalog, 'p-off', { choice: '', lock: SPACE_AI_ID }))).toEqual([])
  })

  test('不进回落：没 @、没选它就不会挑中它；选了、或这一页锁定成它才用', () => {
    const page = catalogForPage(catalog, 'p-team', NONE)
    expect(pickAgent(page, '', '', 'gemini')).toBe('c:m1:codex')
    // 机器上一个 agent 都没有：也不回落到空间 AI
    const onlyAi = catalogForPage([], 'p-team', NONE)
    expect(ids(onlyAi)).toEqual([SPACE_AI_ID])
    expect(pickAgent(onlyAi, '', '', 'claude')).toBe('')
    // 本页的来源 / 消息 chip 选了它
    expect(pickAgent(onlyAi, '', SPACE_AI_ID, 'claude')).toBe(SPACE_AI_ID)
    expect(pickAgent(page, SPACE_AI_ID, '', 'claude')).toBe(SPACE_AI_ID)
    // 第一块回复就是它（锁定）：这一页的对话就是跟它的
    const locked = catalogForPage(catalog, 'p-team', { choice: '', lock: SPACE_AI_ID })
    expect(pickAgent(locked, '', '', 'claude')).toBe(SPACE_AI_ID)
  })

  test('@ 候选（消息里）：全部目录 + 开着的空间 AI，不受锁定', () => {
    expect(ids(mentionAgents(catalog, 'p-team'))).toEqual(['c:m1:codex', 'claude', SPACE_AI_ID])
    expect(mentionAgents(catalog, 'p-off')).toBe(catalog)
    expect(mentionAgents(catalog, 'p-mine')).toBe(catalog)
  })
})

describe('没启用时开跑失败的说法', () => {
  const on = { spaceId: 'team', enabled: true, name: 'AI' }
  const off = { spaceId: 'team', enabled: false, name: 'AI' }

  test('团队空间没开、这次又是叫它：说清楚原因；别的情况交还原来的说法', () => {
    expect(spaceAiOffReason(off, 'unknown agent', true)).toBe('这个空间还没有启用 AI')
    expect(spaceAiOffReason(off, 'tool-locked', true)).toBe('这个空间还没有启用 AI')
    expect(spaceAiOffReason(on, 'unknown agent', true)).toBeNull()
    expect(spaceAiOffReason(off, 'unknown agent', false)).toBeNull()
    expect(spaceAiOffReason(null, 'unknown agent', true)).toBeNull()
    expect(spaceAiOffReason(off, 'busy', true)).toBeNull()
  })

  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      user_message: { group: 'block', content: 'paragraph+' },
      agent_reply: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, agent: { default: '' } } },
      agent_mention: { group: 'inline', inline: true, atom: true, attrs: { agentId: { default: '' }, label: { default: '' } } },
      text: { group: 'inline' },
    },
  })
  const para = (...inline: PMNode[]) => schema.node('paragraph', null, inline)
  const message = (...agents: string[]) =>
    schema.node('user_message', null, [para(schema.text('问'), ...agents.map((agentId) => schema.node('agent_mention', { agentId, label: agentId })))])
  const reply = (id: string, agent: string) => schema.node('agent_reply', { id, agent }, [para()])
  const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks)

  test('这次落在谁身上：@ 链的下一家；重跑的那块回复是谁写的', () => {
    expect(nextMention(doc(message(SPACE_AI_ID)))).toBe(SPACE_AI_ID)
    expect(nextMention(doc(message('claude', SPACE_AI_ID), reply('r1', 'claude')))).toBe(SPACE_AI_ID)
    expect(nextMention(doc(message('claude'), reply('r1', 'claude')))).toBe('')
    expect(nextMention(doc(message()))).toBe('')
    expect(replyAgentOf(doc(message(), reply('r1', SPACE_AI_ID), reply('r2', 'claude')), 'r1')).toBe(SPACE_AI_ID)
    expect(replyAgentOf(doc(message()), 'r1')).toBe('')
  })
})
