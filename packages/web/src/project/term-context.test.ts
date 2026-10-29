import { describe, expect, test } from 'vitest'
import { commandKeystrokes, sanitizeCommand, stripAnsi, terminalTail } from './term-context'

const ESC = '\x1b'

describe('stripAnsi：控制序列剥干净，可见文字不动', () => {
  test('颜色 / 光标移动 / 清屏 / 私有模式', () => {
    expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m done`)).toBe('ok done')
    expect(stripAnsi(`a${ESC}[2K${ESC}[1Gb${ESC}[?25l${ESC}[?2004h`)).toBe('ab')
    expect(stripAnsi(`${ESC}[38;5;208mx${ESC}[39m`)).toBe('x')
  })

  test('OSC（设置标题、超链接）以 BEL 或 ST 结束；没结束的吃到末尾', () => {
    expect(stripAnsi(`${ESC}]0;my title\x07prompt$ `)).toBe('prompt$ ')
    expect(stripAnsi(`${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
    expect(stripAnsi(`visible${ESC}]0;never ends`)).toBe('visible')
  })

  test('字符集切换等短序列、8 位 C1 控制符；普通文字（含中文、emoji）原样', () => {
    expect(stripAnsi(`${ESC}(Bhello${ESC}=${ESC}>`)).toBe('hello')
    expect(stripAnsi('a\u009bb')).toBe('ab')
    expect(stripAnsi('你好 🚀 [not csi]')).toBe('你好 🚀 [not csi]')
  })
})

describe('terminalTail：给模型看的终端输出', () => {
  test('只留最后 N 行，空行不占位，行尾空白去掉', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `line ${i + 1}   `).join('\r\n') + '\r\n\r\n'
    const out = terminalTail(raw).split('\n')
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('line 21')
    expect(out.at(-1)).toBe('line 50')
    expect(terminalTail('a\nb\nc', 2)).toBe('b\nc')
    expect(terminalTail('')).toBe('')
  })

  test('回车覆盖的进度条只剩最后一帧；退格生效', () => {
    expect(terminalTail('download 10%\rdownload 55%\rdownload 100%\r\nnext')).toBe('download 100%\nnext')
    expect(terminalTail('abc\b \bX')).toBe('abX') // shell 的退格是 \b \b：左移、盖一个空格、再左移
    // 后一帧比前一帧短：覆盖不到的尾巴是旧内容（终端本身的行为就是这样，真实场景会先发 ESC[K 清行）
    expect(terminalTail('hello\rhi')).toBe('hillo')
    expect(terminalTail(`hello\r${ESC}[Khi`)).toBe('hillo')
  })

  test('带颜色的提示符和命令回显：剥完是干净的文本，不含任何控制字符', () => {
    const raw = `${ESC}]0;~/proj\x07${ESC}[32muser@box${ESC}[0m:${ESC}[34m~/proj${ESC}[0m$ ls\r\na.txt  b.txt\r\n`
    const out = terminalTail(raw)
    expect(out).toBe('user@box:~/proj$ ls\na.txt  b.txt')
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  })
})

describe('sanitizeCommand：模型给的命令当不可信文本', () => {
  test('普通命令原样；围栏 / 反引号 / 提示符 $ 去掉', () => {
    expect(sanitizeCommand('git status')).toEqual({ command: 'git status', multiline: false })
    expect(sanitizeCommand('```bash\nls -la\n```')).toEqual({ command: 'ls -la', multiline: false })
    expect(sanitizeCommand('`pwd`')).toEqual({ command: 'pwd', multiline: false })
    expect(sanitizeCommand('$ npm test\n')).toEqual({ command: 'npm test', multiline: false })
    expect(sanitizeCommand('find . -name "*.ts" | wc -l')).toEqual({ command: 'find . -name "*.ts" | wc -l', multiline: false })
  })

  test('多行命令标 multiline；换行只保留 \\n', () => {
    expect(sanitizeCommand('cd a\r\nnpm i')).toEqual({ command: 'cd a\nnpm i', multiline: true })
    expect(sanitizeCommand('```\nline1\nline2\n```')).toEqual({ command: 'line1\nline2', multiline: true })
  })

  test('控制字符一个都不留：ESC 序列、Ctrl-C、退格、回车、NUL、DEL、C1', () => {
    const evil = `ls${ESC}[2J\x03\x08\x00\x7f\u009b; rm x\r`
    const out = sanitizeCommand(evil)
    expect(out?.command).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(out?.command).toBe('ls[2J; rm x')
  })

  test('不可见的方向控制 / 零宽字符去掉：看到的就是执行的', () => {
    const out = sanitizeCommand('echo \u202eevil\u202c \u200bhi\ufeff')
    expect(out?.command).toBe('echo evil hi')
  })

  test('空的 / 全是控制字符 / 过长 → null', () => {
    expect(sanitizeCommand('')).toBeNull()
    expect(sanitizeCommand('  \n ')).toBeNull()
    expect(sanitizeCommand('\x03\x04')).toBeNull()
    expect(sanitizeCommand('x'.repeat(4001))).toBeNull()
    expect(sanitizeCommand('x'.repeat(4000))).not.toBeNull()
  })
})

describe('commandKeystrokes', () => {
  test('execute = false 只放进输入行（没有回车）；true 才回车，多行每行一个回车', () => {
    expect(commandKeystrokes('ls -la', false)).toBe('ls -la')
    expect(commandKeystrokes('ls -la', true)).toBe('ls -la\r')
    expect(commandKeystrokes('cd a\nnpm i', true)).toBe('cd a\rnpm i\r')
    expect(commandKeystrokes('ls', false)).not.toContain('\r')
  })
})
