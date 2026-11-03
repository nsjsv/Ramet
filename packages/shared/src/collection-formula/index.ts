// ---------- 集合的公式：编译（解析 + 引用 + 循环检测 + 类型推断）与编辑器用的转换 / 补全 ----------
// 公式属性的 cfg.expr 是存储形：属性引用写成 [@<属性 id>]（「名称」是 [@title]），属性改名、挪位置都不影响；
// 编辑器里显示与输入的是显示形 [名字]，toDisplay / toStored 按当前定义来回换。
// 编译只看集合定义：一份定义里的全部公式一起编译（按依赖排好顺序、环上的全部报循环引用），结果按定义对象缓存。
// 求值在 fill.ts（要读行的值，依赖 collection-model 的 rowValue），由 collection-query 在窗口查询与套增量时调用。
// 这里运行时只依赖 collection-values / collection-rollup，collection-model 才能放心 import 这里（解析定义时就要知道公式的输出类型）。
//
// 恶意文档：单个表达式 ≤ FORMULA_MAX 字、嵌套 ≤ 50 层；一个集合最多 FORMULAS_MAX 个公式、加起来 ≤ FORMULA_TOTAL_MAX 字，
// 超出的公式报错不算 —— 每行都要把每个公式算一遍，不设总量窗口查询会被拖住。循环引用在编译时就挡掉，求值不会兜圈子。

import { rollupOutput } from '../collection-rollup.js'
import { TITLE_NAME, TITLE_PROP_ID } from '../collection-values.js'
import type { CollectionProp, CollectionRefs, CollectionSchema, PropType } from '../collection-model.js'
import { FORMULA_MAX, lex, refText, type FormulaError, type Span } from './lexer.js'
import { parse, type Node, type RefResolver } from './parser.js'
import { FUNCTION_DOCS, inferType, type FormulaType, type TypeOf } from './types.js'

export { FORMULA_MAX, type FormulaError, type FormulaErrorCode, type Span } from './lexer.js'
export { DEPTH_MAX, type Node } from './parser.js'
export { numText as formulaNumberText } from './functions.js'
export { FORMULA_TYPES, FUNCTION_DOCS, TYPE_LABEL as FORMULA_TYPE_LABEL, type FormulaType, type FunctionDoc, type FunctionGroup } from './types.js'

/** 一个集合最多几个公式、表达式加起来最多多少字。服务端每次窗口查询给每一行算全部公式，单线程算的时候别的请求都在等：
 *  总长决定了最坏的耗时，压到 5,000 行时与最重的筛选排序同一个量级（不到一秒）；正常用法远到不了这个量 */
export const FORMULAS_MAX = 100
export const FORMULA_TOTAL_MAX = 6_000
/** 引用的属性已不在定义里时，显示形里写的名字 */
export const DELETED_PROP_NAME = '已删除的属性'

/** 一个公式的编译结果。deps = 直接引用的属性 id（出错时也尽量给：前端据此判断依赖哪些关联） */
export type Compiled =
  | { ok: true; ast: Node; type: FormulaType; deps: string[] }
  | { ok: false; error: FormulaError; deps: string[] }

type PropLike = Pick<CollectionProp, 'id' | 'name' | 'type' | 'cfg'>

const PERSON_TYPES: ReadonlySet<PropType> = new Set(['person', 'created_by', 'edited_by'])

/** 非公式属性在公式里的静态类型（公式属性要编译才知道 = null） */
export function propFormulaType(prop: Pick<CollectionProp, 'id' | 'type' | 'cfg'>): FormulaType | null {
  if (prop.id === TITLE_PROP_ID) return 'text'
  switch (prop.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'select':
    case 'status':
      return 'text'
    case 'number':
      return 'number'
    // 有前缀的编号看到的、拼接时想要的都是「TASK-12」：按文字给；没有前缀的就是个数，能比大小、能算
    case 'unique_id':
      return prop.cfg.prefix ? 'text' : 'number'
    case 'checkbox':
      return 'boolean'
    case 'date':
    case 'created_time':
    case 'edited_time':
      return 'date'
    case 'multi_select':
    case 'person':
    case 'created_by':
    case 'edited_by':
    case 'files':
    case 'relation':
      return 'list'
    case 'rollup':
      return rollupOutput(prop.cfg.fn)
    case 'formula':
      return null
  }
}

const unique = (ids: string[]): string[] => [...new Set(ids)]

type Parsed = { ok: true; ast: Node; refs: { id: string; at: Span }[] } | { ok: false; error: FormulaError }

