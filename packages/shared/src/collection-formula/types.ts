// ---------- 公式的类型：函数签名表与静态类型推断 ----------
// 输出类型（数字 / 文本 / 是否 / 日期 / 列表）在编译时就定下来：它决定这一列怎么显示、能用哪些筛选运算、能不能排序，
// 解析视图时手上只有集合定义、没有行，所以不能看算出来的值再定。推断不出来（参数类型不对、分支类型不一致）就是编译错误。
// 算术、比较、条件不做隐式转换（文本当数字、数字当条件都是类型错误）：静态类型说是数字，算出来就一定是数字或空，筛选排序才靠得住。
// 文本连接（& 与 CONCAT）例外：任何类型都按 TEXT() 的显示文字接上，结果恒是文本 ——
// CONCAT([编号], " ", [名称]) 这类拼编号、拼日期的写法最常见，逼人套一层 TEXT() 只会让人以为写错了。

import { FormulaSyntaxError, type BinOp, type FormulaError, type Span } from './lexer.js'
import type { Node } from './parser.js'

export type FormulaType = 'number' | 'text' | 'boolean' | 'date' | 'list'

export const FORMULA_TYPES: readonly FormulaType[] = ['number', 'text', 'boolean', 'date', 'list']

export const TYPE_LABEL: Record<FormulaType, string> = { number: '数字', text: '文本', boolean: '是否', date: '日期', list: '列表' }

export type FunctionGroup = 'logic' | 'math' | 'text' | 'date' | 'list'

/** 参数类型：any = 任何类型，numbers = 数字或列表（列表里的数字逐个算） */
type Param = FormulaType | 'any' | 'numbers'

type ArgError = { message: string; arg?: number }
type Check = (name: string, types: FormulaType[], args: Node[]) => FormulaType | ArgError

type FnSig = { group: FunctionGroup; signature: string; min: number; max: number; check: Check }

const PARAM_LABEL: Record<Param, string> = { ...TYPE_LABEL, any: '任意值', numbers: '数字或列表' }

const accepts = (param: Param, type: FormulaType): boolean =>
  param === 'any' || param === type || (param === 'numbers' && (type === 'number' || type === 'list'))

const argError = (name: string, i: number, param: Param, type: FormulaType): ArgError => ({
  message: `${name} 的第 ${i + 1} 个参数要是「${PARAM_LABEL[param]}」，这里是「${TYPE_LABEL[type]}」`,
  arg: i,
})

/** 按位置给参数类型（超出 params 的按 rest），返回固定类型 */
function plain(params: Param[], returns: FormulaType, rest?: Param): Check {
  return (name, types) => {
    for (let i = 0; i < types.length; i++) {
      const param = params[i] ?? rest
      if (param && !accepts(param, types[i]!)) return argError(name, i, param, types[i]!)
    }
    return returns
  }
}

/** 单位参数：写的是字面量时编译期就核对（不是字面量的到运行时认不出就为空） */
function withUnit(check: Check, index: number, units: readonly string[]): Check {
  return (name, types, args) => {
    const out = check(name, types, args)
    const arg = args[index]
    if (typeof out === 'string' && arg?.k === 'str' && !units.includes(arg.v.toUpperCase())) {
      return { message: `${name} 的单位只能是 ${units.map((u) => `"${u}"`).join('、')}`, arg: index }
    }
    return out
  }
}

/** 分支的结果类型必须一致 */
function sameBranches(name: string, types: FormulaType[], indexes: number[]): FormulaType | ArgError {
  const first = types[indexes[0]!]!
  for (const i of indexes) {
    if (types[i] !== first) return { message: `${name} 的各个结果类型不同：「${TYPE_LABEL[first]}」和「${TYPE_LABEL[types[i]!]}」`, arg: i }
  }
  return first
}

const checkIf: Check = (name, types) => {
  if (types[0] !== 'boolean') return argError(name, 0, 'boolean', types[0]!)
  return sameBranches(name, types, types.length === 3 ? [1, 2] : [1])
}

const checkIfs: Check = (name, types) => {
  const values: number[] = []
  for (let i = 0; i < types.length; i += 2) {
    if (i + 1 >= types.length) {
      values.push(i) // 落单的最后一个是缺省值
      break
    }
    if (types[i] !== 'boolean') return argError(name, i, 'boolean', types[i]!)
    values.push(i + 1)
  }
  return sameBranches(name, types, values)
}

