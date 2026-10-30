/* ---------- 目录树广播：结构写成功发 'boards'，页面写不发 ----------
 * 前端目录树只跟 'boards' 重拉（页面写的 'changed' 很频繁，不连带重拉），所以每个目录树写路由、
 * 以及「挂着的页被恢复」都必须发；被拒的写不发。 */
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { base, joinPageSpace, pageOwnership, s, setupPage, waitFor } from './agents/test-kit.js'

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function connectControl(cookie: string, onStateless: (payload: string) => void): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: 'control:global',
    token: 'test',
    quiet: true,
    onStateless: ({ payload }) => onStateless(payload),
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('control provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return provider
}

test('目录树写成功都广播 boards；页面改名只发 changed；被拒的写不发；恢复挂着的页发 boards', async () => {
  const { cookie: alice, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const carol = await joinPageSpace(pageId, 'carol', { role: 'viewer' })
  const got: string[] = []
  const control = await connectControl(alice, (p) => got.push(p))
  const boardsCount = (): number => got.filter((p) => p === 'boards').length
  const expectBoards = async (n: number): Promise<void> => {
    await waitFor(() => boardsCount() >= n)
    expect(boardsCount()).toBe(n)
  }

  const tree = (await (await call('POST', `/api/spaces/${spaceId}/dir-tree`, alice)).json()) as { board: { id: string } }
  await expectBoards(1)
  // 已存在再补建是 no-op，不广播
  expect((await call('POST', `/api/spaces/${spaceId}/dir-tree`, alice)).status).toBe(200)

  const folder = (await (await call('POST', `/api/boards/${tree.board.id}/folders`, alice, { name: '资料' })).json()) as { id: string }
  await expectBoards(2)
  expect((await call('PATCH', `/api/folders/${folder.id}`, alice, { name: '资料库' })).status).toBe(200)
  await expectBoards(3)
  const doc = (await (await call('POST', '/api/pages', alice, { space_id: spaceId, in_page_tree: false })).json()) as { id: string }
  const item = (await (await call('PUT', `/api/folders/${folder.id}/items`, alice, { kind: 'page', item_id: doc.id })).json()) as { id: string }
  await expectBoards(4)
  expect((await call('PATCH', `/api/folder-items/${item.id}`, alice, { folder_id: null, index: 0 })).status).toBe(200)
  await expectBoards(5)

  // 页面写走 'changed'，不连带目录树
  const changedBefore = got.filter((p) => p === 'changed').length
  expect((await call('PATCH', `/api/pages/${doc.id}`, alice, { title: '新标题' })).status).toBe(200)
  await waitFor(() => got.filter((p) => p === 'changed').length > changedBefore)
  // viewer 被拒（403）不广播
  expect((await call('PATCH', `/api/folders/${folder.id}`, carol, { name: 'x' })).status).toBe(403)
  await new Promise((r) => setTimeout(r, 300))
  expect(boardsCount()).toBe(5)

  // 挂着的页进回收站再恢复：目录树列表不含回收站里的页，恢复后得让各端重拉
  expect((await call('POST', `/api/pages/${doc.id}/trash`, alice)).status).toBe(200)
  expect((await call('POST', `/api/pages/${doc.id}/restore`, alice)).status).toBe(200)
  await expectBoards(6)

  expect((await call('DELETE', `/api/folder-items/${item.id}`, alice)).status).toBe(200)
  await expectBoards(7)
  expect((await call('DELETE', `/api/folders/${folder.id}`, alice)).status).toBe(200)
  await expectBoards(8)
  expect((await call('DELETE', `/api/boards/${tree.board.id}`, alice)).status).toBe(200)
  await expectBoards(9)
  control.destroy()
})