/** 存储形的引用：[@id] 指向现有属性（或 title）；id 不在了 = 已删除；写成名字的（不该出现在存储形里）= 找不到 */
function storedResolver(byId: ReadonlyMap<string, PropLike>): RefResolver {
  return (token) => {
    if (!token.id) return { code: 'unknown_prop', message: `找不到属性「${token.name}」`, at: token.at }
    if (token.name === TITLE_PROP_ID || byId.has(token.name)) return token.name
    return { code: 'deleted_prop', message: '引用的属性已删除', at: token.at }
  }
}

/** 显示形的引用：按名字找（「名称」是标题）；没有 / 重名报错。开头没转义的 @ 仍按存储形认 */
function displayResolver(props: readonly PropLike[]): RefResolver {
  const byId = new Map(props.map((prop) => [prop.id, prop]))
  return (token) => {
    if (token.id) return storedResolver(byId)(token)
    const hits = props.filter((prop) => prop.name === token.name).map((prop) => prop.id)
    if (token.name === TITLE_NAME) hits.push(TITLE_PROP_ID)
    if (hits.length === 0) return { code: 'unknown_prop', message: `没有叫「${token.name}」的属性`, at: token.at }
    if (hits.length > 1) return { code: 'dup_name', message: `有两个属性都叫「${token.name}」，先改名`, at: token.at }
    return hits[0]!
  }
}

function parseText(text: string, resolve: RefResolver): Parsed {
  if (text.length > FORMULA_MAX) return { ok: false, error: { code: 'too_long', message: `公式太长（最多 ${FORMULA_MAX} 字）` } }
  const lexed = lex(text)
  if (!lexed.ok) return { ok: false, error: lexed.error }
  return parse(lexed.tokens, resolve)
}

/** 强连通分量（Tarjan，迭代写法：公式数量来自文档，递归写法一条几千个公式的依赖链就能压爆调用栈）。
 *  按「被依赖的先出」的顺序给出，正好是求值顺序 */
function components(nodes: string[], edges: ReadonlyMap<string, string[]>): string[][] {
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  const open = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
  }
  for (const root of nodes) {
    if (index.has(root)) continue
    open(root)
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const next = edges.get(frame.v) ?? []
      if (frame.i < next.length) {
        const w = next[frame.i++]!
        if (!index.has(w)) {
          open(w)
          work.push({ v: w, i: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!))
      if (low.get(frame.v) !== index.get(frame.v)) continue
      const component: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        component.push(w)
        if (w === frame.v) break
      }
      out.push(component)
    }
  }
  return out
}

/** 引用的静态类型：普通属性按类型表，公式按（已编好的）编译结果，引用了有误的公式本身也算有误 */
function refTypes(byId: ReadonlyMap<string, PropLike>, compiled: ReadonlyMap<string, Compiled>): TypeOf {
  return (id, at) => {
    const prop = byId.get(id)
    if (id === TITLE_PROP_ID || !prop) return 'text'
    if (prop.type !== 'formula') return propFormulaType(prop) ?? 'text'
    const dep = compiled.get(id)
    return dep?.ok ? dep.type : { code: 'bad_ref', message: `引用的公式「${prop.name}」有误`, at }
  }
}

/** 一组属性里的全部公式一起编译。Map 的顺序就是求值顺序（被引用的公式在前）；失败的也在里面 */
export function compileProps(props: readonly PropLike[]): Map<string, Compiled> {
  const byId = new Map(props.map((prop) => [prop.id, prop]))
  const formulas = props.filter((prop) => prop.type === 'formula')
  const parsed = new Map<string, Parsed>()
  let budget = FORMULA_TOTAL_MAX
  formulas.forEach((prop, i) => {
    const expr = prop.cfg.expr ?? ''
    if (i >= FORMULAS_MAX) {
      parsed.set(prop.id, { ok: false, error: { code: 'too_long', message: `一个集合最多 ${FORMULAS_MAX} 个公式` } })
    } else if (expr.length <= FORMULA_MAX && expr.length > budget) {
      parsed.set(prop.id, { ok: false, error: { code: 'too_long', message: `这个集合的公式加起来太长了（最多 ${FORMULA_TOTAL_MAX} 字）` } })
    } else {
      const result = parseText(expr, storedResolver(byId))
      if (result.ok) budget -= expr.length
      parsed.set(prop.id, result)
    }
  })

  const depsOf = (id: string): string[] => {
    const p = parsed.get(id)
    return p?.ok ? unique(p.refs.map((ref) => ref.id)) : []
  }
  const edges = new Map(formulas.map((prop) => [prop.id, depsOf(prop.id).filter((dep) => byId.get(dep)?.type === 'formula')]))
  const out = new Map<string, Compiled>()
  const typeOf = refTypes(byId, out)

  for (const component of components(
    formulas.map((prop) => prop.id),
    edges,
  )) {
    const members = new Set(component)
    const cyclic = component.length > 1 || edges.get(component[0]!)!.includes(component[0]!)
    for (const id of component) {
      const p = parsed.get(id)!
      const deps = depsOf(id)
      if (!p.ok) {
        out.set(id, { ok: false, error: p.error, deps })
        continue
      }
      if (cyclic) {
        const at = p.refs.find((ref) => members.has(ref.id))?.at
        const names = component.map((m) => `「${byId.get(m)!.name}」`)
        const message = component.length === 1 ? '公式引用了自己（循环引用）' : `循环引用：${names.join('、')}互相引用`
        out.set(id, { ok: false, error: { code: 'cycle', message, ...(at ? { at } : {}) }, deps })
        continue
      }
      const inferred = inferType(p.ast, typeOf)
      out.set(id, inferred.ok ? { ok: true, ast: p.ast, type: inferred.type, deps } : { ok: false, error: inferred.error, deps })
    }
  }
  return out
}

