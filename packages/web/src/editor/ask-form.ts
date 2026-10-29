// ---------- 提问表单（ACP elicitation，form 模式）：运行条的提问卡与底部兜底弹条共用 ----------
// 纯 DOM（弹条在 React 里挂一个 ref）。字段按服务端归一好的 AskForm 渲染（api.ts 同口径）：
//   choice   按钮式选项（单选 radio 语义 / 多选 checkbox 语义），选项说明在按钮下面
//   text     多行框自动长高（omp 的 editor 是整段预填文字）；有 format 用对应的单行 type；secret 用密码框
//   number   number 输入；boolean 开关
// 两条各家形状的规则，与服务端 agents/ask-form.ts 同口径：
//   补充文本  紧跟在选择题 K 后面、键名以 `K_` 开头的文本字段（claude _custom / codex _note / omp __other）挂在该题下面
//   快选      只有一个单选题或一个是 / 否题的表单（omp 的 select / confirm / 计划审批 / 工具审批、简单单选）点一下就提交
// 这里的校验只为体验，服务端才是准绳（不合返回 400，原因经 setError 显示）。
import { api, ApiError, type AskContent, type AskField, type AskForm, type AskValue } from '../api'
import { COPY } from '../copy'

type Choice = Extract<AskField, { kind: 'choice' }>
type Text = Extract<AskField, { kind: 'text' }>
type Num = Extract<AskField, { kind: 'number' }>

/** 快选最多摆这么多个按钮，再多就是正常表单 */
const QUICK_MAX = 8

/** 补充文本 → 它所属的选择题 */
export function companionOf(form: AskForm): Map<string, string> {
  const out = new Map<string, string>()
  form.fields.forEach((f, i) => {
    const prev = form.fields[i - 1]
    if (f.kind === 'text' && prev?.kind === 'choice' && f.key.startsWith(`${prev.key}_`)) out.set(f.key, prev.key)
  })
  return out
}

/** 快选：整张表单只有一个单选题（选项不多）或一个是 / 否题时，选项本身就是提交按钮 */
export function quickPick(form: AskForm): { key: string; picks: Array<{ value: AskValue; label: string }> } | null {
  const only = form.fields.length === 1 ? form.fields[0] : undefined
  if (only?.kind === 'boolean') {
    return { key: only.key, picks: [{ value: true, label: COPY.ask.form.yes }, { value: false, label: COPY.ask.form.no }] }
  }
  if (only?.kind === 'choice' && !only.multi && only.options.length <= QUICK_MAX) {
    return { key: only.key, picks: only.options.map((o) => ({ value: o.value, label: o.label })) }
  }
  return null
}

