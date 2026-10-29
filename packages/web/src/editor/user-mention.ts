/* ---------- user_mention：@ 成员（行内原子 chip） ----------
 * `@` 大菜单「成员」分类选中后的样子：一颗显示 `@用户名` 的小胶囊（与 agent_mention 同档）。
 * attrs 都是字符串：
 * - userId：身份唯一来源（users.id）；
 * - name：显示快照（对方改名不回写 chip，同 agent_mention.label / page_mention.title 的口径）。
 * 给 AI / 搜索 / 导出的文本是 `@用户名`（updates.ts textOf、export-doc.ts），userId 不进文字。不发通知。
 *
 * 三个进出通道（同 agent_mention）：toDOM / parseDOM 保剪贴板往返；toMarkdown 写成 `[@名字](user:<id>)` 链接
 * （md-link，合法 mdast），由 mention-upgrade.ts 在 parse 边界升回来；不接 markdown 解析路径。
 * 对话输入框（textarea）里是纯文本记号 `@[名字](user:<id>)`，发送时同样由 mention-upgrade 升成 chip。
 * Editor / PublicPage 必须 .use（协同对端与公开页出现未注册节点会整页解析失败）。 */

import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'

/** chip 的 DOM 标记属性（parseDOM 认它） */
export const USER_MENTION_ATTR = 'data-user-mention'

export const userMentionSchema = $nodeSchema('user_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 原子 chip：光标进不去，backspace 一次删整颗
  attrs: {
    userId: { default: '' },
    name: { default: '' },
  },
  parseDOM: [
    {
      tag: `span[${USER_MENTION_ATTR}]`,
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return { userId: el.getAttribute(USER_MENTION_ATTR) ?? '', name: (el.textContent ?? '').replace(/^@/, '') }
      },
    },
  ],
  toDOM: (node) => ['span', { class: 'user-mention', [USER_MENTION_ATTR]: node.attrs.userId }, `@${node.attrs.name}`],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'user_mention',
    runner: (state, node) => {
      const id = typeof node.attrs.userId === 'string' ? node.attrs.userId : ''
      mdLink(state, `@${String(node.attrs.name ?? '')}`, `user:${id}`, false)
    },
  },
}))
