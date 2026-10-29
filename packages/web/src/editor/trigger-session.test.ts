import { describe, expect, test } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { mentionQuery } from './mention-query'
import { advance, END_SESSION, insertedAt, sessionField, slashQuery, type Session } from './trigger-session'

/* 不变量（trigger-session.ts 文件头）：只有刚打出触发符的那一下开启会话；之后打字是筛选；
 * 光标离开 / 触发符被删 / 宿主结束后不再复活；粘贴、协同、只是挪光标都不开启。 */

describe('advance（纯函数）', () => {
  const at = (trigger: string, pos: number, query: string) => ({ trigger, start: 0, query, at: pos })
  test('刚打出且查询为空 → 开启；之后同一起点 → 延续；起点变了 / 没有解析 → 结束', () => {
    const s = advance(null, at('@', 5, ''), true)
    expect(s).toEqual({ trigger: '@', at: 5 })
    expect(advance(s, at('@', 5, '周'), false)).toBe(s)
    expect(advance(s, at('@', 9, ''), false)).toBeNull()
    expect(advance(s, null, false)).toBeNull()
  })
  test('没有会话时，光标挪到旧触发符后面（不是刚打出）→ 不开启', () => {
    expect(advance(null, at('/', 3, ''), false)).toBeNull()
    expect(advance(null, at('/', 3, 'h1'), true)).toBeNull()
  })
})

describe('slashQuery', () => {
  test('光标前最后一个 / 到光标：不含空白', () => {
    expect(slashQuery('abc /标题', 7)).toEqual({ trigger: '/', start: 4, query: '标题' })
    expect(slashQuery('/h1 ', 4)).toBeNull()
    expect(slashQuery('无斜杠', 3)).toBeNull()
  })
})

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
})
const key = new PluginKey<Session | null>('t')
const plugin = new Plugin<Session | null>({
  key,
  state: sessionField((tr) => tr.getMeta(key), (text, cursor) => mentionQuery(text, cursor) ?? slashQuery(text, cursor), () => true),
})

function stateWith(text: string): EditorState {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text ? [schema.text(text)] : [])])
  const s = EditorState.create({ doc, plugins: [plugin] })
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1 + text.length)))
}
const type = (s: EditorState, text: string): EditorState => s.apply(s.tr.insertText(text))
const apply = (s: EditorState, f: (tr: Transaction) => Transaction): EditorState => s.apply(f(s.tr))

describe('sessionField（PM 宿主）', () => {
  test('打出 @ 开启，接着打字延续；查询结束（空格）后关闭', () => {
    let s = type(stateWith('你好 '), '@')
    expect(key.getState(s)).toEqual({ trigger: '@', at: 4 })
    s = type(s, '周报')
    expect(key.getState(s)).toEqual({ trigger: '@', at: 4 })
    s = type(s, ' ')
    expect(key.getState(s)).toBeNull()
  })

  test('关闭后把光标挪回 @ 后面：不复活', () => {
    let s = type(stateWith(''), '@')
    s = apply(s, (tr) => tr.setMeta(key, END_SESSION))
    expect(key.getState(s)).toBeNull()
    s = apply(s, (tr) => tr.setSelection(TextSelection.create(s.doc, 2)))
    expect(key.getState(s)).toBeNull()
  })

  test('点到别处再回来：不复活', () => {
    let s = type(stateWith('前文'), '/')
    expect(key.getState(s)?.trigger).toBe('/')
    s = apply(s, (tr) => tr.setSelection(TextSelection.create(s.doc, 1)))
    expect(key.getState(s)).toBeNull()
    s = apply(s, (tr) => tr.setSelection(TextSelection.create(s.doc, 4)))
    expect(key.getState(s)).toBeNull()
  })

  test('粘贴进来的 / 不开启；[[ 打出第二个 [ 时开启', () => {
    const pasted = apply(stateWith(''), (tr) => tr.insertText('/').setMeta('uiEvent', 'paste'))
    expect(key.getState(pasted)).toBeNull()
    let s = type(stateWith(''), '[')
    expect(key.getState(s)).toBeNull()
    s = type(s, '[')
    expect(key.getState(s)).toEqual({ trigger: '[[', at: 1 })
  })

  test('删掉触发符 → 结束；前面插字 → 会话跟着位置走', () => {
    let s = type(stateWith('ab '), '@')
    expect(key.getState(s)).toEqual({ trigger: '@', at: 4 })
    s = apply(s, (tr) => tr.insertText('X', 1))
    expect(key.getState(s)).toEqual({ trigger: '@', at: 5 })
    s = apply(s, (tr) => tr.delete(5, 6))
    expect(key.getState(s)).toBeNull()
  })
})

describe('insertedAt', () => {
  test('本事务插入的字符 → true；原有字符 → false', () => {
    const s = stateWith('abc')
    const tr = s.tr.insertText('/', 2)
    expect(insertedAt(tr, 2)).toBe(true)
    expect(insertedAt(tr, 1)).toBe(false)
    expect(insertedAt(tr, 3)).toBe(false)
  })
})