const checkSwitch: Check = (name, types) => {
  const subject = types[0]!
  const values: number[] = []
  for (let i = 1; i < types.length; i += 2) {
    if (i + 1 >= types.length) {
      values.push(i)
      break
    }
    if (types[i] !== subject) return argError(name, i, subject, types[i]!)
    values.push(i + 1)
  }
  return sameBranches(name, types, values)
}

const DATE_UNITS = ['D', 'M', 'Y'] as const
const ADD_UNITS = ['D', 'W', 'M', 'Y'] as const

const MANY = Number.MAX_SAFE_INTEGER

/** 函数表：键是大写的函数名。用 Map 而不是对象字面量：函数名来自用户输入，查对象会摸到原型上的东西 */
export const FUNCTIONS: ReadonlyMap<string, FnSig> = new Map<string, FnSig>([
  ['IF', { group: 'logic', signature: 'IF(条件, 真值, [假值])', min: 2, max: 3, check: checkIf }],
  ['IFS', { group: 'logic', signature: 'IFS(条件1, 值1, …, [缺省])', min: 2, max: MANY, check: checkIfs }],
  ['SWITCH', { group: 'logic', signature: 'SWITCH(值, 情形1, 结果1, …, [缺省])', min: 3, max: MANY, check: checkSwitch }],
  ['AND', { group: 'logic', signature: 'AND(条件1, …)', min: 1, max: MANY, check: plain([], 'boolean', 'boolean') }],
  ['OR', { group: 'logic', signature: 'OR(条件1, …)', min: 1, max: MANY, check: plain([], 'boolean', 'boolean') }],
  ['NOT', { group: 'logic', signature: 'NOT(条件)', min: 1, max: 1, check: plain(['boolean'], 'boolean') }],
  ['ISBLANK', { group: 'logic', signature: 'ISBLANK(值)', min: 1, max: 1, check: plain(['any'], 'boolean') }],

  ['SUM', { group: 'math', signature: 'SUM(数字1, …)', min: 1, max: MANY, check: plain([], 'number', 'numbers') }],
  ['AVERAGE', { group: 'math', signature: 'AVERAGE(数字1, …)', min: 1, max: MANY, check: plain([], 'number', 'numbers') }],
  ['MIN', { group: 'math', signature: 'MIN(数字1, …)', min: 1, max: MANY, check: plain([], 'number', 'numbers') }],
  ['MAX', { group: 'math', signature: 'MAX(数字1, …)', min: 1, max: MANY, check: plain([], 'number', 'numbers') }],
  ['ROUND', { group: 'math', signature: 'ROUND(数字, [小数位])', min: 1, max: 2, check: plain(['number', 'number'], 'number') }],
  ['ROUNDUP', { group: 'math', signature: 'ROUNDUP(数字, [小数位])', min: 1, max: 2, check: plain(['number', 'number'], 'number') }],
  ['ROUNDDOWN', { group: 'math', signature: 'ROUNDDOWN(数字, [小数位])', min: 1, max: 2, check: plain(['number', 'number'], 'number') }],
  ['CEILING', { group: 'math', signature: 'CEILING(数字)', min: 1, max: 1, check: plain(['number'], 'number') }],
  ['FLOOR', { group: 'math', signature: 'FLOOR(数字)', min: 1, max: 1, check: plain(['number'], 'number') }],
  ['ABS', { group: 'math', signature: 'ABS(数字)', min: 1, max: 1, check: plain(['number'], 'number') }],
  ['MOD', { group: 'math', signature: 'MOD(被除数, 除数)', min: 2, max: 2, check: plain(['number', 'number'], 'number') }],
  ['POWER', { group: 'math', signature: 'POWER(底数, 指数)', min: 2, max: 2, check: plain(['number', 'number'], 'number') }],
  ['SQRT', { group: 'math', signature: 'SQRT(数字)', min: 1, max: 1, check: plain(['number'], 'number') }],
  ['INT', { group: 'math', signature: 'INT(数字)', min: 1, max: 1, check: plain(['number'], 'number') }],

  ['CONCAT', { group: 'text', signature: 'CONCAT(值1, …)', min: 1, max: MANY, check: plain([], 'text', 'any') }],
  ['LEN', { group: 'text', signature: 'LEN(文本)', min: 1, max: 1, check: plain(['text'], 'number') }],
  ['LEFT', { group: 'text', signature: 'LEFT(文本, [字数])', min: 1, max: 2, check: plain(['text', 'number'], 'text') }],
  ['RIGHT', { group: 'text', signature: 'RIGHT(文本, [字数])', min: 1, max: 2, check: plain(['text', 'number'], 'text') }],
  ['MID', { group: 'text', signature: 'MID(文本, 起点, 字数)', min: 3, max: 3, check: plain(['text', 'number', 'number'], 'text') }],
  ['UPPER', { group: 'text', signature: 'UPPER(文本)', min: 1, max: 1, check: plain(['text'], 'text') }],
  ['LOWER', { group: 'text', signature: 'LOWER(文本)', min: 1, max: 1, check: plain(['text'], 'text') }],
  ['TRIM', { group: 'text', signature: 'TRIM(文本)', min: 1, max: 1, check: plain(['text'], 'text') }],
  ['SUBSTITUTE', { group: 'text', signature: 'SUBSTITUTE(文本, 旧文本, 新文本)', min: 3, max: 3, check: plain(['text', 'text', 'text'], 'text') }],
  ['CONTAINS', { group: 'text', signature: 'CONTAINS(文本, 片段)', min: 2, max: 2, check: plain(['text', 'text'], 'boolean') }],
  ['TEXT', { group: 'text', signature: 'TEXT(值)', min: 1, max: 1, check: plain(['any'], 'text') }],
  ['VALUE', { group: 'text', signature: 'VALUE(文本)', min: 1, max: 1, check: plain(['text'], 'number') }],

  ['TODAY', { group: 'date', signature: 'TODAY()', min: 0, max: 0, check: plain([], 'date') }],
  ['NOW', { group: 'date', signature: 'NOW()', min: 0, max: 0, check: plain([], 'date') }],
  ['DATE', { group: 'date', signature: 'DATE(年, 月, 日)', min: 3, max: 3, check: plain(['number', 'number', 'number'], 'date') }],
  ['YEAR', { group: 'date', signature: 'YEAR(日期)', min: 1, max: 1, check: plain(['date'], 'number') }],
  ['MONTH', { group: 'date', signature: 'MONTH(日期)', min: 1, max: 1, check: plain(['date'], 'number') }],
  ['DAY', { group: 'date', signature: 'DAY(日期)', min: 1, max: 1, check: plain(['date'], 'number') }],
  ['WEEKDAY', { group: 'date', signature: 'WEEKDAY(日期)', min: 1, max: 1, check: plain(['date'], 'number') }],
  ['DATEDIF', { group: 'date', signature: 'DATEDIF(开始, 结束, "D" | "M" | "Y")', min: 3, max: 3, check: withUnit(plain(['date', 'date', 'text'], 'number'), 2, DATE_UNITS) }],
  ['DATEADD', { group: 'date', signature: 'DATEADD(日期, 数量, "D" | "W" | "M" | "Y")', min: 3, max: 3, check: withUnit(plain(['date', 'number', 'text'], 'date'), 2, ADD_UNITS) }],
  ['START', { group: 'date', signature: 'START(日期)', min: 1, max: 1, check: plain(['date'], 'date') }],
  ['END', { group: 'date', signature: 'END(日期)', min: 1, max: 1, check: plain(['date'], 'date') }],

  ['COUNT', { group: 'list', signature: 'COUNT(列表)', min: 1, max: 1, check: plain(['list'], 'number') }],
  ['JOIN', { group: 'list', signature: 'JOIN(列表, [分隔符])', min: 1, max: 2, check: plain(['list', 'text'], 'text') }],
  ['FIRST', { group: 'list', signature: 'FIRST(列表)', min: 1, max: 1, check: plain(['list'], 'text') }],
  ['LAST', { group: 'list', signature: 'LAST(列表)', min: 1, max: 1, check: plain(['list'], 'text') }],
  ['INCLUDES', { group: 'list', signature: 'INCLUDES(列表, 值)', min: 2, max: 2, check: plain(['list', 'any'], 'boolean') }],
])