const cache = new WeakMap<CollectionSchema, Map<string, Compiled>>()

/** 集合里全部公式的编译结果（按定义对象缓存：parseCollection 解析时已经编译过一次并记在这里） */
export function compileFormulas(schema: CollectionSchema): Map<string, Compiled> {
  let hit = cache.get(schema)
  if (!hit) {
    hit = compileProps(schema.props)
    cache.set(schema, hit)
  }
  return hit
}

/** parseCollection 用：解析时编译出的结果记到最终的定义对象上，之后 compileFormulas 直接取 */
export function rememberFormulas(schema: CollectionSchema, compiled: Map<string, Compiled>): void {
  cache.set(schema, compiled)
}

/** 给公式属性填上输出类型与出错原因（就地改；parseCollection 与 withFormula 用，prop 都是刚建出来的对象）。
 *  原因记在属性上：格子与表头只拿到属性，要据此显示「公式有误」的悬停说明、区分「还没写」（empty，整列留空） */
export function annotateFormulas(props: CollectionProp[]): Map<string, Compiled> {
  const compiled = compileProps(props)
  for (const prop of props) {
    if (prop.type !== 'formula') continue
    const c = compiled.get(prop.id)
    prop.output = c?.ok ? c.type : null
    if (c && !c.ok) prop.formulaError = c.error
    else delete prop.formulaError
  }
  return compiled
}

/** 把某个属性换成给定表达式的公式之后的定义（编辑器预览与校验用；不改入参）。propId 不在定义里 = 原样返回 */
export function withFormula(schema: CollectionSchema, propId: string, expr: string): CollectionSchema {
  if (!schema.props.some((prop) => prop.id === propId)) return schema
  const props = schema.props.map((prop): CollectionProp => {
    if (prop.id === propId) return { ...prop, type: 'formula', options: [], cfg: { expr } }
    return prop.type === 'formula' ? { ...prop } : prop
  })
  const next: CollectionSchema = { ...schema, props }
  rememberFormulas(next, annotateFormulas(props))
  return next
}

// ---------- 存储形 ↔ 显示形 ----------

type Replacement = { stored: Span; display: Span }

function storedOf(display: string, props: readonly PropLike[]): { ok: true; expr: string; map: Replacement[] } | { ok: false; error: FormulaError } {
  const lexed = lex(display)
  if (!lexed.ok) return { ok: false, error: lexed.error }
  const resolve = displayResolver(props)
  let out = ''
  let last = 0
  const map: Replacement[] = []
  for (const token of lexed.tokens) {
    if (token.t !== 'ref') continue
    const id = token.id ? token.name : resolve(token)
    if (typeof id !== 'string') return { ok: false, error: id }
    out += display.slice(last, token.at[0])
    const ref = `[@${id}]`
    map.push({ stored: [out.length, out.length + ref.length], display: token.at })
    out += ref
    last = token.at[1]
  }
  out += display.slice(last)
  if (out.length > FORMULA_MAX) return { ok: false, error: { code: 'too_long', message: `公式太长（最多 ${FORMULA_MAX} 字）` } }
  return { ok: true, expr: out, map }
}

