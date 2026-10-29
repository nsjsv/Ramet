/* ---------- 终端里的 ⌘J（说人话）：给模型看的终端输出、模型给回的命令 ----------
 * 两个方向都在这里把关，纯函数：
 *   - 出：终端原始输出里全是控制序列（颜色、光标移动、标题等）和 \r 覆盖的进度条，发给模型前先剥干净，只留最后几行
 *     （终端输出只是参考，按了 ⌘J 才会发；服务端也再留尾 30 行 / 6000 字）。
 *   - 入：模型给回的命令当成不可信文本，去掉围栏 / 反引号、所有控制字符和会让显示与实际不一致的不可见字符，
 *     建议条里显示的和写进终端的是同一份。永远不自动执行，由用户在建议条上按回车（或点按钮）。 */

/** 发给模型的终端输出最多留多少行（服务端同值） */
export const TERM_CONTEXT_LINES = 30
/** 建议的命令最长多少字：再长多半不是命令 */
export const COMMAND_MAX_CHARS = 4000

// CSI：ESC [ 参数 中间字节 终止字节；OSC / DCS / SOS / PM / APC：ESC ] P X ^ _ … 到 BEL 或 ST（ESC \）；
// 其余 ESC + 一个（或两个）字符的短序列（ESC ( B、ESC = 等）；还有 8 位的 C1 控制符
const OSC_LIKE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC_SHORT = /\x1b[ -/]*[0-~]/g
const C1 = /[\u0080-\u009f]/g

/** 剥掉 ANSI 控制序列，剩下 \n \r \t \b 和可见文字 */
export function stripAnsi(raw: string): string {
  return raw.replace(OSC_LIKE, '').replace(CSI, '').replace(ESC_SHORT, '').replace(C1, '')
}

/** 一行里 \r（回到行首覆盖）与 \b（退格）生效后屏幕上留下的样子：进度条 `10%\r20%\r30%` 只剩 `30%` */
function settleLine(line: string): string {
  const out: string[] = []
  let col = 0
  for (const ch of line) {
    if (ch === '\r') col = 0
    else if (ch === '\b') col = Math.max(0, col - 1)
    else {
      out[col] = ch
      col += 1
    }
  }
  return Array.from(out, (c) => c ?? ' ').join('')
}

/** 终端原始输出 → 给模型的文本：剥控制序列、让 \r / \b 生效、去掉剩下的控制字符和行尾空白、只留最后 maxLines 行（空行不占位） */
export function terminalTail(raw: string, maxLines = TERM_CONTEXT_LINES): string {
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => settleLine(l).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-maxLines).join('\n')
}

// 会让"看到的"和"执行的"对不上的不可见字符：零宽字符、方向控制（RLO 之类）、BOM
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

export interface SuggestedCommand {
  command: string
  /** 含换行：粘进终端会一行行执行，要用户额外确认 */
  multiline: boolean
}

/** 模型的输出 → 建议的命令。拿不出可用的命令（空、过长）返回 null */
export function sanitizeCommand(raw: string): SuggestedCommand | null {
  let s = raw.replace(/\r\n?/g, '\n').trim()
  // 整段被围栏包着
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(s)
  if (fenced) s = (fenced[2] ?? '').trim()
  // 一对反引号包着的单行
  else if (/^`[^`\n]+`$/.test(s)) s = s.slice(1, -1).trim()
  s = s
    .replace(INVISIBLE, '')
    // 除换行和制表符外的控制字符：ESC 序列、Ctrl-C、退格、回车……一律不进终端
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .trim()
  // 单行命令前面带着的提示符 `$ `
  if (!s.includes('\n')) s = s.replace(/^\$\s+/, '')
  if (!s || s.length > COMMAND_MAX_CHARS) return null
  return { command: s, multiline: s.includes('\n') }
}

/** 命令 → 要写进 pty 的按键。execute = false：只放进 shell 的输入行，不回车（用户自己改、自己回车）；
 *  true：加上回车执行（多行命令每行一个回车）。只有用户在建议条上确认后才会调用 execute = true */
export function commandKeystrokes(command: string, execute: boolean): string {
  const text = command.split('\n').join('\r')
  return execute ? `${text}\r` : text
}
