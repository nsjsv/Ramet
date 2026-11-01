import { expect, test } from 'vitest'
import { toolFace } from './tools.js'

test('子代理那一步的标题：说明 → 正文里第一行不是标题的文字 → 任务名 → 标题本身', () => {
  expect(toolFace('task', { tasks: [{ description: '跑一下测试', assignment: '# Target\n细节' }] }).title).toBe('跑一下测试')
  expect(toolFace('task', { tasks: [{ id: 'EchoRunner', assignment: '# Target\nrun echo' }] }).title).toBe('run echo')
  expect(toolFace('task', { tasks: [{ id: 'EchoRunner', assignment: '# Target' }] }).title).toBe('EchoRunner')
  expect(toolFace('task', { tasks: [{ assignment: '# Target\n\nRun `echo hi` and report' }] }).title).toBe('Run `echo hi` and report')
  expect(toolFace('task', { context: '## 只有标题' }).title).toBe('只有标题')
  expect(toolFace('task', {}).title).toBe('子代理')
})