export type FunctionDoc = { name: string; group: FunctionGroup; signature: string }

/** 编辑器侧栏与补全用的函数清单（按类、按表里的顺序）；中文说明与示例由前端按 name 对上 */
export const FUNCTION_DOCS: readonly FunctionDoc[] = [...FUNCTIONS].map(([name, sig]) => ({ name, group: sig.group, signature: sig.signature }))

/** 属性引用 → 静态类型（引用了已删 / 有误的属性时返回错误） */
export type TypeOf = (id: string, at: Span) => FormulaType | FormulaError

const fail = (message: string, at: Span, code: FormulaError['code'] = 'type'): never => {
  throw new FormulaSyntaxError({ code, message, at })
}

function binaryType(op: BinOp, a: FormulaType, b: FormulaType, node: Node): FormulaType {
  switch (op) {
    case '&':
      // 两边任何类型都行：求值时按 TEXT() 的显示文字接上
      return 'text'
    case '+':
      if (a === 'number' && b === 'number') return 'number'
      if ((a === 'date' && b === 'number') || (a === 'number' && b === 'date')) return 'date'
      return fail('+ 两边要是数字（或日期加天数）', node.at)
    case '-':
      if (a === 'number' && b === 'number') return 'number'
      if (a === 'date' && b === 'number') return 'date'
      if (a === 'date' && b === 'date') return 'number'
      return fail('- 两边要是数字（或日期减天数、日期减日期）', node.at)
    case '*':
    case '/':
    case '^':
      if (a === 'number' && b === 'number') return 'number'
      return fail(`${op} 两边要是数字`, node.at)
    case '=':
    case '<>':
      if (a !== b) return fail(`比较的两边类型不同：「${TYPE_LABEL[a]}」和「${TYPE_LABEL[b]}」`, node.at)
      return 'boolean'
    default:
      if (a !== b) return fail(`比较的两边类型不同：「${TYPE_LABEL[a]}」和「${TYPE_LABEL[b]}」`, node.at)
      if (a === 'list') return fail('列表不能比大小', node.at)
      return 'boolean'
  }
}

