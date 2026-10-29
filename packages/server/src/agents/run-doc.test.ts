/** 过程页：步骤是正文里的块（run_step），详情在 record，一行字由 shared 的 stepLabel / stepVerb / entrySid 定。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { entrySid, stepLabel, stepVerb, type RunEntry } from '@ramet/shared/run-model'
import { textOf } from '../updates.js'
import { buildRunDoc, referencedRunIds, runSearchText, stepBlocks } from './run-doc.js'
import type { RunRecordV1 } from './run-record.js'

function record(patch: Partial<RunRecordV1> = {}): RunRecordV1 {
  return {
    v: 1,
    agent: 'omp',
    parentId: 'parent-1',
    replyId: 'reply-1',
    startedAt: Date.UTC(2026, 9, 4, 1, 5),
    ms: 21034,
    outcome: 'end',
    usage: { total: 1_500_000, input: 10, output: 20, cacheRead: 30, cacheWrite: 0 },
    context: { used: 40, size: 200 },
    entries: [
      { k: 'thought', text: '先看调用方\n再决定要不要改接口' },
      { k: 'say', t: 65_000, end: 66_000, text: '我先看看' },
      {
        k: 'tool',
        t: 12_000,
        end: 13_500,
        id: 'c1',
        kind: 'read',
        title: '读取 acp.ts',
        status: 'completed',
        detail: 'packages/server/src/agents/acp.ts',
      },
      { k: 'tool', t: 8_000, id: 'c2', kind: 'execute', title: '跑测试', status: 'failed', note: '2 failed', parentId: 'c1' },
    ],
    ...patch,
  }
}

function blocksOf(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  doc.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement) out.push(c)
  })
  return out
}

test('回复块的 run 属性是过程页引用；空的和其他块不算', () => {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  const reply = new Y.XmlElement('agent_reply')
  reply.setAttribute('run', 'run-1')
  const bare = new Y.XmlElement('agent_reply')
  reply.setAttribute('id', 'block')
  const para = new Y.XmlElement('paragraph')
  frag.insert(0, [reply, bare, para])
  expect([...referencedRunIds(doc)]).toEqual(['run-1'])
})

test('新过程页：标题 + 每步一个带块 id 的 run_step + 末尾空段落；没有第二份时间线', () => {
  const rec = record()
  const doc = buildRunDoc(rec)
  expect(textOf(doc.getXmlFragment('title'))).toMatch(/^过程 · /)
  const blocks = blocksOf(doc)
  expect(blocks.map((b) => b.nodeName)).toEqual(['run_step', 'run_step', 'run_step', 'run_step', 'paragraph'])
  expect(blocks.every((b) => typeof b.getAttribute('id') === 'string' && b.getAttribute('id'))).toBe(true)
  expect(new Set(blocks.map((b) => b.getAttribute('id'))).size).toBe(blocks.length)
  expect(textOf(blocks[4]!)).toBe('')
  // 没有独立的时间线
  expect(doc.getXmlFragment('run').length).toBe(0)
  expect(doc.getMap('runMeta').size).toBe(0)
})

test('步骤块的属性与文字：sid 对得上 record、时间 / 状态 / 父步骤带上、思考的换行落成 hardbreak', () => {
  const doc = buildRunDoc(record())
  const [thought, say, read, run] = blocksOf(doc) as [Y.XmlElement, Y.XmlElement, Y.XmlElement, Y.XmlElement]
  expect(thought.getAttributes()).toMatchObject({ sid: 'thought:0', k: 'thought' })
  expect(say.getAttributes()).toMatchObject({ sid: 'say:1', k: 'say', t: 65_000, end: 66_000 })
  expect(read.getAttributes()).toMatchObject({ sid: 'c1', k: 'tool', kind: 'read', status: 'completed', t: 12_000, end: 13_500 })
  expect(run.getAttributes()).toMatchObject({ sid: 'c2', kind: 'execute', status: 'failed', parent: 'c1' })
  // 没有的项不写（前端取默认值）：思考没有 kind / status / end，顶层工具没有 parent
  expect(thought.getAttribute('kind')).toBeUndefined()
  expect(thought.getAttribute('end')).toBeUndefined()
  expect(read.getAttribute('parent')).toBeUndefined()
  // 数字就是数字（不是字符串）
  expect(typeof say.getAttribute('t')).toBe('number')
  // 文字：思考 / 说明是原文（换行 = hardbreak，textOf 还原成 \n）；工具是标题（自带动词时去掉动词）
  expect(textOf(thought)).toBe('先看调用方\n再决定要不要改接口')
  expect(thought.toArray().some((c) => c instanceof Y.XmlElement && c.nodeName === 'hardbreak')).toBe(true)
  expect(textOf(say)).toBe('我先看看')
  expect(textOf(read)).toBe('acp.ts')
  expect(textOf(run)).toBe('跑测试')
})

test('stepLabel / stepVerb / entrySid：一行的字、动词、步骤标识只在 shared 定义', () => {
  const tool = (patch: Partial<Extract<RunEntry, { k: 'tool' }>>): RunEntry => ({
    k: 'tool', id: 'x', kind: 'other', title: '', status: 'completed', ...patch,
  })
  // 标题自带同一个动词 → 去掉；没标题 → 路径；子代理当前动作优先
  expect(stepLabel(tool({ kind: 'read', title: '读取 a.ts' }))).toBe('a.ts')
  expect(stepLabel(tool({ kind: 'read', title: '看一下 a.ts' }))).toBe('看一下 a.ts')
  expect(stepLabel(tool({ kind: 'edit', title: '', detail: 'src/b.ts' }))).toBe('src/b.ts')
  expect(stepLabel(tool({ kind: 'other', title: '调用 t', activity: '在搜索' }))).toBe('在搜索')
  expect(stepLabel({ k: 'thought', text: '想一想' })).toBe('想一想')
  expect(stepVerb('thought')).toBe('思考')
  expect(stepVerb('say')).toBe('说明')
  expect(stepVerb('tool', 'execute')).toBe('执行')
  expect(stepVerb('tool', '协议外的值')).toBe('调用') // 块 attrs 是任意字符串，兜底
  expect(stepVerb('tool')).toBe('调用')
  expect(entrySid(tool({ id: 'call-9' }), 5)).toBe('call-9')
  expect(entrySid({ k: 'say', text: 's' }, 3)).toBe('say:3')
})

test('stepBlocks 空列表 = 没有块；超长思考原样落（截断由 record 的上限负责，不在这里再裁）', () => {
  expect(stepBlocks([])).toEqual([])
  const long = 'x'.repeat(5000)
  const [block] = stepBlocks([{ k: 'thought', text: long }])
  expect(block!.inlines).toEqual([{ text: long, marks: [] }])
})

test('搜索索引 = 正文（步骤的字 + 笔记）+ 最终输出；没有输出就只有正文', () => {
  expect(runSearchText('读 a.ts\n跑测试', { output: '  全部通过  ' })).toBe('读 a.ts\n跑测试\n全部通过')
  expect(runSearchText('  读 a.ts ', {})).toBe('读 a.ts')
  expect(runSearchText('', null)).toBe('')
})
