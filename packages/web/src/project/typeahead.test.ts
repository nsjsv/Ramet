import { describe, expect, test } from 'vitest'
import { MISMATCH_GRACE_MS, TypeAhead, type Screen } from './typeahead'

type Cell = { ch: string; faint: boolean }

/** 假屏幕：一个可写的字符网格 + 光标；echo / erase 模拟服务器回显 */
class FakeScreen implements Screen {
  alternate = false
  cursor = { x: 0, y: 0 }
  private rows: Cell[][] = []
  constructor(public cols = 40) {}
  cell(y: number, x: number): Cell {
    return this.rows[y]?.[x] ?? { ch: '', faint: false }
  }
  put(y: number, x: number, text: string, faint = false): void {
    const row = (this.rows[y] ??= [])
    ;[...text].forEach((ch, i) => (row[x + i] = { ch, faint }))
  }
  echo(text: string): void {
    this.put(this.cursor.y, this.cursor.x, text)
    this.cursor = { ...this.cursor, x: this.cursor.x + text.length }
  }
  erase(): void {
    this.cursor = { ...this.cursor, x: this.cursor.x - 1 }
    ;(this.rows[this.cursor.y] ??= [])[this.cursor.x] = { ch: '', faint: false }
  }
  /** 清掉光标右边（zsh 收起自动建议） */
  clearRight(): void {
    const row = this.rows[this.cursor.y] ?? []
    row.length = Math.min(row.length, this.cursor.x)
  }
}

function setup(cols = 40) {
  const s = new FakeScreen(cols)
  s.put(0, 0, '$ ')
  s.cursor = { x: 2, y: 0 }
  let now = 1000
  const ta = new TypeAhead(s, () => now)
  const server = (fn: () => void): void => {
    ta.beforeWrite()
    fn()
    ta.afterWrite()
  }
  const wait = (ms: number): void => {
    now += ms
  }
  /** 打两个字、各自 100ms 后回显：本行确认过回显，延迟样本够了 */
  const warm = (): void => {
    for (const ch of 'ec') {
      ta.onInput(ch)
      wait(100)
      server(() => s.echo(ch))
    }
  }
  return { s, ta, server, wait, warm }
}

const shown = (ta: TypeAhead): string =>
  (ta.overlay()?.cells ?? []).map((c) => c.ch).join('')

describe('显示与确认', () => {
  test('每行第一个字不显示；回显确认、样本够了之后，后面的字按下即显示', () => {
    const { s, ta, server, wait } = setup()
    ta.onInput('e')
    expect(ta.overlay()).toBeNull() // 首字只入账
    wait(100)
    server(() => s.echo('e'))
    ta.onInput('c')
    expect(ta.overlay()).toBeNull() // 本行已确认，但延迟样本只有 1 个
    wait(100)
    server(() => s.echo('c'))
    ta.onInput('ho')
    expect(ta.overlay()).toEqual({ y: 0, cells: [{ x: 4, ch: 'h' }, { x: 5, ch: 'o' }], cursor: 6 })
  })

  test('回显逐个到达：确认一个、浮层少一个；全部确认后不画', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('ls')
    wait(80)
    server(() => s.echo('l'))
    expect(ta.overlay()).toEqual({ y: 0, cells: [{ x: 5, ch: 's' }], cursor: 6 })
    server(() => s.echo('s'))
    expect(ta.overlay()).toBeNull()
    expect(ta.deadline()).toBeNull()
  })

  test('zsh 式回显：语法高亮重画整行 + 光标后补自动建议灰字，照样确认；灰字上的预测要盖住', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('l')
    wait(80)
    server(() => {
      s.put(0, 2, 'ecl') // 重画整行（颜色不同，字符相同）
      s.put(0, 5, 's -la', true) // 自动建议
      s.cursor = { x: 5, y: 0 }
    })
    expect(ta.overlay()).toBeNull()
    ta.onInput('s')
    expect(ta.overlay()?.cells).toEqual([{ x: 5, ch: 's' }]) // 同字但是灰的：也要盖
  })

  test('延迟低于 30ms 不显示', () => {
    const { s, ta, server, wait } = setup()
    for (const ch of 'abcd') {
      ta.onInput(ch)
      wait(5)
      server(() => s.echo(ch))
    }
    ta.onInput('x')
    expect(ta.overlay()).toBeNull()
  })
})