/** 节点的静态类型，顺手记在节点上（求值要用） */
function typeOfNode(node: Node, typeOf: TypeOf): FormulaType {
  const type = nodeType(node, typeOf)
  node.ty = type
  return type
}

function nodeType(node: Node, typeOf: TypeOf): FormulaType {
  switch (node.k) {
    case 'num':
      return 'number'
    case 'str':
      return 'text'
    case 'bool':
      return 'boolean'
    case 'ref': {
      const type = typeOf(node.id, node.at)
      if (typeof type !== 'string') throw new FormulaSyntaxError(type)
      return type
    }
    case 'neg': {
      if (typeOfNode(node.x, typeOf) !== 'number') fail('负号后面要是数字', node.at)
      return 'number'
    }
    case 'bin':
      return binaryType(node.op, typeOfNode(node.a, typeOf), typeOfNode(node.b, typeOf), node)
    case 'call': {
      const sig = FUNCTIONS.get(node.fn)
      if (!sig) return fail(`没有函数 ${node.fn}`, node.at, 'unknown_function')
      const n = node.args.length
      if (n < sig.min || n > sig.max) {
        const want = sig.max === MANY ? `至少要 ${sig.min}` : sig.min === sig.max ? `要 ${sig.min}` : `要 ${sig.min}–${sig.max}`
        return fail(`${node.fn} ${want} 个参数，这里有 ${n} 个`, node.at, 'arity')
      }
      const types = node.args.map((arg) => typeOfNode(arg, typeOf))
      const out = sig.check(node.fn, types, node.args)
      if (typeof out === 'string') return out
      return fail(out.message, out.arg !== undefined ? node.args[out.arg]!.at : node.at)
    }
  }
}

/** 推断语法树的输出类型 */
export function inferType(ast: Node, typeOf: TypeOf): { ok: true; type: FormulaType } | { ok: false; error: FormulaError } {
  try {
    return { ok: true, type: typeOfNode(ast, typeOf) }
  } catch (err) {
    if (err instanceof FormulaSyntaxError) return { ok: false, error: err.error }
    throw err
  }
}
