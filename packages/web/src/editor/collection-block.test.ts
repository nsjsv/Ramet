import { describe, expect, test } from 'vitest'
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { collectionHref, parseCollectionHref, pastedAsLinks } from './collection-block'
import { upgradeLinkBlocks } from './page-ref'
import { schema as base } from './test-schema'

/* 不变量：集合块的源码记号 `[名称](collection:<id>?view=<vid>[&link=1])` 由 collectionHref 写出，upgradeLinkBlocks 认回
 * 同一种块且 attrs 不丢（id 交给补 id 插件）；粘贴进来的 collection_inline 一律变 collection_link（任意深度）。 */

const blockAttrs = { id: { default: '' }, collectionId: { default: '' }, viewId: { default: '' }, title: { default: '' } }
const schema = new Schema({
  nodes: base.spec.nodes.append({
    page_ref: { group: 'block', atom: true, attrs: { id: { default: '' }, pageId: { default: '' }, title: { default: '' }, icon: { default: null } } },
    attachment: { group: 'block', atom: true, attrs: { id: { default: '' }, src: { default: '' }, name: { default: '' } } },
    block_ref: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, blockId: { default: '' }, text: { default: '' } } },
    collection_inline: { group: 'block', atom: true, attrs: blockAttrs },
    collection_link: { group: 'block', atom: true, attrs: blockAttrs },
  }),
  marks: base.spec.marks,
})

const CID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const linkPara = (text: string, href: string) => schema.nodes.paragraph!.create(null, schema.text(text, [schema.marks.link!.create({ href })]))

describe('源码记号', () => {
  test('写出与认回互逆', () => {
    expect(collectionHref(CID, 'v1abcd', false)).toBe(`collection:${CID}?view=v1abcd`)
    expect(collectionHref(CID, 'v1abcd', true)).toBe(`collection:${CID}?view=v1abcd&link=1`)
    for (const link of [false, true]) {
      expect(parseCollectionHref(collectionHref(CID, 'v1abcd', link))).toEqual({ collectionId: CID, viewId: 'v1abcd', link })
    }
    expect(parseCollectionHref(collectionHref(CID, '', false))).toEqual({ collectionId: CID, viewId: '', link: false })
  })
  test('认不出的不升', () => {
    expect(parseCollectionHref('collection:')).toBeNull()
    expect(parseCollectionHref(`collection:${CID}?view=a b`)).toBeNull()
    expect(parseCollectionHref(`/page/${CID}`)).toBeNull()
    expect(parseCollectionHref(`collection:${CID}?view=v1&link=2`)).toBeNull()
  })

  test('独占一段的记号升回对应的块，attrs 不丢；与别的文字混排的不动', () => {
    const doc = schema.nodes.doc!.create(null, [
      linkPara('需求池', collectionHref(CID, 'v1abcd', false)),
      linkPara('需求池', collectionHref(CID, 'v2abcd', true)),
      schema.nodes.paragraph!.create(null, [schema.text('看 '), schema.text('需求池', [schema.marks.link!.create({ href: collectionHref(CID, 'v1', false) })])]),
    ])
    const tr = EditorState.create({ doc }).tr
    expect(upgradeLinkBlocks(tr)).toBe(true)
    const out: { type: string; attrs: Record<string, unknown> }[] = []
    tr.doc.forEach((n) => out.push({ type: n.type.name, attrs: n.attrs }))
    expect(out[0]).toEqual({ type: 'collection_inline', attrs: { id: '', collectionId: CID, viewId: 'v1abcd', title: '需求池' } })
    expect(out[1]).toEqual({ type: 'collection_link', attrs: { id: '', collectionId: CID, viewId: 'v2abcd', title: '需求池' } })
    expect(out[2]?.type).toBe('paragraph')
    // 幂等，升过的不再是链接
    expect(upgradeLinkBlocks(EditorState.create({ doc: tr.doc }).tr)).toBe(false)
  })
})

describe('粘贴', () => {
  test('collection_inline 一律变 collection_link（含容器里的），其余原样', () => {
    const inline = schema.nodes.collection_inline!.create({ id: 'b1', collectionId: CID, viewId: 'v1', title: 'T' })
    const quoted = schema.nodes.blockquote!.create(null, [schema.nodes.collection_inline!.create({ collectionId: CID })])
    const para = schema.nodes.paragraph!.create(null, schema.text('x'))
    const out = pastedAsLinks(new Slice(Fragment.fromArray([inline, quoted, para]), 0, 0), schema)
    const names: string[] = []
    out.content.descendants((n) => void names.push(n.type.name))
    expect(names).toEqual(['collection_link', 'blockquote', 'collection_link', 'paragraph', 'text'])
    expect(out.content.child(0).attrs).toEqual({ id: 'b1', collectionId: CID, viewId: 'v1', title: 'T' })
  })
  test('没有集合块的切片原样返回', () => {
    const slice = new Slice(Fragment.from(schema.nodes.paragraph!.create(null, schema.text('x'))), 0, 0)
    expect(pastedAsLinks(slice, schema)).toBe(slice)
  })
})

test('markdown 粘贴：独占一段的集合记号（不论带不带 &link=1）进成链接视图块', async () => {
  const { pastedMarkdownLinks } = await import('./collection-block')
  const content = Fragment.fromArray([
    linkPara('需求池', collectionHref(CID, 'v1', false)),
    linkPara('别的', '/page/x'),
    schema.nodes.paragraph!.create(null, schema.text('文字')),
  ])
  const out = pastedMarkdownLinks(content, schema)
  expect(out.child(0).type.name).toBe('collection_link')
  expect(out.child(0).attrs).toEqual({ id: '', collectionId: CID, viewId: 'v1', title: '需求池' })
  expect(out.child(1).type.name).toBe('paragraph')
  expect(pastedMarkdownLinks(Fragment.from(out.child(2)), schema).child(0).type.name).toBe('paragraph')
})

test('跨页搬块的判定：块自己或容器里有「集合」块就算；链接视图块不算', async () => {
  const { hasInlineCollection } = await import('./collection-block')
  const inline = schema.nodes.collection_inline!.create({ collectionId: CID })
  const link = schema.nodes.collection_link!.create({ collectionId: CID })
  expect(hasInlineCollection(inline)).toBe(true)
  expect(hasInlineCollection(link)).toBe(false)
  expect(hasInlineCollection(schema.nodes.blockquote!.create(null, [schema.nodes.paragraph!.create(), inline]))).toBe(true)
  expect(hasInlineCollection(schema.nodes.blockquote!.create(null, [link]))).toBe(false)
  expect(hasInlineCollection(schema.nodes.paragraph!.create(null, schema.text('x')))).toBe(false)
})