/** 编辑器里的显示形 → 存进 cfg.expr 的存储形：[名字] 换成 [@id]，其余原样（空白、写法都保留）。
 *  名字认不出、两个属性同名、词法错误、换完超长都报错（位置是显示形里的） */
export function toStored(display: string, schema: CollectionSchema): { ok: true; expr: string } | { ok: false; error: FormulaError } {
  const result = storedOf(display, schema.props)
  return result.ok ? { ok: true, expr: result.expr } : result
}

/** 存储形 → 显示形：[@id] 换成当前的名字；属性已删写成 [已删除的属性]（编译时报「引用的属性已删除」）。
 *  表达式写坏了的部分原样留着（编辑器里照样能改） */
export function toDisplay(stored: string, schema: CollectionSchema): string {
  const byId = new Map(schema.props.map((prop) => [prop.id, prop]))
  let out = ''
  let last = 0
  for (const token of lex(stored).tokens) {
    if (token.t !== 'ref' || !token.id) continue
    const name = token.name === TITLE_PROP_ID ? TITLE_NAME : (byId.get(token.name)?.name ?? DELETED_PROP_NAME)
    out += stored.slice(last, token.at[0]) + (name === '' ? `[@${token.name}]` : refText(name))
    last = token.at[1]
  }
  return out + stored.slice(last)
}

/** 存储形里的位置 → 显示形里的位置（落在引用里的给整个引用） */
function mapSpan(at: Span, map: readonly Replacement[]): Span {
  const point = (p: number, end: boolean): number => {
    let delta = 0
    for (const r of map) {
      if (p < r.stored[0] || (end && p === r.stored[0])) break
      if (p < r.stored[1] || (end && p === r.stored[1])) return end ? r.display[1] : r.display[0]
      delta = r.display[1] - r.stored[1]
    }
    return p + delta
  }
  return [point(at[0], false), point(at[1], true)]
}

export type FormulaCheck = { ok: true; expr: string; type: FormulaType } | { ok: false; error: FormulaError }

/** 编辑器的实时校验：把 propId 换成这段显示形之后整份定义一起编译（循环引用、引用了有误的公式都算进来）。
 *  通过时给出存储形与输出类型；出错时位置是显示形里的 */
export function checkFormula(display: string, schema: CollectionSchema, propId: string): FormulaCheck {
  if (display.length > FORMULA_MAX) return { ok: false, error: { code: 'too_long', message: `公式太长（最多 ${FORMULA_MAX} 字）` } }
  // 先按显示形解析：语法错误、名字认不出的位置直接对得上
  const direct = parseText(display, displayResolver(schema.props))
  if (!direct.ok) return direct
  const stored = storedOf(display, schema.props)
  if (!stored.ok) return stored
  const next = withFormula(schema, propId, stored.expr)
  const compiled = compileFormulas(next).get(propId)
  if (!compiled) {
    // 定义里还没有这个属性：没有谁能引用它，不会成环，按现有定义推断即可
    const inferred = inferType(direct.ast, refTypes(new Map(schema.props.map((prop) => [prop.id, prop])), compileFormulas(schema)))
    return inferred.ok ? { ok: true, expr: stored.expr, type: inferred.type } : inferred
  }
  if (compiled.ok) return { ok: true, expr: stored.expr, type: compiled.type }
  const { at, ...rest } = compiled.error
  return { ok: false, error: at ? { ...rest, at: mapSpan(at, stored.map) } : rest }
}

/** 公式的定义签名（前端的查询签名用）：公式本身与它们引用的属性的类型 / 选项 / 配置（不含名字）。
 *  这些一变，已算好的公式值就旧了（改了表达式、引用的单选改了选项名……）。没有公式 = '' */
export function formulaSig(schema: CollectionSchema): string {
  const formulas = schema.props.filter((prop) => prop.type === 'formula')
  if (formulas.length === 0) return ''
  const used = new Set<string>()
  for (const c of compileFormulas(schema).values()) for (const dep of c.deps) used.add(dep)
  const refs = schema.props.filter((prop) => prop.type !== 'formula' && used.has(prop.id)).map((prop) => [prop.id, prop.type, prop.options, prop.cfg])
  return JSON.stringify([formulas.map((prop) => [prop.id, prop.cfg.expr ?? '']), refs])
}