const fieldName = (f: AskField): string => f.title ?? f.description ?? f.key
const empty = (v: AskValue | undefined): boolean => v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** 提交前的体验校验：返回第一条问题的原因，没问题返回 null（口径同服务端 checkAskAnswer 的子集） */
export function firstProblem(form: AskForm, content: AskContent): string | null {
  for (const key of form.required) {
    const field = form.fields.find((f) => f.key === key)
    if (field && empty(content[key])) return COPY.ask.form.required(fieldName(field))
  }
  for (const f of form.fields) {
    const v = content[f.key]
    if (v === undefined || empty(v)) continue
    const name = `「${fieldName(f)}」`
    if (f.kind === 'choice' && Array.isArray(v)) {
      if (f.min !== undefined && v.length < f.min) return `${name}至少选 ${f.min} 项`
      if (f.max !== undefined && v.length > f.max) return `${name}最多选 ${f.max} 项`
    } else if (f.kind === 'text' && typeof v === 'string') {
      if (f.minLength !== undefined && v.length < f.minLength) return `${name}至少 ${f.minLength} 个字`
      if (f.maxLength !== undefined && v.length > f.maxLength) return `${name}最多 ${f.maxLength} 个字`
      if (f.pattern && !safeTest(f.pattern, v)) return `${name}格式不对`
    } else if (f.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name}应为数字`
      if (f.integer && !Number.isInteger(v)) return `${name}应为整数`
      if (f.min !== undefined && v < f.min) return `${name}不能小于 ${f.min}`
      if (f.max !== undefined && v > f.max) return `${name}不能大于 ${f.max}`
    }
  }
  return null
}

function safeTest(pattern: string, v: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(v)
  } catch {
    return true // agent 给了坏的正则：不拿它卡用户
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 一个字段的取值器：从 DOM 读当前答案（undefined = 没填） */
type Reader = () => AskValue | undefined

function choiceInput(f: Choice, onChange: () => void): { el: HTMLElement; read: Reader } {
  const box = el('div', 'ask-opts')
  box.setAttribute('role', f.multi ? 'group' : 'radiogroup')
  const picked = new Set<string>(f.default === undefined ? [] : Array.isArray(f.default) ? f.default : [f.default])
  const buttons: HTMLButtonElement[] = []
  const sync = (): void => {
    f.options.forEach((o, i) => buttons[i]!.setAttribute('aria-checked', String(picked.has(o.value))))
  }
  for (const o of f.options) {
    const btn = el('button', 'ask-opt')
    btn.type = 'button'
    btn.setAttribute('role', f.multi ? 'checkbox' : 'radio')
    btn.append(el('span', 'ask-opt-label', o.label))
    if (o.description) btn.append(el('span', 'ask-opt-desc', o.description))
    btn.addEventListener('click', () => {
      if (f.multi) {
        if (picked.has(o.value)) picked.delete(o.value)
        else picked.add(o.value)
      } else {
        // 再点一次已选的 = 取消选择（单选题也可以不答，改用补充文本）
        const was = picked.has(o.value)
        picked.clear()
        if (!was) picked.add(o.value)
      }
      sync()
      onChange()
    })
    buttons.push(btn)
    box.append(btn)
  }
  sync()
  return { el: box, read: () => (f.multi ? [...picked] : [...picked][0]) }
}

const FORMAT_TYPE: Record<NonNullable<Text['format']>, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' }

function textInput(f: Text, placeholder?: string): { el: HTMLElement; read: Reader } {
  if (f.format || f.secret) {
    const input = el('input', 'ask-input')
    input.type = f.secret ? 'password' : FORMAT_TYPE[f.format!]
    if (f.secret) input.autocomplete = 'off'
    if (f.default !== undefined && !f.secret) input.value = f.format === 'date-time' ? f.default.slice(0, 16) : f.default
    if (placeholder) input.placeholder = placeholder
    // datetime-local 没有时区：按本地时间换成带偏移的 ISO（JSON Schema 的 date-time）
    const read: Reader = () => (input.value === '' ? undefined : f.format === 'date-time' ? new Date(input.value).toISOString() : input.value)
    return { el: input, read }
  }
  const area = el('textarea', 'ask-input')
  area.rows = 1
  if (placeholder) area.placeholder = placeholder
  if (f.default !== undefined) area.value = f.default
  if (f.maxLength !== undefined) area.maxLength = f.maxLength
  const grow = (): void => {
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight}px`
  }
  area.addEventListener('input', grow)
  // 挂进文档后才量得出高度（预填的多行文字一出来就是全高）
  requestAnimationFrame(grow)
  return { el: area, read: () => (area.value === '' ? undefined : area.value) }
}

function numberInput(f: Num): { el: HTMLElement; read: Reader } {
  const input = el('input', 'ask-input is-num')
  input.type = 'number'
  if (f.min !== undefined) input.min = String(f.min)
  if (f.max !== undefined) input.max = String(f.max)
  input.step = f.integer ? '1' : 'any'
  if (f.default !== undefined) input.value = String(f.default)
  // 填了但不是数字会得到 NaN，交给校验报「应为数字」
  return { el: input, read: () => (input.value === '' ? undefined : input.valueAsNumber) }
}

function booleanInput(f: Extract<AskField, { kind: 'boolean' }>): { el: HTMLElement; read: Reader } {
  const label = el('label', 'ask-switch')
  const box = el('input', '')
  box.type = 'checkbox'
  box.checked = f.default === true
  label.append(box, el('span', '', COPY.ask.form.yes))
  return { el: label, read: () => box.checked }
}

export type AskFormHandlers = {
  /** 提交答案（accept + content） */
  submit(content: AskContent): void
  /** 跳过（decline） */
  skip(): void
}

export type AskFormMount = {
  el: HTMLElement
  /** 已提交、等服务端回话：按钮与输入都禁用（失败了调用方再放开） */
  setBusy(busy: boolean): void
  /** 原因显示在卡片里（null = 清掉） */
  setError(message: string | null): void
}

