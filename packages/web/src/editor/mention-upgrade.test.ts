import { describe, expect, test } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { ySyncPluginKey } from 'y-prosemirror'
import { mentionUpgradePlugin } from './mention-upgrade'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    page_mention: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, title: { default: '' } } },
  },
  marks: { link: { attrs: { href: { default: '' } } } },
})

/** 一笔把段落换成「@周报」页面链接的事务；remote = 伪装成协同灌进来的那一笔 */
function linkTr(state: EditorState, remote: boolean) {
  const tr = state.tr.insert(1, schema.text('@周报', [schema.mark('link', { href: 'page:p1' })]))
  return remote ? tr.setMeta(ySyncPluginKey, { isChangeOrigin: true }) : tr
}

const names = (state: EditorState): string[] => {
  const out: string[] = []
  state.doc.descendants((n) => {
    if (n.isInline) out.push(n.type.name)
  })
  return out
}

describe('提及升级：可写的编辑器只升本端改动', () => {
  const start = (remote?: boolean) => EditorState.create({ schema, plugins: [mentionUpgradePlugin(remote ? { remote } : {})] })

  test('本端改动里的链接形态当场升成 chip', () => {
    const s = start()
    expect(names(s.applyTransaction(linkTr(s, false)).state)).toEqual(['page_mention'])
  })

  test('协同灌进来的改动不升：在那一笔里追加的改动回不到 Yjs，只会让这个编辑器和别的视图对不上', () => {
    const s = start()
    expect(names(s.applyTransaction(linkTr(s, true)).state)).toEqual(['text'])
  })

  test('只读宿主（公开页）连远端来的也升：它不写回，只为画对', () => {
    const s = start(true)
    expect(names(s.applyTransaction(linkTr(s, true)).state)).toEqual(['page_mention'])
  })
})