describe('退格', () => {
  test('删预测出来的字：浮层直接少一格', () => {
    const { ta, warm } = setup()
    warm()
    ta.onInput('xy\x7f')
    expect(shown(ta)).toBe('x')
  })

  test('删已确认的字：那格盖成空白、假光标左移；回显到达后不再画', () => {
    const { s, ta, server, warm } = setup()
    warm()
    ta.onInput('\x7f')
    expect(ta.overlay()).toEqual({ y: 0, cells: [{ x: 3, ch: ' ' }], cursor: 3 })
    server(() => s.erase())
    expect(ta.overlay()).toBeNull()
  })

  test('删过头（按住退格删整行）：撞到起点的退格忽略，前面的预测照常显示', () => {
    const { ta, warm } = setup()
    warm()
    ta.onInput('\x7f\x7f\x7f\x7f')
    expect(ta.overlay()).toEqual({ y: 0, cells: [{ x: 2, ch: ' ' }, { x: 3, ch: ' ' }], cursor: 2 })
  })

  test('↑ 翻出历史命令再删：起点是提示符末尾；第一下退格被确认后，后面的退格即时显示', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('\r')
    wait(100)
    server(() => {
      s.cursor = { x: 2, y: 1 }
      s.put(1, 0, '$ ')
    })
    wait(200)
    ta.onInput('\x1b[A') // 这一行的第一个键：记下起点 x=2
    wait(100)
    server(() => {
      s.put(1, 2, 'git status')
      s.cursor = { x: 12, y: 1 }
    })
    wait(200)
    ta.onInput('\x7f')
    expect(ta.overlay()).toBeNull() // 新行还没确认过回显
    wait(100)
    server(() => s.erase())
    ta.onInput('\x7f\x7f')
    expect(ta.overlay()).toEqual({ y: 1, cells: [{ x: 9, ch: ' ' }, { x: 10, ch: ' ' }], cursor: 9 })
  })
})

describe('密码与换行', () => {
  test('不回显的输入（密码）永远不画，超时后清掉', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('\r')
    wait(100)
    server(() => {
      s.cursor = { x: 0, y: 1 }
      s.echo('Password: ')
    })
    wait(200) // 回车的屏障解除
    ta.onInput('secret')
    expect(ta.overlay()).toBeNull() // 入账了但新行没确认过回显
    expect(ta.deadline()).not.toBeNull()
    wait(5000)
    ta.expire()
    expect(ta.deadline()).toBeNull()
    ta.onInput('x')
    expect(ta.overlay()).toBeNull()
  })

  test('服务器光标换到别的行：预测作废，新行要重新确认', () => {
    const { s, ta, server, warm } = setup()
    warm()
    ta.onInput('ab')
    expect(shown(ta)).toBe('ab')
    server(() => {
      s.cursor = { x: 2, y: 1 }
      s.put(1, 0, '$ ')
    })
    expect(ta.overlay()).toBeNull()
    ta.onInput('z')
    expect(ta.overlay()).toBeNull()
  })
})

