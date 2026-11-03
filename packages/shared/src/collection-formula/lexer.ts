// ---------- 公式的词法：把表达式切成记号 ----------
// 表达式来自协同文档（任何成员都能写进任何东西），这里只做线性扫描、不回溯，长度上限由调用方（compile）先判。
// 位置一律是 UTF-16 下标（编辑器 textarea 的光标也是），[开始, 结束)。

/** 表达式最多多少字（UTF-16 长度）：超出就是语法错误，挡住恶意文档拖垮服务端 */
export const FORMULA_MAX = 2000

export type Span = [number, number]

export type FormulaErrorCode =
  | 'empty'
  | 'too_long'
  | 'too_deep'
  | 'syntax'
  | 'unknown_prop'
  | 'deleted_prop'
  | 'dup_name'
  | 'unknown_function'
  | 'arity'
  | 'type'
  | 'cycle'
  | 'bad_ref'

/** 公式错误：at 是出错的那一段（编辑器标红），没有具体位置时不给 */
export type FormulaError = { code: FormulaErrorCode; message: string; at?: Span }

export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>='

export type Token =
  | { t: 'num'; value: number; at: Span }
  | { t: 'str'; value: string; at: Span }
  /** 属性引用：存储形 [@id] 的 id = true、name 是 id；显示形 [名字] 的 name 是名字（已去掉转义） */
  | { t: 'ref'; name: string; id: boolean; at: Span }
  | { t: 'ident'; name: string; at: Span }
  | { t: 'op'; op: BinOp; at: Span }
  | { t: '(' | ')' | ','; at: Span }
  | { t: 'end'; at: Span }

export type LexResult = { ok: true; tokens: Token[] } | { ok: false; error: FormulaError; tokens: Token[] }

export class FormulaSyntaxError extends Error {
  constructor(readonly error: FormulaError) {
    super(error.message)
  }
}

const fail = (message: string, at: Span, code: FormulaErrorCode = 'syntax'): never => {
  throw new FormulaSyntaxError({ code, message, at })
}

const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y
const SPACE_RE = /\s/
// 中文输入法常打出全角的括号与逗号，和半角一样认
const PUNCT: Record<string, '(' | ')' | ','> = { '(': '(', ')': ')', ',': ',', '（': '(', '）': ')', '，': ',' }
const OPS2: Record<string, BinOp> = { '<=': '<=', '>=': '>=', '<>': '<>', '!=': '<>' }
const OPS1: Record<string, BinOp> = { '+': '+', '-': '-', '*': '*', '/': '/', '^': '^', '&': '&', '=': '=', '<': '<', '>': '>' }

/** 字符串：" … " 或中文的 “ … ”；\" \” \\ 转义成字符本身，别的反斜杠原样留着 */
function readString(text: string, start: number): { value: string; end: number } {
  const close = text[start] === '“' ? '”' : '"'
  let value = ''
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\' && (text[i + 1] === close || text[i + 1] === '\\')) {
      value += text[i + 1]
      i++
    } else if (c === close) {
      return { value, end: i + 1 }
    } else {
      value += c
    }
  }
  return fail(`文本没有结束（缺少 ${close}）`, [start, text.length])
}

/** 属性引用：[ … ]；\] \\ 转义成字符本身，开头的 \@ 是字面的 @（名字以 @ 开头的属性），开头没转义的 @ 是存储形 */
function readRef(text: string, start: number): { name: string; id: boolean; end: number } {
  let name = ''
  const id = text[start + 1] === '@'
  for (let i = start + (id ? 2 : 1); i < text.length; i++) {
    const c = text[i]!
    if (c === '\\' && (text[i + 1] === ']' || text[i + 1] === '\\' || text[i + 1] === '@')) {
      name += text[i + 1]
      i++
    } else if (c === ']') {
      if (name === '') fail('属性引用是空的', [start, i + 1])
      return { name, id, end: i + 1 }
    } else {
      name += c
    }
  }
  return fail('属性引用没有结束（缺少 ]）', [start, text.length])
}

/** 切成记号，末尾恒有一个 end。出错时 tokens 是出错前切好的那些（toDisplay 尽量换掉认得的引用） */
export function lex(text: string): LexResult {
  const tokens: Token[] = []
  try {
    let i = 0
    while (i < text.length) {
      const c = text[i]!
      if (SPACE_RE.test(c)) {
        i++
        continue
      }
      if (c === '"' || c === '“') {
        const s = readString(text, i)
        tokens.push({ t: 'str', value: s.value, at: [i, s.end] })
        i = s.end
        continue
      }
      if (c === '[') {
        const r = readRef(text, i)
        tokens.push({ t: 'ref', name: r.name, id: r.id, at: [i, r.end] })
        i = r.end
        continue
      }
      const punct = Object.hasOwn(PUNCT, c) ? PUNCT[c] : undefined
      if (punct) {
        tokens.push({ t: punct, at: [i, i + 1] })
        i++
        continue
      }
      const two = text.slice(i, i + 2)
      if (Object.hasOwn(OPS2, two)) {
        tokens.push({ t: 'op', op: OPS2[two]!, at: [i, i + 2] })
        i += 2
        continue
      }
      if (Object.hasOwn(OPS1, c)) {
        tokens.push({ t: 'op', op: OPS1[c]!, at: [i, i + 1] })
        i++
        continue
      }
      NUMBER_RE.lastIndex = i
      const num = NUMBER_RE.exec(text)
      if (num) {
        const value = Number(num[0])
        const at: Span = [i, i + num[0].length]
        if (!Number.isFinite(value)) fail('数字太大', at)
        tokens.push({ t: 'num', value, at })
        i = at[1]
        continue
      }
      IDENT_RE.lastIndex = i
      const ident = IDENT_RE.exec(text)
      if (ident) {
        tokens.push({ t: 'ident', name: ident[0], at: [i, i + ident[0].length] })
        i += ident[0].length
        continue
      }
      const ch = String.fromCodePoint(text.codePointAt(i)!)
      fail(`认不出「${ch}」`, [i, i + ch.length])
    }
    tokens.push({ t: 'end', at: [text.length, text.length] })
    return { ok: true, tokens }
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return { ok: false, error: err.error, tokens }
    throw err
  }
}

/** 属性名写进显示形的引用：] 与 \ 转义，开头的 @ 转义（否则会被当成存储形的 id） */
export function refText(name: string): string {
  const body = name.replace(/[\\\]]/g, (c) => `\\${c}`)
  return `[${body.startsWith('@') ? `\\${body}` : body}]`
}
