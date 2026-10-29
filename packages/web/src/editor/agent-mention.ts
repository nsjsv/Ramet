// ---------- agent_mention：@ agent 点名（行内原子 chip） ----------
// 消息里 `@claude 写 @codex 审` 的 `@claude` / `@codex`，显示成 `@名字` 的小胶囊。
// 发送时的规则在服务端（agents/doc.ts 的 mentionChain + manager.resolveRun）：只跑被点名的 agent，按出现顺序一家一家来。
// attrs 都是字符串：
// - agentId：身份唯一来源（catalog id，connector 的 agent 是 `c:<connectorId>:<agentId>`）；
// - label：显示快照，agent 改名 / 离线不回写 chip（同 page_mention.title）。
// 提示词里它是 `@名字`（updates.ts textOf），agentId 不进文字。
//
// 进出通道同 page_mention：toDOM/parseDOM 保剪贴板往返；toMarkdown 写成 `[@名字](agent:<id>)` 链接
// （md-link，合法 mdast），形状与 `page:` 链接可区分，由 mention-upgrade.ts 在 parse 边界升回来，不接 markdown 解析路径。
// Editor / PublicPage 必须 .use，否则协同对端与公开页出现未注册节点会整页解析失败。

import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'

/** chip 的 DOM 标记属性（parseDOM 认它） */
export const AGENT_MENTION_ATTR = 'data-agent-mention'

export const agentMentionSchema = $nodeSchema('agent_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 原子 chip：光标进不去，backspace 一次删整颗
  attrs: {
    agentId: { default: '' },
    label: { default: '' },
  },
  parseDOM: [
    {
      tag: `span[${AGENT_MENTION_ATTR}]`,
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return { agentId: el.getAttribute(AGENT_MENTION_ATTR) ?? '', label: (el.textContent ?? '').replace(/^@/, '') }
      },
    },
  ],
  toDOM: (node) => ['span', { class: 'agent-mention', [AGENT_MENTION_ATTR]: node.attrs.agentId }, `@${node.attrs.label}`],
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'agent_mention',
    runner: (state, node) => {
      const id = typeof node.attrs.agentId === 'string' ? node.attrs.agentId : ''
      mdLink(state, `@${String(node.attrs.label ?? '')}`, `agent:${id}`, false)
    },
  },
}))
