/* ---------- prompt 里的图片块：执行端按 agent 声明的 promptCapabilities.image 决定发不发 ----------
 * AcpAgent + 真子进程（fake-agent 的「报图片」回显收到的图片块），不起服务、不碰库 */
import { afterEach, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpAgent } from './acp.js'
import type { AgentEvent, PromptBlock } from './types.js'

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const spawned: AcpAgent[] = []
afterEach(() => {
  for (const agent of spawned.splice(0)) agent.kill()
})

async function ask(image: boolean): Promise<string> {
  const agent = new AcpAgent({ id: 'claude', label: 'Claude', command: process.execPath, args: [FAKE_AGENT], env: image ? { FAKE_IMAGE: '1' } : {} })
  spawned.push(agent)
  let text = ''
  agent.on((ev: AgentEvent) => {
    if (ev.type === 'text') text += ev.delta
  })
  const { sessionId } = await agent.newSession(process.cwd())
  const blocks: PromptBlock[] = [
    { type: 'text', text: '报图片' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    { type: 'image', mimeType: 'image/webp', data: 'UklGRg==' },
  ]
  await agent.prompt(sessionId, blocks)
  return text
}

test('agent 声明能收图：图片块原样发出', async () => {
  expect(await ask(true)).toContain('images:2:image/png,image/webp')
})

test('agent 没声明：图片块丢掉，只发文本', async () => {
  expect(await ask(false)).toContain('images:0:')
})
