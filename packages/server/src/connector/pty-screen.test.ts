/* ---------- 终端的权威屏幕（pty-screen.ts）：快照能原样还原、与 seq 严格对齐 ----------
 * 验证方式：把快照写进一个全新的无界面终端，比对还原出来的样子（内容 / 光标 / 备用屏 / 模式 / 尺寸）。不依赖 node-pty。 */
import headless from '@xterm/headless'
import { afterEach, expect, test } from 'vitest'
import { SNAPSHOT_SCROLLBACK } from '../agents/pty-types.js'
import { PtyScreen } from './pty-screen.js'

const { Terminal } = headless
type Term = InstanceType<typeof Terminal>

const screens: PtyScreen[] = []
const terms: Term[] = []
afterEach(() => {
  for (const s of screens.splice(0)) s.dispose()
  for (const t of terms.splice(0)) t.dispose()
})

function screen(cols = 40, rows = 6): PtyScreen {
  const s = new PtyScreen(cols, rows)
  screens.push(s)
  return s
}

/** 按快照的尺寸起一个新终端、写入快照：网页端还原时就是这么做的 */
async function restore(snap: { data: string; cols: number; rows: number }): Promise<Term> {
  const t = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: SNAPSHOT_SCROLLBACK, allowProposedApi: true })
  terms.push(t)
  await new Promise<void>((r) => t.write(snap.data, r))
  return t
}

/** 某个缓冲区的全部行（去掉行尾空白） */
function lines(t: Term): string[] {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  while (out.length && out.at(-1) === '') out.pop()
  return out
}

test('写回快照得到同样的屏幕：内容、颜色、光标位置', async () => {
  const s = screen()
  s.feed(0, '$ \x1b[31mred\x1b[0m plain\r\n$ half-typed command')
  const snap = await s.snapshot()
  expect(snap).toMatchObject({ seq: 0, cols: 40, rows: 6 })
  expect(snap.data).toContain('\x1b[31m') // 颜色在
  const t = await restore(snap)
  expect(lines(t)).toEqual(['$ red plain', '$ half-typed command'])
  expect([t.buffer.active.cursorX, t.buffer.active.cursorY]).toEqual([20, 1]) // 光标停在写了一半的命令末尾（"$ half-typed command" 共 20 个字符）
})

test('快照与 seq 严格对齐：取快照之后才喂进来的输出不在快照里', async () => {
  const s = screen()
  s.feed(0, 'AAA')
  s.feed(1, 'BBB')
  const pending = s.snapshot()
  s.feed(2, 'CCC') // 取快照的调用之后才到
  const snap = await pending
  expect(snap.seq).toBe(1)
  const t = await restore(snap)
  expect(lines(t)).toEqual(['AAABBB'])
  // 接着按 seq 补上之后的输出，就和真实屏幕一致
  await new Promise<void>((r) => t.write('CCC', r))
  expect(lines(t)).toEqual(['AAABBBCCC'])
})

test('还没有任何输出：seq = -1、屏幕是空的', async () => {
  const snap = await screen().snapshot()
  expect(snap.seq).toBe(-1)
  expect(lines(await restore(snap))).toEqual([])
})

test('备用屏（vim / less / htop）：还原后仍在备用屏、画面一致；退出全屏程序后回到原来的屏幕', async () => {
  const s = screen()
  s.feed(0, 'shell prompt$ vim\r\n')
  s.feed(1, '\x1b[?1049h\x1b[H~ VIM-SCREEN')
  const t = await restore(await s.snapshot())
  expect(t.buffer.active.type).toBe('alternate')
  expect(lines(t)[0]).toBe('~ VIM-SCREEN')
  await new Promise<void>((r) => t.write('\x1b[?1049l', r)) // vim 退出
  expect(t.buffer.active.type).toBe('normal')
  expect(lines(t)[0]).toBe('shell prompt$ vim')
})

test('终端模式随快照还原：括号粘贴（zsh）、光标键应用模式（vim）', async () => {
  const s = screen()
  s.feed(0, '\x1b[?2004h\x1b[?1h')
  const t = await restore(await s.snapshot())
  expect(t.modes.bracketedPasteMode).toBe(true)
  expect(t.modes.applicationCursorKeysMode).toBe(true)
})

test('尺寸变化排在之前的输出之后生效；快照带当时的尺寸', async () => {
  const s = screen(20, 4)
  s.feed(0, 'x'.repeat(30)) // 20 列下折成两行
  s.resize(30, 5)
  const snap = await s.snapshot()
  expect(snap).toMatchObject({ cols: 30, rows: 5 })
  const t = await restore(snap)
  expect(lines(t).join('')).toBe('x'.repeat(30))
})

test(`滚动历史最多带 ${SNAPSHOT_SCROLLBACK} 行：更早的不在快照里`, async () => {
  const s = screen(20, 5)
  const total = SNAPSHOT_SCROLLBACK + 200
  for (let i = 0; i < total; i++) s.feed(i, `L${i}\r\n`)
  const t = await restore(await s.snapshot())
  const all = lines(t)
  expect(all).toContain(`L${total - 1}`)
  expect(all).toContain(`L${total - SNAPSHOT_SCROLLBACK}`)
  expect(all).not.toContain('L0')
})

test('终端关闭时，还在等的快照失败（attach 不会挂到超时）；关闭之后再取直接失败', async () => {
  const s = new PtyScreen(20, 4)
  s.feed(0, 'x')
  const pending = s.snapshot()
  s.dispose()
  await expect(pending).rejects.toThrow('已经关闭')
  await expect(s.snapshot()).rejects.toThrow('已经关闭')
})
