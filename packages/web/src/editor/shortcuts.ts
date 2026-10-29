// ---------- 快捷键：绑定与说明表同源 ----------
// SHORTCUT_GROUPS 是设置「快捷键」页的唯一数据源；本模块自己绑定的键（OWN）在表里引用同一个常量，
// milkdown 预设 / 其它模块绑定的键（加粗、撤销、查找……）在表里按原样写出，改那些模块的键位要同改这里。
// 块类型快捷键（Mod-Alt-0…9、引用、代码块）统一走 block-turn.ts 的 turnInto：列表项、多块选区与块菜单「转换」同一语义
// （milkdown 预设的同名键只认文本块，列表项上按会套出嵌套列表）。

import { toggleMark } from '@milkdown/kit/prose/commands'
import { keymap } from '@milkdown/kit/prose/keymap'
import type { Attrs } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { activeRange } from './block-ops'
import { selectionTurnRange, turnInto, type TurnAction } from './block-turn'
import { openLinkEditor } from './selection-menu'
import { DEFAULT_HIGHLIGHT } from '@ramet/shared/md-dialect'
import { MAX_HEADING_LEVEL } from './heading-level'
import { PROJECT_KEYS } from '../project/project-keys'

/** 本模块绑定的键（表里引用同一份） */
const OWN = {
  link: 'Mod-k',
  strike: 'Mod-Shift-x',
  highlight: 'Mod-Shift-h',
  paragraph: 'Mod-Alt-0',
  heading: (level: number) => `Mod-Alt-${level}`,
  ordered: 'Mod-Alt-7',
  bullet: 'Mod-Alt-8',
  todo: 'Mod-Alt-9',
  quote: 'Mod-Shift-b',
  code: 'Mod-Alt-c',
  /** 随手 AI：绑定在 quick-ai.ts（这里只登记说明） */
  quick: 'Mod-j',
} as const

