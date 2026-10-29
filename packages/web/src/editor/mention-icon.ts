/* ---------- 引用菜单行的图标（DOM） ----------
 * 文档内菜单直接 append，对话输入框的 React 菜单经 callback ref 挂进来；mention-rows.ts 只给数据。
 * agent 画品牌 mark / 文本 logo（ai-block.ts 的 agentBadge，回落规则同 AI 回复顶栏）；
 * 页面画页面图标（emoji 走 Twemoji，404 退回文字；上传的图走派生小图），没有图标画通用文档 glyph；
 * 新建是加号，分类行是带底色的方块图标，skill 是拼图，成员是头像（people.ts 同一份画法），「查看全部」是省略号。
 * 行尾的 › 也在这里出（chevronEl）。 */

import { pageIconSrc } from '../PageIcon'
import { twemojiUrl } from '../emoji'
import { iconSvg, type IconName } from '../icons'
import { fillAvatar } from '../people'
import { agentBadge } from './ai-block'
import type { MentionCategory } from './mention-query'
import type { RowIcon } from './mention-rows'

const CATEGORY_ICON: Record<MentionCategory, IconName> = { agent: 'bot', page: 'file', skill: 'skill', person: 'users' }

/** 行尾的 ›（分类行 / 「查看全部」：选中是进入，不是插入） */
export function chevronEl(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'pop-chev'
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = iconSvg('chevron', 12)
  return el
}

export function rowIconEl(icon: RowIcon): HTMLElement {
  const box = document.createElement('span')
  box.className = 'pop-ic is-sm'
  box.setAttribute('aria-hidden', 'true')
  if (icon.kind === 'new') {
    box.innerHTML = iconSvg('plus', 14)
  } else if (icon.kind === 'category') {
    box.classList.add('is-cat', `is-${icon.cat}`)
    box.innerHTML = iconSvg(CATEGORY_ICON[icon.cat], 14)
  } else if (icon.kind === 'skill') {
    box.innerHTML = iconSvg('skill', 15)
  } else if (icon.kind === 'more') {
    box.innerHTML = iconSvg('more', 15)
  } else if (icon.kind === 'person') {
    const plate = document.createElement('span')
    plate.className = 'pop-avatar'
    fillAvatar(plate, icon.person)
    box.append(plate)
  } else if (icon.kind === 'agent') {
    const badge = agentBadge(icon.agentId)
    const inner = document.createElement('span')
    if (badge.kind === 'mark') {
      inner.className = 'pop-agent agent-mark'
      inner.style.setProperty('--agent-mark', `var(--mark-${badge.key})`)
    } else {
      inner.className = 'pop-agent'
      inner.textContent = badge.text
    }
    box.append(inner)
  } else if (!icon.icon) {
    const glyph = document.createElement('span')
    glyph.className = 'page-icon page-icon-sm page-icon-glyph'
    box.append(glyph)
  } else {
    const img = document.createElement('img')
    img.className = 'page-icon page-icon-sm page-icon-img'
    img.alt = ''
    img.decoding = 'async'
    if (icon.icon.kind === 'emoji') {
      const emoji = icon.icon.value
      img.classList.add('page-icon-twemoji')
      img.src = twemojiUrl(emoji)
      img.addEventListener('error', () => img.replaceWith(document.createTextNode(emoji)), { once: true })
    } else {
      img.src = pageIconSrc(icon.icon.value)
    }
    box.append(img)
  }
  return box
}
