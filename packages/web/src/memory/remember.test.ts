import { afterEach, expect, test, vi } from 'vitest'
import { COPY } from '../copy'
import { bindPageSpace, parseRemember, remember, spaceOfPage } from './remember'

/* 不变量：只有「/记住」后面跟空白或结尾才是命令（/记住了、记住 都不是）；内容取其后的全部（含换行）并去首尾空白；
 * 没内容 / 没空间在本地就给原因、不发请求；服务端拒绝（403 / 413）的人话原样给；页面卸载后不再查得到空间。 */

afterEach(() => {
  vi.unstubAllGlobals()
})

test('parseRemember：识别 /记住 命令，取其后的内容', () => {
  expect(parseRemember('/记住 部署只用 deploy.sh')).toBe('部署只用 deploy.sh')
  expect(parseRemember('  /记住   两端\n第二行  ')).toBe('两端\n第二行')
  expect(parseRemember('/记住')).toBe('')
  expect(parseRemember('/记住   ')).toBe('')
  // 不是命令
  expect(parseRemember('/记住了')).toBeNull()
  expect(parseRemember('记住 这个')).toBeNull()
  expect(parseRemember('请 /记住 这个')).toBeNull()
  expect(parseRemember('/remember x')).toBeNull()
  expect(parseRemember('')).toBeNull()
})

test('remember：没内容 / 没空间在本地就给原因，不发请求', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(await remember('s1', '')).toEqual({ ok: false, message: COPY.memory.command.usage })
  expect(await remember(undefined, '内容')).toEqual({ ok: false, message: COPY.memory.command.noSpace })
  expect(await remember(null, '内容')).toEqual({ ok: false, message: COPY.memory.command.noSpace })
  expect(fetchMock).not.toHaveBeenCalled()
})

test('remember：POST 到该空间的记忆接口；服务端拒绝时把人话带出来', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ memory: { id: 'm1' } }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'space_full', message: '这个空间的记忆已满' }), { status: 413 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await remember('s/1', '约定')).toEqual({ ok: true })
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/spaces/s%2F1/memories')
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ text: '约定' }) })
  expect(await remember('s1', '再来一条')).toEqual({ ok: false, message: '这个空间的记忆已满' })
  expect(await remember('s1', '只读成员')).toEqual({ ok: false, message: 'forbidden' })
})

test('bindPageSpace：登记 / 注销；重复登记时旧的注销不会误删新的', () => {
  const off1 = bindPageSpace('p1', () => 'space-a')
  expect(spaceOfPage('p1')).toBe('space-a')
  expect(spaceOfPage('p2')).toBeUndefined()
  const off2 = bindPageSpace('p1', () => 'space-b')
  off1()
  expect(spaceOfPage('p1')).toBe('space-b')
  off2()
  expect(spaceOfPage('p1')).toBeUndefined()
})
