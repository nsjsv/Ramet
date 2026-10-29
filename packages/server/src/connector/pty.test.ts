/* ---------- 终端的执行端（connector/pty.ts）：归属、环境、回放、闲置回收、授权收回 ----------
 * 用真 node-pty 跑真 shell（/bin/sh）。node-pty 装不上的环境整组跳过（describe.skipIf），
 * 那种环境本身就是 connector 不声明 terminal 能力的场景，在 project-pty-api.test.ts 里单独测。
 * 重点是安全：
 *   - 别人的 ptyId：input / resize / attach / detach 一律 forbidden，连机器主人也不行（主人只能关、能看列表）；
 *   - 环境变量里没有 RAMET_*；起始目录要过路径约束（不存在 / 相对路径 / connector 配置目录 → 拒绝）；
 *   - 授权收回 / 收窄 / 到期：closeActor 与巡检（stillAllowed）把他的终端全关，订阅者收到 pty-exit(revoked)。
 * 还原：全新 attach / 缓冲接不上 → 屏幕快照（pty-screen.ts）；短暂断线 → 按 seq 补差量。 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ConnMsg } from '../agents/protocol.js'
import { PTY_IDLE_MS, PtyError, type PtyReply } from '../agents/pty-types.js'
import { loadNodePty, PtyManager, ptyEnv, type PtyDeps } from './pty.js'

const win = process.platform === 'win32'
const mod = await loadNodePty()
const live = describe.skipIf(!mod || win)

type Attach = Extract<PtyReply, { op: 'pty-attach' }>

let managers: PtyManager[] = []
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose()
})

function setup(deps: Partial<PtyDeps> = {}) {
  const frames: ConnMsg[] = []
  const mgr = new PtyManager(mod!, {
    send: (msg) => {
      frames.push(msg)
      return true
    },
    isOwner: (actor) => actor === 'owner',
    protect: [],
    shell: '/bin/sh',
    tickMs: 0,
    mergeMs: 5,
    ...deps,
  })
  managers.push(mgr)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ramet-pty-')))
  /** 某个终端已经推给中心的全部输出 */
  const text = (ptyId: string): string =>
    frames.flatMap((f) => (f.t === 'pty-data' && f.ptyId === ptyId ? [f.data] : [])).join('')
  const open = async (actor: string, root = dir): Promise<string> => {
    const r = await mgr.open(actor, { root, cols: 80, rows: 24 })
    if (r.op !== 'pty-open') throw new Error('不是 pty-open')
    return r.pty.ptyId
  }
  const attach = async (actor: string, ptyId: string, after = -1): Promise<Attach> => {
    const r = await mgr.attach(actor, ptyId, after)
    if (r.op !== 'pty-attach') throw new Error('不是 pty-attach')
    return r
  }
  return { mgr, frames, dir, text, open, attach }
}

async function until(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** 断言一个同步调用被 PtyError 拒绝，且 kind 对 */
function expectRefused(fn: () => unknown, kind: 'forbidden' | 'not_found' | 'failed'): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(PtyError)
    expect((err as PtyError).kind).toBe(kind)
    return
  }
  throw new Error('应该被拒绝')
}

/** 异步版（attach 是异步的：拒绝体现为 rejected promise） */
async function expectRejected(p: Promise<unknown>, kind: 'forbidden' | 'not_found' | 'failed'): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(PtyError)
  expect((err as PtyError).kind).toBe(kind)
}

