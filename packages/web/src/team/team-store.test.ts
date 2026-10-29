import { describe, expect, test } from 'vitest'
import type { TeamPlanView } from '@ramet/shared/run-model'
import { createPlanStore } from './team-store'

const view = (planId: string, title = '计划', status: TeamPlanView['status'] = 'draft'): TeamPlanView => ({
  planId,
  title,
  leader: 'claude',
  status,
  tasks: [],
  pageId: 'pg',
  initiatorId: 'u1',
  initiator: 'alice',
  createdAt: '2026-10-18T00:00:00Z',
})

/** 手动放行的 fetcher：测"请求期间有更新到达"的竞态 */
function gate() {
  let release!: (v: TeamPlanView) => void
  let fail!: (e: unknown) => void
  const promise = new Promise<TeamPlanView>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}

describe('计划视图 store', () => {
  test('没问过 = 同一个空条目（useSyncExternalStore 要求没变就同一个引用）', () => {
    const store = createPlanStore(async () => view('p'))
    expect(store.get('p')).toBe(store.get('p'))
    expect(store.get('p')).toMatchObject({ state: 'idle', view: null })
  })

  test('ensure 拉一次并通知订阅者；在拉的时候、拉到之后再 ensure / refresh 都不重复请求', async () => {
    let calls = 0
    const store = createPlanStore(async () => {
      calls++
      return view('p', '第一版')
    })
    let notified = 0
    store.subscribe(() => notified++)
    store.ensure('pg', 'p')
    store.ensure('pg', 'p') // 还在拉：不重复
    await store.refresh('pg', 'p') // 同一份在飞：并进去，不另起一次
    await Promise.resolve()
    store.ensure('pg', 'p') // 拉到了：不重复
    expect(store.get('p')).toMatchObject({ state: 'ready' })
    expect(store.get('p').view?.title).toBe('第一版')
    expect(calls).toBe(1)
    expect(notified).toBeGreaterThan(0)
  })

  test('SSE 先到：GET 期间收到的更新比这份 GET 新，GET 的结果被丢掉', async () => {
    const g = gate()
    const store = createPlanStore(() => g.promise)
    store.ensure('pg', 'p')
    store.put(view('p', '改过的标题'))
    g.release(view('p', '旧的标题'))
    await g.promise
    await Promise.resolve()
    expect(store.get('p').view?.title).toBe('改过的标题')
  })

  test('put 整份替换；同一份计划的状态从草稿变成已开工，订阅者看得到', () => {
    const store = createPlanStore(async () => view('p'))
    store.put(view('p'))
    expect(store.get('p').view?.status).toBe('draft')
    store.put(view('p', '计划', 'running'))
    expect(store.get('p').view?.status).toBe('running')
    expect(store.get('p').version).toBe(2)
  })

  test('404 = missing（计划不存在或看不到）；别的错 = failed；两种都保留已有视图、都能再试', async () => {
    let status = 404
    const store = createPlanStore(async () => {
      throw Object.assign(new Error('x'), { status })
    })
    await store.refresh('pg', 'p')
    expect(store.get('p').state).toBe('missing')
    status = 500
    await store.refresh('pg', 'p')
    expect(store.get('p').state).toBe('failed')
    store.put(view('p'))
    await store.refresh('pg', 'p')
    expect(store.get('p').view).not.toBeNull()
  })

  test('不认识的东西不进 store', () => {
    const store = createPlanStore(async () => view('p'))
    store.put(undefined as unknown as TeamPlanView)
    store.put({} as TeamPlanView)
    expect(store.get('p').state).toBe('idle')
  })

  test('不同计划互不影响', () => {
    const store = createPlanStore(async () => view('p'))
    store.put(view('a', 'A'))
    store.put(view('b', 'B'))
    expect(store.get('a').view?.title).toBe('A')
    expect(store.get('b').view?.title).toBe('B')
  })

  test('离开页面（事件流断开）→ 视图标成没拉过，ensure 会重拉；旧视图先留着不闪', async () => {
    let calls = 0
    const store = createPlanStore(async () => {
      calls++
      return view('p', '服务端最新')
    })
    store.put(view('p', '缓存里的旧标题'))
    store.ensure('pg', 'p') // ready：不重拉
    expect(calls).toBe(0)
    store.invalidate('pg')
    expect(store.get('p').state).toBe('idle')
    expect(store.get('p').view?.title).toBe('缓存里的旧标题')
    store.ensure('pg', 'p')
    expect(store.get('p').view?.title).toBe('缓存里的旧标题') // 重拉期间仍显示旧视图
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(store.get('p').view?.title).toBe('服务端最新')
  })

  test('invalidate 只动这一页的计划', () => {
    const store = createPlanStore(async () => view('x'))
    store.put({ ...view('a'), pageId: 'pg1' })
    store.put({ ...view('b'), pageId: 'pg2' })
    store.invalidate('pg1')
    expect(store.get('a').state).toBe('idle')
    expect(store.get('b').state).toBe('ready')
  })

  test('事件流重连：这一页上没收尾的（草稿 / 进行中）重拉，已收尾的和别页的不拉', async () => {
    const asked: string[] = []
    const store = createPlanStore(async (_pageId, planId) => {
      asked.push(planId)
      return view(planId)
    })
    store.put({ ...view('draft'), pageId: 'pg' })
    store.put({ ...view('running', '计划', 'running'), pageId: 'pg' })
    store.put({ ...view('done', '计划', 'done'), pageId: 'pg' })
    store.put({ ...view('other'), pageId: 'pg2' })
    store.refreshPage('pg')
    await Promise.resolve()
    await Promise.resolve()
    expect(asked.sort()).toEqual(['draft', 'running'])
  })
})
