/* ---------- 评论正文 ----------
 * 正文是纯文字：换行靠 CSS pre-wrap，@ 成员记号 `@[名字](user:<id>)` 画成成员 chip（样式同文档里的 .user-mention），
 * 网址自动成链接（新标签打开）。全部走 React 文本节点，不拼 HTML。 */

import type { ReactNode } from 'react'

// 名字里可能带 `]`：按收口的 `](user:` 定位（同服务端解析口径）
const MENTION = /@\[([^\n]*?)\]\(user:[A-Za-z0-9_-]{1,64}\)/g
// 网址到空白 / 引号 / 尖括号为止；末尾的标点不算网址（「见 https://a.com。」）
const URL_RE = /https?:\/\/[^\s<>"'「」『』（）]+/g
const TRAILING = /[.,;:!?。，；：！？、)\]】》]+$/

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index
    const url = m[0].replace(TRAILING, '')
    if (!url) continue
    if (start > last) out.push(text.slice(last, start))
    out.push(
      <a key={`${key}:${start}`} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    )
    last = start + url.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function CommentBody({ body }: { body: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of body.matchAll(MENTION)) {
    if (m.index > last) parts.push(...linkify(body.slice(last, m.index), `t${last}`))
    parts.push(
      <span key={`m${m.index}`} className="user-mention">
        @{m[1]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < body.length) parts.push(...linkify(body.slice(last), `t${last}`))
  return <div className="cm-body">{parts}</div>
}
