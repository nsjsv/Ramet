import { afterEach, describe, expect, test, vi } from 'vitest'
import { openPreviewTab, previewLabel } from './preview-api'

afterEach(() => vi.unstubAllGlobals())

describe('previewLabel', () => {
  test('根路径只显示端口，其余带上路径', () => {
    expect(previewLabel({ port: 5173, path: '/' })).toBe('localhost:5173')
    expect(previewLabel({ port: 3000, path: '/app?x=1' })).toBe('localhost:3000/app?x=1')
  })
})

describe('openPreviewTab', () => {
  const ticket = (status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(status === 200 ? { url: 'http://127.0.0.1:3790/__ramet/enter?t=abc' } : { message: '没有权限' }), { status }))

  test('先同步开空白窗口并切断 opener（新窗口最终是不可信的预览页），票据回来再导航过去', async () => {
    const win = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const open = vi.fn(() => win)
    vi.stubGlobal('window', { open })
    const fetchMock = ticket()
    vi.stubGlobal('fetch', fetchMock)
    await openPreviewTab('page1', 'pv1')
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(win.opener).toBeNull()
    expect(win.location.href).toBe('http://127.0.0.1:3790/__ramet/enter?t=abc')
    expect(win.close).not.toHaveBeenCalled()
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/pages/page1/previews/pv1/ticket')
  })

  test('取票据失败：关掉那个空白窗口，错误原样抛出', async () => {
    const win = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('window', { open: vi.fn(() => win) })
    vi.stubGlobal('fetch', ticket(403))
    await expect(openPreviewTab('page1', 'pv1')).rejects.toThrow('没有权限')
    expect(win.close).toHaveBeenCalled()
    expect(win.location.href).toBe('')
  })

  test('窗口被拦截（open 返回 null）：拿到票据后再试一次，带 noopener', async () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open })
    vi.stubGlobal('fetch', ticket())
    await openPreviewTab('page1', 'pv1')
    expect(open).toHaveBeenLastCalledWith('http://127.0.0.1:3790/__ramet/enter?t=abc', '_blank', 'noopener')
  })
})
