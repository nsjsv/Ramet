import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { EditMarks } from './api'

const marks: EditMarks = {
  users: { bob: { username: 'bob', avatar: 'f1' } },
  page: { at: '2020-01-01T00:00:00.000Z', user_id: 'bob', actor: 'user', actor_agent: null },
  blocks: { b1: { at: '2020-01-01T00:00:00.000Z', user_id: 'bob', actor: 'user', actor_agent: null } },
}
vi.mock('./api', () => ({ api: { editMarks: vi.fn(async () => marks), listSpaceMembers: vi.fn(async () => []) } }))

const { editInfoOf, noteLocalEdits, refreshEditMarks } = await import('./edit-marks-store')
const { setSelf } = await import('./people')

describe('edit-marks-store', () => {
  beforeEach(() => setSelf({ id: 'me', username: '我', avatar: null }))

  test('没取过、也没本地编辑 → null', () => {
    expect(editInfoOf('p0')).toBeNull()
  })

  test('服务端记录解析出人名头像；没记录的块为 null', async () => {
    await refreshEditMarks('p1')
    expect(editInfoOf('p1', 'b1')).toMatchObject({ username: 'bob', avatar: 'f1', actor: 'user' })
    expect(editInfoOf('p1', 'nope')).toBeNull()
  })

  test('自己刚改的比服务端新 → 立刻显示自己；没改的块仍是服务端的', async () => {
    await refreshEditMarks('p2')
    noteLocalEdits('p2', ['b1'])
    expect(editInfoOf('p2', 'b1')).toMatchObject({ user_id: 'me', username: '我' })
    expect(editInfoOf('p2')).toMatchObject({ user_id: 'me' })
    noteLocalEdits('p3', ['x'])
    expect(editInfoOf('p3', 'x')).toMatchObject({ username: '我' })
    expect(editInfoOf('p3', 'y')).toBeNull()
  })

  test('本地标记在服务端落库后的拉取里让位（只比本机时钟）', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    noteLocalEdits('p4', ['b1'])
    await refreshEditMarks('p4') // 紧接着拉：服务端还没落库，仍显示自己
    expect(editInfoOf('p4', 'b1')).toMatchObject({ user_id: 'me' })
    vi.setSystemTime(1_000_000 + 6000)
    await refreshEditMarks('p4') // 停下 6s 后拉：服务端为准
    expect(editInfoOf('p4', 'b1')).toMatchObject({ user_id: 'bob' })
    vi.useRealTimers()
  })
})
