// ---------- 公式的语法：记号 → 语法树 ----------
// 优先级（低 → 高）：比较 → & → + - → * / → ^（右结合）→ 负号 → 调用 / 字面量 / 引用 / 括号。
// 递归下降，嵌套（括号、函数调用、负号、^ 的右结合）超过 DEPTH_MAX 层就是语法错误：
// 表达式来自协同文档，不设上限的话一串几千个括号就能把服务端的调用栈压爆。同级的左结合链（1+1+…）是循环，不占层数。

import { FormulaSyntaxError, type BinOp, type FormulaError, type Span, type Token } from './lexer.js'
import type { FormulaType } from './types.js'

/** 嵌套最多多少层 */
export const DEPTH_MAX = 50

/** 每个节点都有它在表达式里的位置；ty 是类型推断填上的静态类型（求值时据此处理空值，如日期 + 天数里日期为空） */
type At = { at: Span; ty?: FormulaType }

export type Node =
  | ({ k: 'num'; v: number } & At)
  | ({ k: 'str'; v: string } & At)
  | ({ k: 'bool'; v: boolean } & At)
  /** 属性引用（已解析成属性 id，「名称」是 title） */
  | ({ k: 'ref'; id: string } & At)
  | ({ k: 'neg'; x: Node } & At)
  | ({ k: 'bin'; op: BinOp; a: Node; b: Node } & At)
  /** 函数调用：fn 已转成大写（函数名不分大小写） */
  | ({ k: 'call'; fn: string; args: Node[] } & At)

/** 引用记号 → 属性 id；认不出返回错误（不存在、已删、重名） */
export type RefResolver = (token: Extract<Token, { t: 'ref' }>) => string | FormulaError

export type ParseResult = { ok: true; ast: Node; refs: { id: string; at: Span }[] } | { ok: false; error: FormulaError }

const COMPARE: ReadonlySet<BinOp> = new Set(['=', '<>', '<', '>', '<=', '>='])

const TOKEN_TEXT: Record<Token['t'], string> = { num: '数字', str: '文本', ref: '属性引用', ident: '名字', op: '运算符', '(': '(', ')': ')', ',': ',', end: '结尾' }

export function parse(tokens: Token[], resolve: RefResolver): ParseResult {
  let pos = 0
  let depth = 0
  const refs: { id: string; at: Span }[] = []
  const peek = (): Token => tokens[pos] ?? tokens[tokens.length - 1]!
  const next = (): Token => {
    const token = peek()
    if (pos < tokens.length - 1) pos++
    return token
  }
  const fail = (message: string, at: Span): never => {
    throw new FormulaSyntaxError({ code: 'syntax', message, at })
  }
  const unexpected = (token: Token): never =>
    token.t === 'end' ? fail('公式没写完', token.at) : fail(`这里不该有${token.t === 'op' ? `「${token.op}」` : TOKEN_TEXT[token.t]}`, token.at)
  const enter = (at: Span): void => {
    if (++depth > DEPTH_MAX) throw new FormulaSyntaxError({ code: 'too_deep', message: `嵌套太深（最多 ${DEPTH_MAX} 层）`, at })
  }
  const span = (a: Node, b: Node): Span => [a.at[0], b.at[1]]
  const isOp = (token: Token, ops: readonly BinOp[]): token is Extract<Token, { t: 'op' }> => token.t === 'op' && ops.includes(token.op)

  function binaryLevel(ops: readonly BinOp[], operand: () => Node): Node {
    let left = operand()
    for (let token = peek(); isOp(token, ops); token = peek()) {
      next()
      const right = operand()
      left = { k: 'bin', op: token.op, a: left, b: right, at: span(left, right) }
    }
    return left
  }

  const expr = (): Node => binaryLevel([...COMPARE], concat)
  const concat = (): Node => binaryLevel(['&'], additive)
  const additive = (): Node => binaryLevel(['+', '-'], term)
  const term = (): Node => binaryLevel(['*', '/'], power)

  function power(): Node {
    const base = unary()
    const token = peek()
    if (!isOp(token, ['^'])) return base
    next()
    enter(token.at)
    const exponent = power()
    depth--
    return { k: 'bin', op: '^', a: base, b: exponent, at: span(base, exponent) }
  }

  function unary(): Node {
    const token = peek()
    if (!isOp(token, ['-', '+'])) return primary()
    next()
    enter(token.at)
    const x = unary()
    depth--
    // 正号记成 0 + x：类型检查与求值都复用加法
    if (token.op === '+') return { k: 'bin', op: '+', a: { k: 'num', v: 0, at: token.at }, b: x, at: [token.at[0], x.at[1]] }
    return { k: 'neg', x, at: [token.at[0], x.at[1]] }
  }

  function primary(): Node {
    const token = next()
    switch (token.t) {
      case 'num':
        return { k: 'num', v: token.value, at: token.at }
      case 'str':
        return { k: 'str', v: token.value, at: token.at }
      case 'ref': {
        const id = resolve(token)
        if (typeof id !== 'string') throw new FormulaSyntaxError(id)
        refs.push({ id, at: token.at })
        return { k: 'ref', id, at: token.at }
      }
      case '(': {
        enter(token.at)
        const inner = expr()
        depth--
        const close = next()
        if (close.t !== ')') fail('缺少 )', close.at)
        return inner
      }
      case 'ident':
        return call(token)
      default:
        return unexpected(token)
    }
  }

  function call(token: Extract<Token, { t: 'ident' }>): Node {
    const name = token.name.toUpperCase()
    if (peek().t !== '(') {
      if (name === 'TRUE' || name === 'FALSE') return { k: 'bool', v: name === 'TRUE', at: token.at }
      return fail(`「${token.name}」后面要跟 (，属性要写成 [${token.name}]`, token.at)
    }
    enter(token.at)
    next()
    const args: Node[] = []
    if (peek().t !== ')') {
      for (;;) {
        args.push(expr())
        const sep = peek()
        if (sep.t === ',') {
          next()
          continue
        }
        if (sep.t !== ')') fail('参数之间要用逗号隔开，或缺少 )', sep.at)
        break
      }
    }
    const close = next()
    depth--
    return { k: 'call', fn: name, args, at: [token.at[0], close.at[1]] }
  }

  try {
    if (peek().t === 'end') return { ok: false, error: { code: 'empty', message: '公式是空的' } }
    const ast = expr()
    const rest = peek()
    if (rest.t !== 'end') unexpected(rest)
    return { ok: true, ast, refs }
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return { ok: false, error: err.error }
    throw err
  }
}
