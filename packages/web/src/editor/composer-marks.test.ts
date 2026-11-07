import { describe, expect, test } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { attItemsOf, attLabels } from './att-cards'
import { draftToComposerText, imageMark } from './composer-bridge'
import { fileMark, fileName, fileOfTarget, fileTarget } from './file-mention'
import { upgradeMentions } from './mention-upgrade'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' }, preview: { default: '' }, key: { default: '' }, failed: { default: false } } },
    file_mention: { group: 'inline', inline: true, atom: true, attrs: { path: { default: '' } } },
    block_ref: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, blockId: { default: '' }, text: { default: '' } } },
    page_mention: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, title: { default: '' } } },
  },
  marks: { link: { attrs: { href: { default: '' } } } },
})

const ID = '0b6f4a52-9f9e-4c1d-8f3a-1c2d3e4f5a6b'

/** 一段记号文字（每行一段）升级之后的文档 */
function upgraded(text: string): PMNode {
  const doc = schema.nodes.doc!.create(
    null,
    text.split('\n').map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null)),
  )
  const tr = EditorState.create({ schema, doc }).tr
  upgradeMentions(tr)
  return tr.doc
}

const inlines = (doc: PMNode): string[] => {
  const out: string[] = []
  doc.descendants((n) => {
    if (n.isInline) out.push(n.isText ? `"${n.text}"` : `${n.type.name}:${String(n.attrs.src ?? n.attrs.path ?? n.attrs.text ?? '')}`)
  })
  return out
}

describe('文件引用的记号编码', () => {
  test('空白、括号、百分号编码后还能原样解回来，别的字符保持可读', () => {
    const path = 'docs/设计 稿 (v2)/100%.md'
    const target = fileTarget(path)
    expect(target).not.toMatch(/[\s()]/)
    expect(target).toContain('docs/设计')
    expect(fileOfTarget(target)).toBe(path)
  })

  test('不是合法编码的 target（手写的）原样当路径', () => {
    expect(fileOfTarget('a%zz.ts')).toBe('a%zz.ts')
  })

  test('显示名是最后一段，目录引用的尾斜杠不算', () => {
    expect(fileName('packages/web/src/Sidebar.tsx')).toBe('Sidebar.tsx')
    expect(fileName('packages/web/')).toBe('web')
  })
})

describe('图片 / 文件记号升成节点', () => {
  test('图片落在文字原位，文件引用解出完整路径', () => {
    const doc = upgraded(`对比 ${imageMark(`/api/files/${ID}`)} 和 ${fileMark('src/a b.ts')} 看看`)
    expect(inlines(doc)).toEqual(['"对比 "', `image:/api/files/${ID}`, '" 和 "', 'file_mention:src/a b.ts', '" 看看"'])
  })

  test('不是本站文件 id 的图片记号不升，原样留字', () => {
    expect(inlines(upgraded('@[图片](image:http://x.com/a.png)'))).toEqual(['"@[图片](image:http://x.com/a.png)"'])
  })

  test('链接形态的文件引用（toMarkdown 的输出）也升', () => {
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text('@src/x.ts', [schema.mark('link', { href: 'file:src/x.ts' })])))
    const tr = EditorState.create({ schema, doc }).tr
    upgradeMentions(tr)
    expect(inlines(tr.doc)).toEqual(['file_mention:src/x.ts'])
  })
})

describe('输入框 ⇄ 记号文字往返', () => {
  test('图片 / 文件引用出记号，再升回来是同样的节点', () => {
    const text = `看 ${imageMark(`/api/files/${ID}`)}\n${fileMark('docs/a (1).md')}`
    expect(draftToComposerText(upgraded(text))).toBe(text)
  })

  test('还在上传的图（没有 src）不出记号：发不出去也排不进队', () => {
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, [schema.text('图 '), schema.nodes.image!.create({ key: 'a1', preview: 'blob:x' })]))
    expect(draftToComposerText(doc)).toBe('图 ')
  })
})

describe('附件清单', () => {
  test('按文档序收集，图 N / 引用 N / 页面 N 各自编号，文件是文件名', () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, [
        schema.nodes.image!.create({ src: `/api/files/${ID}` }),
        schema.nodes.block_ref!.create({ text: '一段话' }),
        schema.nodes.file_mention!.create({ path: 'src/a.ts' }),
        schema.nodes.page_mention!.create({ pageId: 'p1', title: '周报' }),
      ]),
      schema.nodes.paragraph!.create(null, [schema.nodes.image!.create({ key: 'k', preview: 'blob:y' }), schema.nodes.image!.create({ key: 'f', failed: true })]),
    ])
    const items = attItemsOf(doc)
    expect(items.map((i) => (i.kind === 'image' ? `image:${i.state}` : i.kind))).toEqual(['image:ok', 'quote', 'file', 'page', 'image:uploading', 'image:failed'])
    expect(attLabels(items)).toEqual(['图 1', '引用 1', 'a.ts', '页面 1', '图 2', '图 3'])
    // 传完的图预览走 display 版
    expect(items[0]).toMatchObject({ preview: `/api/files/${ID}/display` })
  })
})
