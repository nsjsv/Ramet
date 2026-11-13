import { afterEach, expect, test, vi } from 'vitest'
import { COPY } from '../copy'
import { parseRemember, remember } from './remember'

/* 不变量：只有「/记住」后面跟空白或结尾才是命令（/记住了、记住 都不是）；内容取其后的全部（含换行）并去首尾空白；
 * 没内容在本地就给原因、不发请求；记到哪按服务端回的去处提示；服务端拒绝（403 / 413）的人话原样给。 */

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

test('remember：没内容在本地就给用法，不发请求', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(await remember('p1', '')).toEqual({ ok: false, message: COPY.memory.command.usage })
  expect(fetchMock).not.toHaveBeenCalled()
})

test('remember：POST 到这一页的记忆接口，按服务端回的去处提示；服务端拒绝时把人话带出来', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ memory: { id: 'm1' }, target: 'personal' }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ memory: { id: 'm2' }, target: { space: '研发组' } }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'space_full', message: '这个空间的记忆已满' }), { status: 413 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await remember('p/1', '偏好')).toEqual({ ok: true, message: COPY.memory.command.savedPersonal })
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/pages/p%2F1/memories')
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ text: '偏好' }) })
  expect(await remember('p1', '约定')).toEqual({ ok: true, message: COPY.memory.command.savedSpace('研发组') })
  expect(await remember('p1', '再来一条')).toEqual({ ok: false, message: '这个空间的记忆已满' })
  expect(await remember('p1', '只读成员')).toEqual({ ok: false, message: 'forbidden' })
})