type Command = (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => boolean

/** 块类型快捷键：作用于块选区，没有块选时作用于文字选区盖住的块（光标所在块） */
function turn(action: TurnAction): Command {
  return (state, dispatch, view) => {
    if (!view || !view.editable) return false
    const sel = activeRange(state)
    const range = sel ?? selectionTurnRange(state)
    if (!range) return false
    if (dispatch) turnInto(view, range.from, range.to, action)
    return true
  }
}

const text = (typeName: string, attrs: Attrs = {}): TurnAction => ({ kind: 'text', typeName, attrs })

function mark(name: string): Command {
  return (state, dispatch, view) => {
    const type = state.schema.marks[name]
    return type ? toggleMark(type)(state, dispatch, view) : false
  }
}

const bindings: Record<string, Command> = {
  // 只在选中了文字时是插链接；没选中的 ⌘K 留给命令面板（palette/CommandPalette.tsx 在 window 上接，看到 defaultPrevented 就让路）
  [OWN.link]: (state, _dispatch, view) => (view && !state.selection.empty ? openLinkEditor(view) : false),
  [OWN.strike]: mark('strike_through'),
  [OWN.highlight]: (state, dispatch) => {
    const type = state.schema.marks.highlight
    return type ? toggleMark(type, { color: DEFAULT_HIGHLIGHT })(state, dispatch) : false
  },
  [OWN.paragraph]: turn(text('paragraph')),
  [OWN.ordered]: turn({ kind: 'wrap', wrap: 'ordered_list' }),
  [OWN.bullet]: turn({ kind: 'wrap', wrap: 'bullet_list' }),
  [OWN.todo]: turn({ kind: 'wrap', wrap: 'todo' }),
  [OWN.quote]: turn({ kind: 'wrap', wrap: 'blockquote' }),
  [OWN.code]: turn(text('code_block')),
}
for (let level = 1; level <= MAX_HEADING_LEVEL; level++) bindings[OWN.heading(level)] = turn(text('heading', { level }))

export const shortcutKeys = $prose(() => keymap(bindings))

export type ShortcutRow = { label: string; keys: string[] }

export const SHORTCUT_GROUPS: Array<{ title: string; rows: ShortcutRow[] }> = [
  {
    title: '全局',
    rows: [{ label: '命令面板：跳到页面、正在跑的 agent、常用命令（编辑器里选中文字时是插链接）', keys: ['Mod-k'] }],
  },
  {
    title: '文字格式',
    rows: [
      { label: '加粗', keys: ['Mod-b'] },
      { label: '斜体', keys: ['Mod-i'] },
      { label: '下划线', keys: ['Mod-u'] },
      { label: '删除线', keys: [OWN.strike] },
      { label: '黄色高亮（选区菜单「颜色」里有更多）', keys: [OWN.highlight] },
      { label: '行内代码', keys: ['Mod-e'] },
      { label: '链接（先选中文字；没选中时是命令面板）', keys: [OWN.link] },
      { label: '换行（不分段）', keys: ['Shift-Enter'] },
    ],
  },
  {
    title: '块类型',
    rows: [
      { label: '正文', keys: [OWN.paragraph] },
      { label: `标题 1 – ${MAX_HEADING_LEVEL}`, keys: [`${OWN.heading(1)} … ${MAX_HEADING_LEVEL}`] },
      { label: '有序列表', keys: [OWN.ordered] },
      { label: '无序列表', keys: [OWN.bullet] },
      { label: '待办', keys: [OWN.todo] },
      { label: '引用', keys: [OWN.quote] },
      { label: '代码块', keys: [OWN.code] },
      { label: '列表缩进 / 反缩进（代码块里缩进行）', keys: ['Tab', 'Shift-Tab'] },
      { label: '块首去掉样式（列表 / 标题 / 引用变回正文）', keys: ['Backspace'] },
    ],
  },
  {
    title: '块操作',
    rows: [
      { label: '选中光标所在块', keys: ['Escape'] },
      { label: '选中上一块 / 下一块', keys: ['ArrowUp', 'ArrowDown'] },
      { label: '扩大 / 缩小块选区', keys: ['Shift-ArrowUp', 'Shift-ArrowDown'] },
      { label: '回到块里编辑', keys: ['Enter'] },
      { label: '复制副本', keys: ['Mod-d'] },
      { label: '上移 / 下移', keys: ['Mod-Shift-ArrowUp', 'Mod-Shift-ArrowDown'] },
      { label: '删除选中的块', keys: ['Backspace'] },
      { label: '复制 / 剪切 / 粘贴替换', keys: ['Mod-c', 'Mod-x', 'Mod-v'] },
    ],
  },
  {
    title: '与 AI 对话',
    rows: [
      { label: '切换 agent 的权限模式（对话输入框、文档里正在写的 >> 消息；按 agent 自己上报的顺序，不经过「跳过全部确认」）', keys: ['Shift-Tab'] },
    ],
  },
  {
    title: '随手 AI（用你自己的模型 key，设置 → 随手 AI）',
    rows: [
      { label: '选中文字 = 就地改写（改简洁 / 润色 / 续写 / 译成英文，或直接说）；没选中 = 在光标处起草。↵ 收下，Esc 不要', keys: [OWN.quick] },
      { label: '对话输入框 / 文档里正在写的 >> 消息：把话写清楚（只改草稿，不发送，⌘Z 回到原文）', keys: [OWN.quick] },
      { label: '项目面板的文件查看器：选中几行 = 就地 diff 改写，↵ 收下会把改写写回机器上的文件（要对这台机器有使用权、页面可写；读到之后文件被改过会拒绝）', keys: [OWN.quick] },
      { label: '项目面板的终端：说人话出命令。↵ 生成，再 ↵ 执行；Tab 只放进终端的输入行自己改，Esc 取消；多行命令要点确认。不会自动执行', keys: [OWN.quick] },
    ],
  },
  {
    title: '项目面板（页面的 agent 是你自己能用的机器时）',
    rows: [
      { label: '开关项目面板（文件 / 改动：只预览，不做 git 操作）。光标在正文里时它仍是行内代码，请用顶栏按钮', keys: [PROJECT_KEYS.toggle] },
      { label: '在项目面板里找文件（面板开着时）', keys: [PROJECT_KEYS.quickOpen] },
    ],
  },
  {
    title: '编辑',
    rows: [
      { label: '撤销', keys: ['Mod-z'] },
      { label: '重做', keys: ['Mod-Shift-z', 'Mod-y'] },
      { label: '全选（先选当前块，再按选全文）', keys: ['Mod-a'] },
      { label: '页内查找 / 替换', keys: ['Mod-f', 'Mod-h'] },
    ],
  },
]

export const MARKDOWN_RULES: Array<{ input: string; label: string }> = [
  { input: '# ', label: '标题 1（## 标题 2、### 标题 3）' },
  { input: '- ', label: '无序列表' },
  { input: '1. ', label: '有序列表' },
  { input: '[ ] ', label: '待办' },
  { input: '> ', label: '引用' },
  { input: '>> ', label: '给 AI 的消息' },
  { input: '```', label: '代码块（``` 后可接语言名）' },
  { input: '---', label: '分隔线' },
  { input: '|3x3| ', label: '3 列 3 行的表格' },
  { input: '**文字**', label: '加粗（*斜体*、`代码`、~~删除线~~ 同理）' },
  { input: '==文字==', label: '黄色高亮' },
  { input: '/', label: '插入菜单' },
  { input: '@', label: '提及页面 / Agent / 成员 / Skill' },
  { input: '[[', label: '链接到页面（可直接新建）' },
]

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  Mod: ['⌘', 'Ctrl'],
  Shift: ['⇧', 'Shift'],
  Alt: ['⌥', 'Alt'],
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  Escape: ['Esc', 'Esc'],
  Backspace: ['⌫', 'Backspace'],
  Enter: ['↵', 'Enter'],
  Tab: ['⇥', 'Tab'],
}

/** PM 键名 → 按键帽（Mac 用符号，其它平台用文字） */
export function keyCaps(key: string): string[] {
  return key.split('-').map((part) => {
    const named = KEY_NAMES[part]
    if (named) return MAC ? named[0] : named[1]
    return part.length === 1 ? part.toUpperCase() : part
  })
}
