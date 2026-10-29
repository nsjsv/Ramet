import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { isShortId, parseCollection, STATUS_GROUPS, validateValue } from '@ramet/shared/collection-model'
import { extractTitle } from '../collab.js'
import { newCollectionDoc } from './init-doc.js'

// 不变量（init-doc.ts 文件头）：新集合页 = 普通页的标题片段 + Y.Map('collection')；写出的结构必须能被
// parseCollection 原样解析（两端都用它校验自己写出的结构），并且分层是 Y.Map 的地方真是 Y.Map

function schemaOf(doc: Y.Doc) {
  return parseCollection(doc.getMap('collection').toJSON())
}

describe('newCollectionDoc', () => {
  test('标题照普通页的写法进 title 片段，正文片段是空的', () => {
    const doc = newCollectionDoc('项目看板')
    expect(extractTitle(doc)).toBe('项目看板')
    expect(doc.getXmlFragment('prosemirror').length).toBe(0)
  })

  test('parseCollection 解析出一个「状态」属性（三组各一个默认选项）和一个表格视图', () => {
    const schema = schemaOf(newCollectionDoc('任务'))
    expect(schema.v).toBe(1)
    expect(schema.props).toHaveLength(1)
    const status = schema.props[0]!
    expect(status).toMatchObject({ name: '状态', type: 'status', pos: 0 })
    expect(isShortId(status.id)).toBe(true)
    expect(status.options.map((o) => [o.name, o.group, o.color])).toEqual(STATUS_GROUPS.map((g) => [g.name, g.id, g.color]))
    expect(new Set(status.options.map((o) => o.id)).size).toBe(3)

    expect(schema.views).toHaveLength(1)
    const view = schema.views[0]!
    expect(isShortId(view.id)).toBe(true)
    expect(view).toMatchObject({
      name: '表格',
      layout: 'table',
      pos: 0,
      filter: { all: [] },
      sorts: [],
      groupBy: null,
      shown: null,
      widths: {},
    })
  })

  test('并发语义要求的层都是 Y.Map：props / 属性 / options / views / 视图 / widths', () => {
    const root = newCollectionDoc('x').getMap<unknown>('collection')
    const props = root.get('props')
    expect(props).toBeInstanceOf(Y.Map)
    const [prop] = [...(props as Y.Map<unknown>).values()]
    expect(prop).toBeInstanceOf(Y.Map)
    const options = (prop as Y.Map<unknown>).get('options')
    expect(options).toBeInstanceOf(Y.Map)
    // 选项本身是普通值（整体替换），不是 Y 类型
    for (const option of (options as Y.Map<unknown>).values()) expect(option).not.toBeInstanceOf(Y.AbstractType)
    const views = root.get('views')
    expect(views).toBeInstanceOf(Y.Map)
    const [view] = [...(views as Y.Map<unknown>).values()]
    expect(view).toBeInstanceOf(Y.Map)
    expect((view as Y.Map<unknown>).get('widths')).toBeInstanceOf(Y.Map)
  })

  test('落盘再加载（writeDocState 的编码路径）后解析结果不变', () => {
    const doc = newCollectionDoc('往返')
    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(doc))
    expect(extractTitle(loaded)).toBe('往返')
    expect(schemaOf(loaded)).toEqual(schemaOf(doc))
  })

  test('空标题也是合法文档：标题片段有一个空段落', () => {
    const doc = newCollectionDoc('')
    expect(extractTitle(doc)).toBe('')
    expect(doc.getXmlFragment('title').length).toBe(1)
    expect(schemaOf(doc).props).toHaveLength(1)
  })

  test('默认选项能直接当「状态」的值写；每个新集合的 id 都是新的', () => {
    const a = schemaOf(newCollectionDoc('a'))
    const b = schemaOf(newCollectionDoc('b'))
    const status = a.props[0]!
    expect(validateValue(status, status.options[1]!.id)).toEqual({ ok: true, value: status.options[1]!.id })
    expect(a.props[0]!.id).not.toBe(b.props[0]!.id)
    expect(a.views[0]!.id).not.toBe(b.views[0]!.id)
  })
})
