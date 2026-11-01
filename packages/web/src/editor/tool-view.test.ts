import { expect, test } from 'vitest'
import { applyRunEvent, emptyRun, mergeStep, viewOf, type Step, type ToolEntry } from '@ramet/shared/run-model'
import { toolViewHtml } from './run-view'
import { toolDetailHtml } from './run-detail'

const step = (kind: Step['kind'], acp?: Record<string, unknown>, extra: Partial<ToolEntry> = {}): ToolEntry => ({
  k: 'tool', id: 't1', kind, title: kind, status: 'completed', ...(acp ? { acp } : {}), ...extra,
})

test('viewOf 从老记录的 acp 推：命令 / 说明 / 终端句柄 / 退出状态 / 原样载荷', () => {
  const v = viewOf(step('execute', {
    name: 'Bash',
    rawInput: { command: ['ls', '-la'], description: ' 列目录 ', cwd: '/w' },
    content: [{ type: 'terminal', terminalId: 'T-1' }],
    terminalExit: { terminalId: 'T-1', exitCode: 2, signal: null },
    _meta: { m: 1 },
  }))
  expect(v).toMatchObject({ tool: 'Bash', command: 'ls -la', description: '列目录', cwd: '/w', handle: 'T-1', exit: { code: 2, signal: null } })
  expect(v.raw).toEqual({
    input: { command: ['ls', '-la'], description: ' 列目录 ', cwd: '/w' },
    extra: { content: [{ type: 'terminal', terminalId: 'T-1' }], terminalExit: { terminalId: 'T-1', exitCode: 2, signal: null }, _meta: { m: 1 } },
  })
  // 非终端命令：退出码看 rawOutput 里常见的字段
  expect(viewOf(step('execute', { rawOutput: { exitCode: 1, stdout: 'x' } })).exit).toEqual({ code: 1, signal: null })
  expect(viewOf(step('execute', { terminalExit: { exitCode: null, signal: 'SIGTERM' } })).exit).toEqual({ code: null, signal: 'SIGTERM' })
})

test('viewOf 的结果文字：content 文字块 → rawOutput 字符串 → rawOutput 常见字段；都没有就不填', () => {
  const text = (t: string) => ({ type: 'content', content: { type: 'text', text: t } })
  expect(viewOf(step('read', { content: [text('a'), text('b')], rawOutput: 'raw' })).result).toBe('a\nb')
  expect(viewOf(step('read', { rawOutput: 'raw' })).result).toBe('raw')
  expect(viewOf(step('read', { rawOutput: { stdout: 'o', stderr: 'e', other: 'x' } })).result).toBe('o\ne')
  expect(viewOf(step('read', { content: [text('')] })).result).toBe('')
  expect(viewOf(step('read', { rawOutput: { n: 1 } })).result).toBeUndefined()
})

test('viewOf 的路径与 diff：locations → rawInput 路径字段；编辑类没有 diff 时退到 old_string / 整份写入', () => {
  expect(viewOf(step('read', { locations: [{ path: '/a' }], rawInput: { file_path: '/b' } })).path).toBe('/a')
  expect(viewOf(step('read', { rawInput: { notebook_path: '/n.ipynb' } })).path).toBe('/n.ipynb')
  expect(viewOf(step('edit', { content: [{ type: 'diff', oldText: null, newText: 'x' }], locations: [{ path: '/c' }] })).diffs).toEqual([{ path: '/c', old: '', new: 'x' }])
  expect(viewOf(step('edit', { rawInput: { file_path: '/e', old_string: 'a', new_string: 'b' } })).diffs).toEqual([{ path: '/e', old: 'a', new: 'b' }])
  expect(viewOf(step('edit', { rawInput: { path: '/w', content: 'all' } })).diffs).toEqual([{ path: '/w', old: '', new: 'all' }])
  // 不是编辑类：rawInput.content 不是 diff
  expect(viewOf(step('other', { rawInput: { content: 'all' } })).diffs).toBeUndefined()
})

test('viewOf 的搜索：查询词 + 搜索范围（rawInput.path 是在哪搜，不是读写的文件）', () => {
  const v = viewOf(step('search', { rawInput: { pattern: 'TODO', path: '/src' } }))
  expect(v.query).toBe('TODO')
  expect(v.cwd).toBe('/src')
  expect(viewOf(step('fetch', { rawInput: { url: 'https://a' } })).query).toBe('https://a')
})

test('viewOf：view 为准、缺的从 acp 补；同一份数据返回同一个对象（详情指纹靠它）', () => {
  const acp = { rawInput: { command: 'old' }, rawOutput: 'out' }
  const s = step('execute', acp, { view: { command: 'new', handle: 'H' } })
  const v = viewOf(s)
  expect(v).toMatchObject({ command: 'new', handle: 'H', result: 'out', raw: { input: { command: 'old' }, output: 'out' } })
  expect(viewOf(s)).toBe(v)
  expect(viewOf({ ...s, acp: { ...acp } })).not.toBe(v)
  const legacy = step('read', { rawOutput: 'r' })
  expect(viewOf(legacy)).toBe(viewOf(legacy))
  expect(viewOf(step('read'))).toEqual({})
  const own = { result: 'x' }
  expect(viewOf(step('read', undefined, { view: own }))).toBe(own)
})

test('step 事件里的 view 按字段合并：后到覆盖先到、缺省保持、raw 整体替换（两端同一个 reducer）', () => {
  const a = mergeStep(undefined, { id: 's', view: { command: 'npm test', raw: { input: { a: 1 }, output: 'x' } } })
  const b = mergeStep(a, { id: 's', status: 'completed', view: { result: 'ok', raw: { output: 'y' } } })
  expect(b.view).toEqual({ command: 'npm test', result: 'ok', raw: { output: 'y' } })
  const c = mergeStep(b, { id: 's', status: 'failed' })
  expect(c.view).toBe(b.view)
  const run = emptyRun()
  applyRunEvent(run, { type: 'step', step: { id: 's', kind: 'execute', title: 'x', status: 'in_progress', view: { command: 'c' } }, t: 0 })
  applyRunEvent(run, { type: 'step', step: { id: 's', view: { exit: { code: 0, signal: null } } }, t: 1 })
  expect(run.entries[0]).toMatchObject({ view: { command: 'c', exit: { code: 0, signal: null } } })
})

test('只有 view 的步骤（不经 ACP 的驱动）照样画：命令 + 输出 + 退出码；高级里是原样输入输出', () => {
  const e = step('execute', undefined, { view: { tool: 'Bash', command: 'make', result: 'built', exit: { code: 2, signal: null }, raw: { input: { cmd: 'make' }, output: 'built' } } })
  const html = toolViewHtml(e)
  expect(html).toContain('make</pre>')
  expect(html).toContain('built')
  expect(html).toContain('2')
  const adv = toolDetailHtml(e)
  expect(adv).toContain('Bash')
  expect(adv).toContain('输入')
  expect(adv).toContain('输出')
})
