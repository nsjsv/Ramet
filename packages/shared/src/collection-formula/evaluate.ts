// ---------- 公式的求值：语法树 → 值，值 → 写进 row.computed 的 JSON ----------
// 解释执行（不拼代码、不用 eval / Function）：表达式来自协同文档，任何成员都能写。
// 递归深度受语法树深度限制（解析时嵌套 ≤ 50 层，同级的左结合链长度受 2,000 字的上限限制）；
// 处理长文字 / 长列表的工作量按行记账（functions.ts 的 WORK_MAX）。
// IF / IFS / SWITCH / AND / OR 按需求值：IF([数量] = 0, 0, [总价] / [数量]) 在数量为 0 时不该因为没走到的分支而为空。

import { fromEpochDay, TEXT_MAX } from '../collection-values.js'
import {
  bool,
  capped,
  cpIndex,
  finite,
  IMPLS,
  isDate,
  num,
  oops,
  order,
  same,
  shiftDays,
  spend,
  toText,
  type EvalEnv,
  type FormulaDate,
  type FormulaValue,
  type Scalar,
} from './functions.js'
import type { Node } from './parser.js'
import type { FormulaType } from './types.js'

function evalBinary(node: Extract<Node, { k: 'bin' }>, env: EvalEnv): FormulaValue {
  const a = evalNode(node.a, env)
  const b = evalNode(node.b, env)
  switch (node.op) {
    case '&':
      return capped(toText(a, env) + toText(b, env))
    case '+':
      // 日期加天数：日期那一边是空就整个为空（不能把空当 0 天、再加出一个「数字」来）
      if (node.ty === 'date') {
        const [d, n] = node.a.ty === 'date' ? [a, b] : [b, a]
        return isDate(d) ? shiftDays(d, num(n)) : null
      }
      return finite(num(a) + num(b))
    case '-':
      if (node.ty === 'date') return isDate(a) ? shiftDays(a, -num(b)) : null
      if (node.a.ty === 'date') return isDate(a) && isDate(b) ? a.start - b.start : null
      return finite(num(a) - num(b))
    case '*':
      return finite(num(a) * num(b))
    case '/': {
      const divisor = num(b)
      return divisor === 0 ? oops() : finite(num(a) / divisor)
    }
    case '^':
      return finite(num(a) ** num(b))
    case '=':
      return same(a, b, env)
    case '<>':
      return !same(a, b, env)
    case '<':
      return order(a, b) === -1
    case '>':
      return order(a, b) === 1
    case '<=': {
      const c = order(a, b)
      return c === -1 || c === 0
    }
    case '>=': {
      const c = order(a, b)
      return c === 1 || c === 0
    }
  }
}

function evalCall(node: Extract<Node, { k: 'call' }>, env: EvalEnv): FormulaValue {
  const args = node.args
  switch (node.fn) {
    case 'IF':
      return bool(evalNode(args[0]!, env)) ? evalNode(args[1]!, env) : args[2] ? evalNode(args[2], env) : null
    case 'IFS':
      for (let i = 0; i < args.length; i += 2) {
        if (i + 1 >= args.length) return evalNode(args[i]!, env)
        if (bool(evalNode(args[i]!, env))) return evalNode(args[i + 1]!, env)
      }
      return null
    case 'SWITCH': {
      const subject = evalNode(args[0]!, env)
      for (let i = 1; i < args.length; i += 2) {
        if (i + 1 >= args.length) return evalNode(args[i]!, env)
        if (same(subject, evalNode(args[i]!, env), env)) return evalNode(args[i + 1]!, env)
      }
      return null
    }
    case 'AND':
      return args.every((arg) => bool(evalNode(arg, env)))
    case 'OR':
      return args.some((arg) => bool(evalNode(arg, env)))
  }
  const impl = IMPLS.get(node.fn)
  // 编译时已核对过函数名，这里还认不出只能是表与实现没对上
  if (!impl) throw new Error(`没有实现函数 ${node.fn}`)
  return impl(
    args.map((arg) => evalNode(arg, env)),
    env,
  )
}

function evalNode(node: Node, env: EvalEnv): FormulaValue {
  switch (node.k) {
    case 'num':
      return node.v
    case 'str':
      return node.v
    case 'bool':
      return node.v
    case 'ref':
      return env.ref(node.id)
    case 'neg':
      return finite(-num(evalNode(node.x, env)))
    case 'bin':
      return evalBinary(node, env)
    case 'call':
      return evalCall(node, env)
  }
}

/** 空文本、空列表、算不出的数都归成空：公式之间互相引用时，与写进 computed 再读回来的口径一样 */
function normalize(v: FormulaValue): FormulaValue {
  if (v === '' || (Array.isArray(v) && v.length === 0)) return null
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v
}

/** 求一个公式在一行上的值。运行时错误（除以零、日期越界、函数认不出参数、这一行的工作量用完……）整格为空；
 *  任何别的异常（含调用栈溢出）也当空：一格算不出不能让整个窗口查询失败。
 *  结果的文字 / 列表也记工作量：它们要随窗口发出去，一百个公式各抄一份几千项的反向关联，响应会大上百倍 */
export function evaluate(ast: Node, env: EvalEnv): FormulaValue {
  try {
    const value = normalize(evalNode(ast, env))
    if (typeof value === 'string' || Array.isArray(value)) spend(env, value.length)
    return value
  } catch {
    return null
  }
}

/** 写进 computed 的日期：带时刻的是 ISO 时间戳，单日 'YYYY-MM-DD'，区间 '开始/结束'（同日期属性的写法） */
function encodeDate(d: FormulaDate): string | undefined {
  if (d.ms !== undefined) {
    // 日期运算都核对过天数，毫秒不会越界；万一越界 toISOString 会抛，这里在求值的 try 之外，抛了整个窗口查询就失败
    const date = new Date(d.ms)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return d.start === d.end ? fromEpochDay(d.start) : `${fromEpochDay(d.start)}/${fromEpochDay(d.end)}`
}

/** 文本结果写进 computed 前截到上限（按码点，不切开半个 emoji），与文本属性同一个上限 */
function clipText(s: string): string {
  return s.length > TEXT_MAX ? s.slice(0, cpIndex(s, TEXT_MAX)) : s
}

const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/** 值 → 写进 row.computed 的 JSON（按编译出的类型；空、形状与类型对不上 = undefined，不写这一项） */
export function encodeValue(v: FormulaValue, type: FormulaType): unknown {
  if (v === null) return undefined
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    case 'text':
      return typeof v === 'string' && v !== '' ? clipText(v) : undefined
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined
    case 'date':
      return isDate(v) ? encodeDate(v) : undefined
    case 'list':
      return Array.isArray(v) && v.length > 0 && v.every(isScalar) ? v : undefined
  }
}
