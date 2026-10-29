import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { assetToken, exportDoc, type ExportContext } from './export-doc'
import { slugOf } from './export-pages'

/* 不变量：导出前把自定义节点换成标准节点 —— 图片 / 附件换成相对占位并登记资源；页面链接在导出集合里就是相对目录，
 * 不在就是纯文字；用户消息 → 引用块、AI 回复 → 加粗名字 + 内容；步骤 / 块提及 / agent 点名 → 文字 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    blockquote: { group: 'block', content: 'block+' },
    user_message: { group: 'block', content: 'paragraph+' },
    agent_reply: { group: 'block', content: 'block+', attrs: { agent: { default: '' } } },
    attachment: { group: 'block', atom: true, attrs: { src: { default: '' }, name: { default: '' } } },
    page_ref: { group: 'block', atom: true, attrs: { pageId: { default: '' }, title: { default: '' } } },
    block_sync: { group: 'block', atom: true, attrs: { pageId: { default: '' }, blockId: { default: '' } } },
    run_step: { group: 'block', content: 'inline*', attrs: { k: { default: 'tool' }, kind: { default: '' } } },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' }, alt: { default: '' } } },
    page_mention: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, title: { default: '' } } },
    block_ref: { group: 'inline', inline: true, atom: true, attrs: { text: { default: '' } } },
    agent_mention: { group: 'inline', inline: true, atom: true, attrs: { agentId: { default: '' }, label: { default: '' } } },
    text: { group: 'inline' },
  },
  marks: { link: { attrs: { href: {}, title: { default: null } } }, strong: {} },
})

const FILE = '11111111-1111-4111-8111-111111111111'
const t = (s: string) => schema.text(s)
const p = (...inline: PMNode[]) => schema.node('paragraph', null, inline)

function ctx(over: Partial<ExportContext> = {}): ExportContext {
  return {
    schema,
    dirOf: (id) => (id === 'child' ? 'child-page' : undefined),
    agentLabel: (id) => (id === 'claude' ? 'Claude' : id),
    assets: new Map(),
    ...over,
  }
}

/** 压成易断言的文本：节点名(内容) / 文字[链接] */
function dump(node: PMNode): string {
  if (node.isText) {
    const link = node.marks.find((m) => m.type.name === 'link')
    const strong = node.marks.some((m) => m.type.name === 'strong')
    return `${strong ? '**' : ''}${node.text}${strong ? '**' : ''}${link ? `[${String(link.attrs.href)}]` : ''}`
  }
  const attrs = node.type.name === 'image' ? `{${String(node.attrs.src)}}` : ''
  return `${node.type.name}${attrs}(${node.content.content.map(dump).join(' ')})`
}

test('图片 / 附件登记资源并换成占位；页面链接是相对目录，不在导出集合里就是纯文字', () => {
  const c = ctx()
  const doc = schema.node('doc', null, [
    p(t('图 '), schema.node('image', { src: `/api/files/${FILE}/display`, alt: 'a' })),
    schema.node('attachment', { src: `/api/files/${FILE.replace('1111', '2222')}`, name: 'report.pdf' }),
    schema.node('page_ref', { pageId: 'child', title: '子页' }),
    schema.node('page_ref', { pageId: 'other', title: '外面的页' }),
    p(schema.node('page_mention', { pageId: 'child', title: '子页' }), t(' '), schema.node('page_mention', { pageId: 'other', title: '外面的页' })),
    p(schema.node('image', { src: 'https://cdn.example/x.png', alt: '' })),
  ])
  const out = exportDoc(doc, c).content.content.map(dump)
  expect(out[0]).toBe(`paragraph(图  image{${assetToken(FILE)}}())`)
  expect(out[1]).toBe(`paragraph(report.pdf[${assetToken(FILE.replace('1111', '2222'))}])`)
  expect(out[2]).toBe('paragraph(子页[../child-page/])')
  expect(out[3]).toBe('paragraph(外面的页)') // 不在这次导出里：没有链接
  expect(out[4]).toBe('paragraph(子页[../child-page/]  外面的页)')
  expect(out[5]).toBe('paragraph(image{https://cdn.example/x.png}())') // 外链原样
  expect([...c.assets]).toEqual([
    [FILE, { kind: 'image', name: 'a' }],
    [FILE.replace('1111', '2222'), { kind: 'attachment', name: 'report.pdf' }],
  ])
})

test('消息 / 回复 / 步骤 / 块提及 / 点名 / 同步块都换成标准形态', () => {
  const doc = schema.node('doc', null, [
    schema.node('user_message', null, [p(t('帮我看看 '), schema.node('agent_mention', { agentId: 'claude', label: 'Claude' }))]),
    schema.node('agent_reply', { agent: 'claude' }, [p(t('好的'), schema.node('block_ref', { text: '引用的话' }))]),
    schema.node('run_step', { k: 'tool', kind: 'read' }, [t('src/a.ts')]),
    schema.node('block_sync', { pageId: 'x', blockId: 'y' }),
  ])
  const out = exportDoc(doc, ctx()).content.content.map(dump)
  expect(out[0]).toBe('blockquote(paragraph(**你**) paragraph(帮我看看 @Claude))')
  expect(out[1]).toBe('paragraph(**Claude**)')
  expect(out[2]).toBe('paragraph(好的引用的话)')
  expect(out[3]).toMatch(/^paragraph\(.*src\/a\.ts\)$/)
  expect(out[4]).toBe('paragraph(（同步块）)')
})

test('页面名 → 文件夹名：去非法字符、空白换连字符、限长；空则 untitled', () => {
  expect(slugOf('产品 路线 / 2026: Q4?')).toBe('产品-路线-2026-Q4')
  expect(slugOf('  ')).toBe('untitled')
  expect(slugOf('...')).toBe('untitled')
  expect(slugOf('a'.repeat(100))).toHaveLength(60)
  expect(slugOf('report.v2')).toBe('report.v2')
})
