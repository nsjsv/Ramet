import { Schema } from '@milkdown/kit/prose/model'

/* 标题协作编辑器的最小 schema，快照面板用同一结构把 Yjs title fragment 转成 PM 节点渲染 / 恢复。
 * 无 marks（粘贴富文本自动丢格式），仅 paragraph / text。
 * prose 模块一律走 @milkdown/kit/prose/*（与正文同一份 prosemirror 单例），不要直接 import 'prosemirror-*'。 */
export const titleSchema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
  },
})