/** 公式要不要用户名：引用了人员类属性，或引用的汇总在逐个显示人员（服务端据此才查成员名单） */
export function formulaNeedsNames(schema: CollectionSchema, refs: CollectionRefs = {}): boolean {
  const byId = new Map(schema.props.map((prop) => [prop.id, prop]))
  for (const c of compileFormulas(schema).values()) {
    if (!c.ok) continue
    for (const dep of c.deps) {
      const prop = byId.get(dep)
      if (!prop) continue
      if (PERSON_TYPES.has(prop.type)) return true
      const target = prop.type === 'rollup' && Object.hasOwn(refs, dep) ? refs[dep]?.prop?.type : undefined
      if (target && PERSON_TYPES.has(target)) return true
    }
  }
  return false
}

// ---------- 读 computed ----------

const isItem = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/** 日期结果的合法写法：'YYYY-MM-DD'、'开始/结束'、或时间戳（ISO 8601） */
const DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(?:\/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/

/** row.computed 里公式的那一项按编译出的输出类型规整：形状对不上 / 公式有误 = undefined（同 readValue 的口径） */
export function readFormula(output: FormulaType | null | undefined, raw: unknown): string | number | boolean | (string | number | boolean)[] | undefined {
  switch (output) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    case 'text':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined
    case 'date':
      return typeof raw === 'string' && DATE_VALUE_RE.test(raw) ? raw : undefined
    case 'list': {
      if (!Array.isArray(raw)) return undefined
      const items = raw.filter(isItem)
      return items.length ? items : undefined
    }
    default:
      return undefined
  }
}

// ---------- 补全 ----------

export type Suggestion = {
  kind: 'prop' | 'function'
  /** 列表里显示的字：属性名 / 函数名 */
  label: string
  /** 属性的类型 / 函数的签名 */
  detail: string
  /** 选中后用它替换 [from, to) */
  insert: string
  from: number
  to: number
}

const SUGGESTIONS_MAX = 50

/** 光标在不在一个没写完的属性引用 / 文本里：从头扫到光标（转义照认） */
function scanTo(text: string, caret: number): { ref: number; inString: boolean } {
  let ref = -1
  let close: string | null = null
  for (let i = 0; i < caret; i++) {
    const c = text[i]!
    if (close !== null) {
      if (c === '\\' && (text[i + 1] === close || text[i + 1] === '\\')) i++
      else if (c === close) close = null
    } else if (ref >= 0) {
      if (c === '\\') i++
      else if (c === ']') ref = -1
    } else if (c === '"') {
      close = '"'
    } else if (c === '“') {
      close = '”'
    } else if (c === '[') {
      ref = i
    }
  }
  return { ref, inString: close !== null }
}

/** 编辑器补全：光标在 [ 之后列属性名（名字含输入的字，开头吻合的在前），在字母后列函数名；在文本里不补。
 *  self = 正在编辑的公式属性（不列自己） */
export function complete(display: string, caret: number, schema: CollectionSchema, self?: string): Suggestion[] {
  const at = Math.max(0, Math.min(caret, display.length))
  const { ref, inString } = scanTo(display, at)
  if (inString) return []
  if (ref >= 0) {
    const typed = display.slice(ref + 1, at).replace(/\\(.)/g, '$1').toLowerCase()
    let to = at
    for (let i = at; i < display.length; i++) {
      if (display[i] === '\\') i++
      else if (display[i] === ']') {
        to = i + 1
        break
      } else if (display[i] === '[' || display[i] === '\n') break
    }
    const candidates: PropLike[] = [{ id: TITLE_PROP_ID, name: TITLE_NAME, type: 'text', cfg: {} }, ...schema.props.filter((prop) => prop.id !== self)]
    return candidates
      .filter((prop) => prop.name.toLowerCase().includes(typed))
      .map((prop, i) => ({ prop, i, head: prop.name.toLowerCase().startsWith(typed) ? 0 : 1 }))
      .sort((a, b) => a.head - b.head || a.i - b.i)
      .slice(0, SUGGESTIONS_MAX)
      .map(({ prop }) => ({
        kind: 'prop' as const,
        label: prop.name,
        detail: prop.type,
        insert: prop.name === '' ? `[@${prop.id}]` : refText(prop.name),
        from: ref,
        to,
      }))
  }
  const word = /(^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)$/.exec(display.slice(0, at))?.[2]
  if (!word) return []
  const tail = /^[A-Za-z0-9_]*/.exec(display.slice(at))?.[0] ?? ''
  const prefix = word.toUpperCase()
  return FUNCTION_DOCS.filter((doc) => doc.name.startsWith(prefix))
    .slice(0, SUGGESTIONS_MAX)
    .map((doc) => ({ kind: 'function' as const, label: doc.name, detail: doc.signature, insert: `${doc.name}(`, from: at - word.length, to: at + tail.length }))
}
