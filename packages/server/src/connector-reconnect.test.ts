// ---------- connector 重连：旧连接晚关不许注销新连接 ----------
// 同一台机器重连后，中心顶掉旧连接并当场断开它；旧连接的 close 只注销它自己，
// 否则设置里显示离线而 connector 还以为连着。
import { WebSocket } from 'ws'
import { expect, test } from 'vitest'
import { connectMachine, pairMachine } from './agents/scripted-machine.js'
import { agentsList, insertUser, login, postJson, waitFor } from './agents/test-kit.js'

test('同一台机器重连：被顶掉的旧连接当场断开，它晚到的关闭不会把新连接注销', async () => {
  const owner = await insertUser('owner')
  const cookie = await login('owner')
  const space = (await (await postJson('/api/spaces', cookie, { name: 's' })).json()) as { id: string }
  const first = await pairMachine(space.id, owner, 'box')
  const agent = `c:${first.id}:claude`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === agent))

  const second = await connectMachine({ id: first.id, name: 'box', token: first.token })
  await waitFor(() => first.ws.readyState === WebSocket.CLOSED) // 中心把旧的断了
  await new Promise((res) => setTimeout(res, 300)) // 旧连接的 close 回调已经跑过
  expect((await agentsList(cookie)).some((a) => a.id === agent)).toBe(true)

  second.ws.terminate()
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id === agent)) // 当前这条断了才算离线
})
