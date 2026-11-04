import { describe, expect, test } from 'vitest'

/* 闸门：界面上不再出现浏览器 / 系统画的弹窗与控件，统一用 ui/ 里的组件。
 * 扫 web/src 的源码（不含测试与 vendor/），命中规则且不在白名单就失败。
 * 加规则 = 往 RULES 里追加一条；白名单每一项都要写理由，且必须真的命中（过期的白名单也算失败）。
 * 注释里提到这些写法不算：扫描前先把注释抹成空白（保留换行，行号不变）。 */

interface Allow {
  /** 相对 src/ 的路径；以 / 结尾表示整个目录（如 'ui/'：组件库自身的实现） */
  file: string
  reason: string
}

interface Rule {
  id: string
  /** 失败时提示用什么替代 */
  use: string
  re: RegExp
  /** 这一处命中其实不算（看得出是别的东西时）；code 是抹掉注释后的整个文件 */
  skip?: (m: RegExpMatchArray, code: string) => boolean
  allow: Allow[]
}

/** 全局对象上的调用：window / globalThis / self，含可选链 window?.xxx( */
const GLOBAL = /^(?:window|globalThis|self)\??\./

/** 全局对象.xxx( 或裸调用 xxx(；不算 obj.xxx( 方法调用和 function xxx( 定义。
 *  文件里自己声明了同名函数 / 变量时，裸调用是在调它（ConnectMachine 的配对确认就叫 confirm），不算 */
