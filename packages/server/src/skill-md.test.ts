/* ---------- SKILL.md：frontmatter 解析 / 校验 / 输出 ----------
 * 不变量：
 *   1) 标准的 frontmatter 写法（标量、引号串、块标量、嵌套表、列表）读得对；认不出的写法明确报错，不猜
 *   2) name / description 规则（agentskills.io）一条条被执行
 *   3) emitSkillMd 的输出能被 parseSkillMd 原样读回（含冒号、引号、换行、嵌套值）
 *   4) 正文服务端序列化（fragmentToMarkdown）与解析（parseBlocks）对常见结构往返不丢 */

import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { materialize } from './agents/markdown.js'
import { fragmentToMarkdown } from './markdown-out.js'
import { emitSkillMd, parseSkillMd, SkillError, validateSkill } from './skill-md.js'

const doc = (frontmatter: string, body = '正文\n'): string => `---\n${frontmatter}\n---\n${body}`

test('标量 / 引号串 / 块标量 / 嵌套表 / 列表', () => {
  const { meta, body } = parseSkillMd(
    doc(
      [
        'name: pdf-tools',
        'description: "Extract: text and tables"',
        "license: 'MIT'",
        'compatibility: Needs python3',
        'metadata:',
        '  author: someone',
        '  version: "1.2"',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        'notes: |',
        '  第一行',
        '  第二行',
        'summary: >',
        '  folded',
        '  into one',
      ].join('\n'),
      '# 标题\n\n步骤\n',
    ),
  )
  expect(meta).toEqual({
    name: 'pdf-tools',
    description: 'Extract: text and tables',
    license: 'MIT',
    compatibility: 'Needs python3',
    metadata: { author: 'someone', version: '1.2' },
    'allowed-tools': ['Bash', 'Read'],
    notes: '第一行\n第二行',
    summary: 'folded into one',
  })
  expect(body).toBe('# 标题\n\n步骤\n')
})

test('没有 frontmatter / 写法认不出：明确报错', () => {
  expect(() => parseSkillMd('# 只有正文')).toThrow(SkillError)
  expect(() => parseSkillMd(doc('name: x\n  bad indent: y'))).toThrow(/无法解析/)
  expect(() => parseSkillMd(doc('just text'))).toThrow(/无法解析/)
})

test('name / description 规则', () => {
  const ok = validateSkill({ name: 'a-b-1', description: 'does things', license: 'MIT' })
  expect(ok).toEqual({ name: 'a-b-1', description: 'does things', extra: { license: 'MIT' } })
  for (const name of ['Upper', '-lead', 'trail-', 'dou--ble', 'has space', 'x'.repeat(65), '', 12]) {
    expect(() => validateSkill({ name, description: 'd' }), String(name)).toThrow(SkillError)
  }
  expect(() => validateSkill({ description: 'd' })).toThrow(/缺少 name/)
  expect(() => validateSkill({ name: 'a' })).toThrow(/缺少 description/)
  expect(() => validateSkill({ name: 'a', description: '   ' })).toThrow(/缺少 description/)
  expect(() => validateSkill({ name: 'a', description: 'd'.repeat(1025) })).toThrow(/1024/)
  expect(() => validateSkill({ name: 'a', description: 'd', compatibility: 'c'.repeat(501) })).toThrow(/compatibility/)
})

test('emit → parse 往返：冒号、引号、换行、嵌套值都不丢', () => {
  const skill = validateSkill({
    name: 'round-trip',
    description: 'He said "hi": ok\nsecond line',
    metadata: { author: 'me', n: '1' },
    'allowed-tools': ['Bash', 'Read'],
  })
  const text = emitSkillMd(skill, '# Body\n\n- a\n- b\n')
  const parsed = parseSkillMd(text)
  expect(validateSkill(parsed.meta)).toEqual(skill)
  expect(parsed.body.trim()).toBe('# Body\n\n- a\n- b')
})

test('正文 markdown ↔ 文档块：常见结构往返', () => {
  const md = [
    '# 标题',
    '',
    '一段 **加粗** 和 `npm test` 以及 [链接](https://example.com)。',
    '',
    '- 条目一',
    '- 条目二',
    '  - 嵌套',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '> 引用一行',
    '',
    '```bash',
    'echo hi',
    '',
    'echo there',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '---',
  ].join('\n')
  const ydoc = new Y.Doc()
  materialize(ydoc.getXmlFragment('prosemirror'), parseBlocks(md).blocks)
  const out = fragmentToMarkdown(ydoc.getXmlFragment('prosemirror'))
  // 再解析一次得到同样的内容（格式化细节如标记符号不要求一致，所以比较「再往返一次」的稳定性）
  const again = new Y.Doc()
  materialize(again.getXmlFragment('prosemirror'), parseBlocks(out).blocks)
  expect(fragmentToMarkdown(again.getXmlFragment('prosemirror'))).toBe(out)
  for (const needle of ['# 标题', '**加粗**', '`npm test`', '[链接](https://example.com)', '- 条目一', '1. 第一', '> 引用一行', '```bash\necho hi\n\necho there\n```', '| a | b |', '---']) {
    expect(out, needle).toContain(needle)
  }
})