describe('环境与起始目录（不依赖 node-pty）', () => {
  test('ptyEnv：去掉所有 RAMET_*（含小写），保留其余，设 TERM', () => {
    const env = ptyEnv({ PATH: '/bin', HOME: '/h', RAMET_SECRET_KEY: 's', ramet_public_url: 'u', RAMET_: 'x', TERM: 'dumb', NOT_RAMET_X: 'keep' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', NOT_RAMET_X: 'keep', TERM: 'xterm-256color' })
  })
})

live('打开 / 输入 / 输出 / 回放', () => {
  test('open → attach → input：命令的输出实时推给中心，起始目录是 root 的 realpath', async () => {
    const { mgr, frames, text, open, attach, dir } = setup()
    const link = join(dir, '..', `link-${process.pid}-${Date.now()}`)
    symlinkSync(dir, link)
    const id = await open('alice', link) // root 给的是符号链接：以 realpath 为准
    const first = await attach('alice', id)
    expect(first.pty).toMatchObject({ ptyId: id, actor: 'alice', root: dir, alive: true })
    mgr.input('alice', id, 'echo RES-$((6*7)); pwd\n')
    await until(() => text(id).includes('RES-42') && text(id).includes(dir))
    // 推给中心的每一块都有递增的 seq
    const seqs = frames.flatMap((f) => (f.t === 'pty-data' ? [f.seq] : []))
    expect(seqs.length).toBeGreaterThan(0)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  test('open / list 的描述里带 shell 名（可执行文件名）：网页终端 ⌘J 据此让模型给对语法的命令', async () => {
    const { mgr, dir } = setup()
    const opened = await mgr.open('alice', { root: dir, cols: 80, rows: 24 })
    if (opened.op !== 'pty-open') throw new Error('不是 pty-open')
    expect(opened.pty.shell).toBe('sh')
    const listed = mgr.list('alice')
    if (listed.op !== 'pty-list') throw new Error('不是 pty-list')
    expect(listed.ptys.map((p) => p.shell)).toEqual(['sh'])
  })

  test('没 attach 过 / detach 之后不往中心推；全新 attach 给屏幕快照，短暂断线（after 接得上）给 after 之后的回放', async () => {
    const { mgr, frames, open, attach } = setup()
    const pushed = (): number => frames.filter((f) => f.t === 'pty-data').length
    const id = await open('alice')
    mgr.input('alice', id, 'echo BEFORE-ATTACH\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(pushed()).toBe(0) // 从没订阅过：一块也没推
    const first = await attach('alice', id)
    expect(first.replay).toEqual([]) // 全新打开不重放字节流
    expect(first.snapshot?.data).toContain('BEFORE-ATTACH')
    expect(first.snapshot).toMatchObject({ cols: 80, rows: 24 })
    expect(first.last).toBe(first.snapshot!.seq)
    mgr.detach('alice', id)
    const before = pushed()
    mgr.input('alice', id, 'echo WHILE-DETACHED\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(pushed()).toBe(before) // detach 之后同样不推
    const again = await attach('alice', id)
    expect(again.snapshot?.data).toContain('WHILE-DETACHED')
    // after 接得上：只补 after 之后的，不给快照
    mgr.input('alice', id, 'echo AFTER-MARK\n')
    await until(async () => (await attach('alice', id, again.last)).replay.some((c) => c.data.includes('AFTER-MARK')))
    const tail = await attach('alice', id, again.last)
    expect(tail.snapshot).toBeUndefined()
    expect(tail.lost).toBe(false)
    expect(tail.replay.every((c) => c.seq > again.last)).toBe(true)
    expect(tail.replay.map((c) => c.data).join('')).not.toContain('BEFORE-ATTACH')
  })

  test('快照之后推给中心的每一块 seq 都大于 snapshot.seq（等快照期间的新输出也一样）', async () => {
    const { mgr, frames, open, attach, text } = setup()
    const id = await open('alice')
    mgr.input('alice', id, 'echo SEED\n')
    await new Promise((r) => setTimeout(r, 200))
    const pending = attach('alice', id) // 先不等：attach 里已经先订阅了
    mgr.input('alice', id, 'echo DURING-SNAPSHOT\n')
    const r = await pending
    await until(() => text(id).includes('DURING-SNAPSHOT') || (r.snapshot?.data.includes('DURING-SNAPSHOT') ?? false))
    const pushedSeqs = frames.flatMap((f) => (f.t === 'pty-data' && f.ptyId === id ? [f.seq] : []))
    // 推给中心的块可能有 seq ≤ snapshot.seq 的（中心按 seq 去重丢掉），但 snapshot.seq 之后的一块都不能少
    const after = pushedSeqs.filter((s) => s > r.snapshot!.seq)
    for (let i = 1; i < after.length; i++) expect(after[i]).toBe(after[i - 1]! + 1)
    if (after.length) expect(after[0]).toBe(r.snapshot!.seq + 1)
  })

  test('回放缓冲有上限：断得太久（after 接不上）不再给残缺的回放，而是给完整的屏幕快照——被挤掉的输出也在', async () => {
    const { mgr, open, attach, text } = setup({ replayBytes: 2000 })
    const id = await open('alice')
    const first = await attach('alice', id)
    for (let i = 0; i < 12; i++) mgr.input('alice', id, `echo LINE-${i}-${'x'.repeat(300)}\n`)
    mgr.input('alice', id, 'echo THE-END\n')
    await until(() => /THE-END\r?\n/.test(text(id)))
    const r = await attach('alice', id, first.last) // 从最早的位置续：缓冲早就接不上了
    expect(r.lost).toBe(false)
    expect(r.replay).toEqual([])
    expect(r.snapshot?.data).toContain('THE-END')
    expect(r.snapshot?.data).toContain('LINE-0-') // 回放缓冲里早没了，屏幕（含滚动历史）里还在
  })

  test('resize：shell 看到的尺寸跟着变', async () => {
    const { mgr, open, attach, text } = setup()
    const id = await open('alice')
    await attach('alice', id)
    mgr.resize('alice', id, 100, 30)
    mgr.input('alice', id, 'stty size\n')
    await until(() => /30 100\r?\n/.test(text(id)))
  })

  test('进程退出：推 pty-exit(exited) 带退出码；退出后 attach 仍能拿到回放与 alive=false；输入被拒', async () => {
    const { mgr, frames, open, attach } = setup()
    const id = await open('alice')
    await attach('alice', id)
    mgr.input('alice', id, 'echo BYE; exit 3\n')
    await until(() => frames.some((f) => f.t === 'pty-exit'))
    expect(frames.find((f) => f.t === 'pty-exit')).toMatchObject({ t: 'pty-exit', ptyId: id, code: 3, reason: 'exited' })
    const r = await attach('alice', id)
    expect(r.pty).toMatchObject({ alive: false, exitCode: 3 })
    expect(r.snapshot?.data).toContain('BYE') // 退出了照样能看到最后的屏幕
    expectRefused(() => mgr.input('alice', id, 'x'), 'failed')
  })
})

live('环境变量与路径', () => {
  test('shell 的环境里没有 RAMET_*，有 TERM=xterm-256color', async () => {
    process.env.RAMET_PTY_TEST_SECRET = 'must-not-leak'
    try {
      const { mgr, open, attach, text } = setup()
      const id = await open('alice')
      await attach('alice', id)
      mgr.input('alice', id, 'env | sort\n')
      await until(() => text(id).includes('TERM=xterm-256color'))
      await until(() => /\nPATH=/.test(text(id)) || text(id).includes('PATH='))
      expect(text(id)).not.toContain('RAMET_')
      expect(text(id)).not.toContain('must-not-leak')
    } finally {
      delete process.env.RAMET_PTY_TEST_SECRET
    }
  })

  test('起始目录要过路径约束：不存在 / 相对路径 / 含 NUL / connector 配置目录（含经链接绕进去）都拒绝', async () => {
    const config = realpathSync(mkdtempSync(join(tmpdir(), 'ramet-pty-cfg-')))
    mkdirSync(join(config, 'sub'))
    const { mgr, dir } = setup({ protect: [config] })
    const bad = [join(dir, 'nope'), 'relative/dir', '', `${dir}\0`, config, join(config, 'sub')]
    for (const root of bad) await expect(mgr.open('alice', { root }), JSON.stringify(root)).rejects.toThrow()
    const link = join(dir, 'to-config')
    symlinkSync(config, link)
    await expect(mgr.open('alice', { root: link })).rejects.toThrow('配置目录')
    expect(mgr.size).toBe(0)
  })
})

live('归属：别人的终端', () => {
  test('别人对我的 ptyId 输入 / 改尺寸 / 订阅 / 取消订阅一律 forbidden，一个字节也写不进去；机器主人也不例外', async () => {
    const { mgr, open, attach, text } = setup()
    const id = await open('alice')
    await attach('alice', id)
    for (const who of ['bob', 'owner']) {
      expectRefused(() => mgr.input(who, id, 'echo PWNED-BY-' + who + '\n'), 'forbidden')
      expectRefused(() => mgr.resize(who, id, 10, 10), 'forbidden')
      await expectRejected(mgr.attach(who, id, -1), 'forbidden')
      expectRefused(() => mgr.detach(who, id), 'forbidden')
    }
    mgr.input('alice', id, 'echo ALICE-OK\n')
    await until(() => text(id).includes('ALICE-OK'))
    expect(text(id)).not.toContain('PWNED')
    // 订阅没被别人动过：alice 还在收输出
    mgr.input('alice', id, 'echo STILL-SUBSCRIBED\n')
    await until(() => text(id).includes('STILL-SUBSCRIBED'))
  })

  test('关闭：本人或机器主人可以，别的被授权人不行；已经不在 = not_found', async () => {
    const { mgr, open } = setup()
    const a = await open('alice')
    expectRefused(() => mgr.close('bob', a), 'forbidden')
    expect(mgr.size).toBe(1)
    mgr.close('owner', a) // 机器主人能关别人的
    expect(mgr.size).toBe(0)
    const b = await open('alice')
    mgr.close('alice', b)
    expectRefused(() => mgr.close('alice', b), 'not_found')
    expectRefused(() => mgr.input('alice', 'no-such-pty', 'x'), 'not_found')
  })

  test('列表：普通人只看到自己的；机器主人看到这台机器上所有人的', async () => {
    const { mgr, open } = setup()
    const a = await open('alice')
    const b = await open('bob')
    const own = (actor: string) => {
      const r = mgr.list(actor)
      return r.op === 'pty-list' ? r.ptys.map((p) => [p.ptyId, p.actor]) : []
    }
    expect(own('alice')).toEqual([[a, 'alice']])
    expect(own('bob')).toEqual([[b, 'bob']])
    expect(own('carol')).toEqual([])
    expect(own('owner').sort()).toEqual([[a, 'alice'], [b, 'bob']].sort())
  })

  test('每人最多 5 个（别人的不占你的名额）；已退出的不算，开了又退五次还能开', async () => {
    const { mgr, open, attach, frames } = setup()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await open('alice'))
    await expect(open('alice')).rejects.toThrow('最多同时开 5 个')
    await open('bob') // 别人照开
    mgr.close('alice', ids[0]!)
    ids.push(await open('alice')) // 关了一个就能再开
    // 退出的不占活跃名额
    for (const id of ids.slice(1, 3)) {
      await attach('alice', id)
      mgr.input('alice', id, 'exit\n')
    }
    await until(() => frames.filter((f) => f.t === 'pty-exit').length >= 2)
    await open('alice')
    await open('alice')
  })
})

live('授权收回 / 收窄 / 到期、闲置回收', () => {
  test('closeActor：此人的终端全关，订阅着的收到 pty-exit(revoked)；别人的不动', async () => {
    const { mgr, frames, open, attach } = setup()
    const a1 = await open('alice')
    const a2 = await open('alice')
    const b = await open('bob')
    await attach('alice', a1)
    expect(mgr.closeActor('alice')).toBe(2)
    expect(mgr.size).toBe(1)
    expect(frames.filter((f) => f.t === 'pty-exit')).toEqual([{ t: 'pty-exit', ptyId: a1, code: null, reason: 'revoked' }])
    expectRefused(() => mgr.input('alice', a2, 'x'), 'not_found')
    mgr.input('bob', b, 'true\n')
  })

  test('巡检：本机名单里不再有 machine 使用权的人（到期 / 被收窄）的终端被关，其余不动', async () => {
    const allowed = new Set(['alice', 'bob'])
    const { mgr, open } = setup({ stillAllowed: (actor) => allowed.has(actor) })
    await open('alice')
    await open('bob')
    mgr.tick()
    expect(mgr.size).toBe(2)
    allowed.delete('alice')
    mgr.tick()
    expect(mgr.size).toBe(1)
    const r = mgr.list('bob')
    expect(r.op === 'pty-list' && r.ptys.length).toBe(1)
  })

  test('没有订阅者超过闲置期限就关；订阅着的不关；断开连接后开始计时；detach 后开始计时', async () => {
    const { mgr, frames, open, attach } = setup({ idleMs: 1000 })
    const never = await open('alice') // 从没订阅过
    const kept = await open('alice')
    await attach('alice', kept)
    const t0 = Date.now()
    mgr.tick(t0 + 500)
    expect(mgr.size).toBe(2)
    mgr.tick(t0 + 2000)
    expect(mgr.size).toBe(1) // never 被关了
    await expectRejected(mgr.attach('alice', never, -1), 'not_found')
    expect(frames.filter((f) => f.t === 'pty-exit')).toEqual([]) // never 没有订阅者，没人要通知
    mgr.tick(t0 + 60_000)
    expect(mgr.size).toBe(1) // kept 还有订阅者
    mgr.onDisconnect() // 中心断了：它也没有订阅者了
    mgr.tick(Date.now() + 500)
    expect(mgr.size).toBe(1)
    mgr.tick(Date.now() + 2000)
    expect(mgr.size).toBe(0)
    // detach
    const again = await open('alice')
    await attach('alice', again)
    mgr.detach('alice', again)
    mgr.tick(Date.now() + 2000)
    expect(mgr.size).toBe(0)
  })

  test('闲置期限缺省 7 天（命令写一半走开、过几天回来接着用）', () => {
    expect(PTY_IDLE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('dispose：全部关掉', async () => {
    const { mgr, open } = setup()
    await open('alice')
    await open('bob')
    mgr.dispose()
    expect(mgr.size).toBe(0)
  })
})