describe('对不上 / 超时', () => {
  test('回显被拆成两批（中间状态对不上）：宽限内不判错', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('ab')
    server(() => s.echo('a'))
    server(() => s.erase()) // zsh 先退一格再重画
    expect(shown(ta)).not.toBe('')
    wait(50)
    server(() => s.echo('ab'))
    expect(ta.overlay()).toBeNull()
    expect(ta.deadline()).toBeNull()
  })

  test('真的对不上（vi 模式等）：过了宽限就撤掉', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    ta.onInput('ab')
    server(() => {
      s.cursor = { x: 1, y: 0 } // 光标跑到别处
    })
    expect(shown(ta)).not.toBe('')
    wait(MISMATCH_GRACE_MS)
    ta.expire()
    expect(ta.overlay()).toBeNull()
  })

  test('一直没有回显：超时后撤掉', () => {
    const { ta, wait, warm } = setup()
    warm()
    ta.onInput('ab')
    expect(shown(ta)).toBe('ab')
    wait(999)
    ta.expire()
    expect(shown(ta)).toBe('ab')
    wait(2)
    ta.expire()
    expect(ta.overlay()).toBeNull()
  })
})

describe('屏障：不可预测的输入', () => {
  test('Tab / 方向键 / 非 ASCII：已有的预测照常显示，之后敲的字不预测；对不上算在屏障头上（不要求重新确认），停顿一个往返后恢复', () => {
    for (const key of ['\t', '\x1b[D', '中', '\x03']) {
      const { s, ta, server, wait, warm } = setup()
      warm()
      ta.onInput('a')
      expect(shown(ta)).toBe('a')
      ta.onInput(key)
      expect(shown(ta), JSON.stringify(key)).toBe('a')
      ta.onInput('b')
      expect(shown(ta), JSON.stringify(key)).toBe('a')
      wait(100)
      server(() => s.echo('ab')) // 服务器把屏障之后的 b 也处理了：对不上 S1，静默撤掉
      expect(ta.overlay(), JSON.stringify(key)).toBeNull()
      wait(150)
      ta.onInput('c')
      expect(shown(ta), JSON.stringify(key)).toBe('c')
    }
  })

  test('⌘J 写进终端的命令同样是屏障', () => {
    const { ta, warm } = setup()
    warm()
    ta.onInput('a')
    ta.onExternalInput()
    ta.onInput('b')
    expect(shown(ta)).toBe('a')
  })

  test('还有没解析完的输出时开始打字：拍不了基线，不预测', () => {
    const { ta, warm } = setup()
    warm()
    ta.beforeWrite()
    ta.onInput('a')
    expect(ta.overlay()).toBeNull()
  })
})

describe('不预测的位置', () => {
  test('光标在行中间（右边是普通字符）：不预测', () => {
    const { s, ta, server, wait, warm } = setup()
    warm()
    server(() => {
      s.put(0, 4, ' -la')
    })
    wait(500)
    ta.onInput('x')
    expect(ta.overlay()).toBeNull()
  })

  test('右侧提示符：隔着空白可以预测，写到它跟前就停', () => {
    const { s, ta, server, wait, warm } = setup(16)
    warm()
    server(() => s.put(0, 12, 'RP'))
    wait(500)
    ta.onInput('abc')
    expect(shown(ta)).toBe('abc')
    ta.onInput('defghi')
    expect(shown(ta)).toBe('abcdefgh') // 第 9 个字落在 RP 上 → 屏障，它和之后的不预测
  })

  test('不预测折行（最后一列）', () => {
    const { ta, warm } = setup(10)
    warm()
    ta.onInput('abcde') // 第 4–8 列
    expect(shown(ta)).toBe('abcde')
    ta.onInput('f') // 第 9 列是最后一列：不预测
    expect(shown(ta)).toBe('abcde')
  })

  test('全屏程序（alternate buffer）里不预测', () => {
    const { s, ta, warm } = setup()
    warm()
    s.alternate = true
    ta.onInput('j')
    expect(ta.overlay()).toBeNull()
  })

  test('reset（尺寸变化 / 切缓冲区）后本行要重新确认', () => {
    const { ta, wait, warm } = setup()
    warm()
    ta.reset()
    wait(500)
    ta.onInput('a')
    expect(ta.overlay()).toBeNull()
  })
})