function nativeCall(name: string): Pick<Rule, 're' | 'skip'> {
  const local = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`)
  return {
    re: new RegExp(`(?:\\b(?:window|globalThis|self)\\??\\.|(?<![\\w$.]|function\\s+))${name}\\s*\\(`, 'g'),
    skip: (m, code) => !GLOBAL.test(m[0]) && local.test(code),
  }
}

/** 原生输入类型：JSX 的 type="x" / type={'x'}、DOM 的 el.type = 'x'、setAttribute('type', 'x')。
 *  CSS 选择器里的 [type="x"]（querySelector）不算 */
function inputType(type: string): RegExp {
  return new RegExp(`(?<!\\[)\\btype\\s*=\\s*\\{?\\s*["'\`]${type}["'\`]|setAttribute\\(\\s*["']type["']\\s*,\\s*["']${type}["']`, 'g')
}

/** 往回找最近的 `<标签名`，判断 title= 写在哪个元素上（找不到返回空串） */
function tagBefore(code: string, at: number): string {
  let i = code.lastIndexOf('<', at)
  while (i >= 0) {
    const m = /^<([A-Za-z][\w.]*)/.exec(code.slice(i, i + 64))
    if (m) return m[1]!
    i = i > 0 ? code.lastIndexOf('<', i - 1) : -1
  }
  return ''
}

const RULES: Rule[] = [
  { id: 'confirm', use: 'ui/dialog 的 confirmDialog', ...nativeCall('confirm'), allow: [] },
  { id: 'alert', use: 'ui/toast 的 toast / toastError', ...nativeCall('alert'), allow: [] },
  { id: 'prompt', use: 'ui/dialog 的 promptDialog', ...nativeCall('prompt'), allow: [] },
  { id: 'select', use: 'ui/Select', re: /<select\b|createElement\(\s*["']select["']/g, allow: [] },
  {
    id: 'checkbox',
    use: 'ui/Checkbox（纯 DOM 的是 / 否用 set-switch 开关）',
    re: inputType('checkbox'),
    allow: [{ file: 'ui/', reason: 'Checkbox 底层就是原生复选框（读屏、Space、点文字切换、shiftKey 都靠它）' }],
  },
  { id: 'number', use: 'ui/NumberInput（纯 DOM 用文本框 + ui/number.ts）', re: inputType('number'), allow: [] },
  { id: 'search', use: 'type="text" + 自己的清除按钮', re: inputType('search'), allow: [] },
  {
    id: 'date',
    use: 'ui/DateField / DatePanel（纯 DOM 用 ui/DateField 的 openDatePicker）',
    // 映射表里的字面量 'datetime-local'（{ 'date-time': 'datetime-local' } 再赋给 input.type）也算：这个串没有别的用处
    re: new RegExp(`${inputType('(?:date|datetime-local|time|month|week)').source}|["'\`]datetime-local["'\`]`, 'g'),
    allow: [],
  },
  {
    id: 'required',
    use: '表单 noValidate + 提交时自己校验，错误显示在表单的错误位置',
    // JSX 的 required / required={…} / required="…"，DOM 的 el.required = …、setAttribute / toggleAttribute('required', …)
    re: /(?<=\s)required(?=\s*=\s*[{"']|\s*\/?>|\s+[A-Za-z{])|\.required\s*=(?!=)|(?:set|toggle)Attribute\(\s*["']required["']/g,
    allow: [],
  },
  {
    id: 'title-jsx',
    use: 'data-tip（纯图标、没有 aria-label 的同时补 aria-label；组件透传的改叫 tip）',
    // 小写元素（落到 DOM 上的）的 title=，含 .ts 里拼的 HTML 串。大写组件的 title 是它自己的属性（Card 的标题），不算；
    // iframe 的 title 是框架的读屏名称（规范要求有），浏览器不拿它出悬停小窗
    re: /(?<=\s)title=(?=[{"'`])/g,
    skip: (m, code) => {
      const tag = tagBefore(code, m.index ?? 0)
      return !/^[a-z]/.test(tag) || tag === 'iframe'
    },
    allow: [],
  },
  {
    id: 'title-dom',
    use: 'el.dataset.tip = …（纯图标按钮同时 setAttribute(\'aria-label\', …)）',
    // el.title = / el['title'] = / setAttribute('title', …)；document.title 是标签页标题，dataset.title 是 data-title，都不出小窗
    re: /(?<!\b(?:document|dataset)\??)\.title\s*=(?!=)|\[\s*["']title["']\s*\]\s*=(?!=)|setAttribute\(\s*["']title["']/g,
    allow: [
      { file: 'collection/table/range-ops.ts', reason: 'input.title 是粘贴新建行的数据（NewRowInput）的标题字段，不是 DOM 属性' },
      {
        file: 'editor/media.ts',
        reason: '图片节点视图把 markdown 里写的图片标题（![alt](src "标题")，文档内容）渲染成 img 的 title，与 toDOM / 公开页同口径',
      },
    ],
  },
]

const raw = import.meta.glob<string>('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

/** 相对 src/ 的路径 → 源码（glob 把本目录的文件写成 './x'，别处写成 '../x'） */
const SOURCES = Object.entries(raw)
  .map(([path, text]) => [path.replace(/^\.\//, 'ui/').replace(/^\.\.\//, ''), text] as const)
  .filter(([path]) => !/\.test\.tsx?$/.test(path) && !path.startsWith('vendor/'))

/** 抹掉注释（换成等长空白，换行保留）。只认行首 / 空白 / 括号后面起头的注释：
 *  字符串里的 '**\/*.ts'、'http://' 前面不是这些字符，不会被误当成注释 */
function blankComments(src: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  return src
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, (m, pre: string) => pre + blank(m.slice(pre.length)))
    .replace(/(^|\s)\/\/.*$/gm, (m, pre: string) => pre + blank(m.slice(pre.length)))
}

function lineOf(src: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

const covers = (a: Allow, file: string): boolean => (a.file.endsWith('/') ? file.startsWith(a.file) : file === a.file)

describe('不用系统弹窗与原生控件', () => {
  test('扫到了源码', () => {
    const files = SOURCES.map(([p]) => p)
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('App.tsx')
    expect(files).toContain('ui/dialog.tsx')
  })

  test.each(RULES)('$id', (rule) => {
    const hits: string[] = []
    const used = new Set<Allow>()
    for (const [file, text] of SOURCES) {
      const code = blankComments(text)
      for (const m of code.matchAll(rule.re)) {
        if (rule.skip?.(m, code)) continue
        const ok = rule.allow.find((a) => covers(a, file))
        if (ok) used.add(ok)
        else hits.push(`${file}:${lineOf(code, m.index ?? 0)}  ${m[0].trim()}  → 改用 ${rule.use}`)
      }
    }
    expect(hits).toEqual([])
    expect(rule.allow.filter((a) => !used.has(a)).map((a) => `白名单已过期：${a.file}（${a.reason}）`)).toEqual([])
  })
})

describe('规则本身', () => {
  const hit = (id: string, src: string): boolean => {
    const rule = RULES.find((r) => r.id === id)!
    const code = blankComments(src)
    return [...code.matchAll(rule.re)].some((m) => !rule.skip?.(m, code))
  }

  test('认得出调用', () => {
    expect(hit('confirm', 'if (!window.confirm("x")) return')).toBe(true)
    expect(hit('confirm', 'if (confirm("x")) go()')).toBe(true)
    expect(hit('alert', '  window.alert (msg)')).toBe(true)
    expect(hit('prompt', 'const v = prompt("名称")')).toBe(true)
    expect(hit('confirm', 'globalThis.confirm(x)')).toBe(true)
    expect(hit('alert', 'self.alert(x)')).toBe(true)
    expect(hit('prompt', 'window?.prompt(x)')).toBe(true)
    expect(hit('confirm', 'const confirm = () => 1\nglobalThis.confirm(x)')).toBe(true)
  })

  test('认得出原生控件', () => {
    expect(hit('select', '<select value={x} onChange={f}>')).toBe(true)
    expect(hit('select', "document.createElement('select')")).toBe(true)
    expect(hit('checkbox', '<input type="checkbox" checked={on} />')).toBe(true)
    expect(hit('checkbox', "<input type={'checkbox'} />")).toBe(true)
    expect(hit('checkbox', "box.type = 'checkbox'")).toBe(true)
    expect(hit('checkbox', "el.setAttribute('type', 'checkbox')")).toBe(true)
    expect(hit('number', '<input\n  type="number"\n  min={1} />')).toBe(true)
    expect(hit('number', "input.type = 'number'")).toBe(true)
    expect(hit('search', '<input className="q" type="search" />')).toBe(true)
    expect(hit('required', '<input value={v} required />')).toBe(true)
    expect(hit('required', '<input value={v} required>')).toBe(true)
    expect(hit('required', '<input\n  required={!editing}\n/>')).toBe(true)
    expect(hit('required', '<input required className="x" />')).toBe(true)
    expect(hit('required', "input.required = true")).toBe(true)
    expect(hit('required', "el.setAttribute('required', '')")).toBe(true)
    expect(hit('required', "el.toggleAttribute('required', on)")).toBe(true)
    expect(hit('number', 'input.setAttribute("type", "number")')).toBe(true)
    expect(hit('checkbox', '<input type={"checkbox"} />')).toBe(true)
    expect(hit('date', '<input className="cl-input" type="date" value={v} />')).toBe(true)
    expect(hit('date', "<input type={'datetime-local'} />")).toBe(true)
    expect(hit('date', "input.type = 'time'")).toBe(true)
    expect(hit('date', 'el.setAttribute("type", "month")')).toBe(true)
    expect(hit('date', '<input type="week" />')).toBe(true)
    expect(hit('date', "const T = { date: 'date', 'date-time': 'datetime-local' }")).toBe(true)
  })

  test('不误伤同名的别的东西', () => {
    expect(hit('select', '<Select value={x} />')).toBe(false)
    expect(hit('select', 'const selected = select(x)')).toBe(false)
    expect(hit('checkbox', "if (prop.type === 'checkbox') return")).toBe(false)
    expect(hit('checkbox', "const p = { type: 'checkbox' }")).toBe(false)
    expect(hit('checkbox', 'el.querySelector(\'input[type="checkbox"]\')')).toBe(false)
    expect(hit('checkbox', '<button role="checkbox" />')).toBe(false)
    expect(hit('number', '<input type="text" inputMode="numeric" />')).toBe(false)
    expect(hit('date', "if (prop.type === 'date') return")).toBe(false)
    expect(hit('date', "const p = { type: 'date', name }")).toBe(false)
    expect(hit('date', "el.querySelector('input[type=\"date\"]')")).toBe(false)
    expect(hit('date', '<input type="datetime" />')).toBe(false)
    expect(hit('date', "case 'created_time':")).toBe(false)
    expect(hit('required', 'for (const key of form.required) {}')).toBe(false)
    expect(hit('required', "required: (f: string) => `「${f}」必填`")).toBe(false)
    expect(hit('required', 'setError(C.required(name))')).toBe(false)
    expect(hit('required', 'if (required === true) go()')).toBe(false)
    expect(hit('required', '<form noValidate>')).toBe(false)
  })

  test('认得出系统悬停小窗', () => {
    expect(hit('title-jsx', '<button className="x" title="关闭" onClick={f}>')).toBe(true)
    expect(hit('title-jsx', '<span\n  className="dot"\n  title={on ? a : b}\n/>')).toBe(true)
    expect(hit('title-jsx', '<a href={u} title={`${u}`}>')).toBe(true)
    expect(hit('title-jsx', '<motion.div title={x} />')).toBe(true)
    expect(hit('title-jsx', '`<button class="seg" title="${esc(t)}">${body}</button>`')).toBe(true)
    expect(hit('title-jsx', '<button onClick={() => go(a < b)} title="x">')).toBe(true)
    expect(hit('title-dom', "btn.title = '复制'")).toBe(true)
    expect(hit('title-dom', 'el.title = on ? a : b')).toBe(true)
    expect(hit('title-dom', "el['title'] = t")).toBe(true)
    expect(hit('title-dom', "el.setAttribute('title', tip)")).toBe(true)
    expect(hit('title-dom', 'box?.setAttribute("title", tip)')).toBe(true)
  })

  test('不误伤组件属性、页面标题、数据字段', () => {
    expect(hit('title-jsx', '<Card title="外观">')).toBe(false)
    expect(hit('title-jsx', '<Group title={C.today} items={a} />')).toBe(false)
    expect(hit('title-jsx', '<iframe title={C.frame} src={url} />')).toBe(false)
    expect(hit('title-jsx', '<button data-tip="关闭" aria-label="关闭">')).toBe(false)
    expect(hit('title-jsx', '<ConfirmButton tip="撤销后失效" confirmLabel="确认">')).toBe(false)
    expect(hit('title-jsx', 'interface P { title: string }')).toBe(false)
    expect(hit('title-jsx', "function f({ title = '' }: P) {}")).toBe(false)
    expect(hit('title-jsx', "const url = `/api/x?id=1&title=${q}`")).toBe(false)
    expect(hit('title-dom', 'document.title = `${name} | Ramet`')).toBe(false)
    expect(hit('title-dom', "el.dataset.title = 'x'")).toBe(false)
    expect(hit('title-dom', "el.dataset.tip = '复制'")).toBe(false)
    expect(hit('title-dom', 'if (row.title === name) return')).toBe(false)
    expect(hit('title-dom', 'if (a.title !== b.title) go()')).toBe(false)
    expect(hit('title-dom', 'const p = { title: x }')).toBe(false)
    expect(hit('title-dom', "el.getAttribute('title')")).toBe(false)
  })

  test('不误伤方法、定义、注释', () => {
    expect(hit('confirm', 'async function confirm() {}')).toBe(false)
    expect(hit('confirm', 'void confirmDialog({ message })')).toBe(false)
    expect(hit('confirm', 'store.confirm(x)')).toBe(false)
    expect(hit('alert', '// 原来是 window.alert(x)')).toBe(false)
    expect(hit('alert', 'f() /* window.alert(x) */')).toBe(false)
    expect(hit('prompt', "const u = 'http://x' // prompt(x)")).toBe(false)
    expect(hit('confirm', 'async function confirm() {}\nbutton.onclick = () => void confirm()')).toBe(false)
    expect(hit('confirm', 'function confirm() {}\nwindow.confirm(x)')).toBe(true)
  })
})