/** 建表单。title（message 的第一行）由调用方画在卡片头上；message 其余的行在这里画 */
export function buildAskForm(form: AskForm, handlers: AskFormHandlers): AskFormMount {
  const root = el('div', 'ask-form')
  const rest = form.message.split('\n').slice(1).join('\n').trim()
  if (rest) root.append(el('div', 'ask-msg', rest))

  const err = el('div', 'ask-err')
  err.hidden = true
  const setError = (message: string | null): void => {
    err.hidden = !message
    err.textContent = message ?? ''
  }
  root.append(err)
  const readers = new Map<string, Reader>()
  const companions = companionOf(form)
  const quick = quickPick(form)
  const acts = el('div', 'ask-acts')

  if (!quick) {
    for (const f of form.fields) {
      if (companions.has(f.key)) continue
      const field = el('div', 'ask-field')
      const name = f.title ?? f.description
      if (name) field.append(el('div', 'ask-label', name))
      if (f.title && f.description) field.append(el('div', 'ask-hint', f.description))
      const input =
        f.kind === 'choice' ? choiceInput(f, () => setError(null))
        : f.kind === 'text' ? textInput(f)
        : f.kind === 'number' ? numberInput(f)
        : booleanInput(f)
      field.append(input.el)
      readers.set(f.key, input.read)
      // 这道题的补充文本：紧跟在下面，不显示它自己的（英文）标题和说明
      const other = form.fields.find((c) => companions.get(c.key) === f.key)
      if (other?.kind === 'text') {
        const extra = textInput(other, COPY.ask.form.other)
        extra.el.classList.add('is-other')
        field.append(extra.el)
        readers.set(other.key, extra.read)
      }
      root.insertBefore(field, err)
    }
  }

  const collect = (): AskContent => {
    const content: AskContent = {}
    for (const [key, read] of readers) {
      const v = read()
      if (v !== undefined && !empty(v)) content[key] = v
    }
    return content
  }
  const submit = (): void => {
    const content = collect()
    const problem = firstProblem(form, content)
    if (problem) return setError(problem)
    setError(null)
    handlers.submit(content)
  }

  if (quick) {
    // 题目本身可能在字段上（codex 的 message 是通用的一句，真正的问题在字段标题里）
    const only = form.fields[0]!
    const name = only.title ?? only.description
    if (name) root.insertBefore(el('div', 'ask-label', name), err)
    quick.picks.forEach((p, i) => {
      const btn = el('button', i === 0 ? 'ask-btn is-primary' : 'ask-btn', p.label)
      btn.type = 'button'
      btn.addEventListener('click', () => handlers.submit({ [quick.key]: p.value }))
      acts.append(btn)
    })
  } else {
    const ok = el('button', 'ask-btn is-primary', COPY.ask.form.submit)
    ok.type = 'button'
    ok.addEventListener('click', submit)
    acts.append(ok)
  }
  const skip = el('button', 'ask-btn', COPY.ask.form.skip)
  skip.type = 'button'
  skip.addEventListener('click', () => handlers.skip())
  acts.append(skip)
  root.append(acts)

  // Ctrl / ⌘ + Enter 提交（多行框里的 Enter 是换行）
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !quick) {
      e.preventDefault()
      submit()
    }
  })

  return {
    el: root,
    setBusy(busy) {
      for (const node of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')) {
        node.disabled = busy
      }
    },
    setError,
  }
}

/** 建表单并接上应答接口：提交 / 跳过走 POST /permission。400 是答案不合表单（原因显示在卡片里，可以改了再交）；
 *  404 是已经结束（permission_resolved 会摘掉卡片）；其余失败交给 onFail（403 / 409 要给用户理由）。
 *  卡片的摘除只认 permission_resolved，这里不摘 */
export function mountAsk(
  pageId: string,
  req: { agentId: string; requestId: string; form: AskForm },
  onFail: (message: string) => void,
): AskFormMount {
  const send = (optionId: 'accept' | 'decline', content?: AskContent): void => {
    mount.setBusy(true)
    mount.setError(null)
    void api.respondPermission(pageId, req.agentId, req.requestId, optionId, content).catch((err: unknown) => {
      mount.setBusy(false)
      if (err instanceof ApiError && err.status === 404) return
      if (err instanceof ApiError && err.status === 400) return mount.setError(err.message)
      onFail(err instanceof Error ? err.message : COPY.ask.failed)
    })
  }
  const mount = buildAskForm(req.form, { submit: (content) => send('accept', content), skip: () => send('decline') })
  return mount
}
