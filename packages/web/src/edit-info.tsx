// ---------- 菜单底部的「字数 + 上次编辑」（顶栏 ⋮ 菜单与块手柄菜单共用） ----------
// 编辑记录来自 edit-marks-store 的缓存，字数由调用方现算（word-count.ts）。
// AI 写的用目录里的 agent 名，人用用户名（有头像所以不写「你」），删号显示「有人」。
// 头像走 people.ts 的 avatarLook（服务端只在编辑者仍是空间成员时给头像图），AI 画机器人图标。
// 四行：最近修改 / 头像 + 名字 / 时间 / 字数；没有编辑记录时只剩字数。
// React 宿主（TopBar）用 <EditInfoLines>，DOM 宿主（block-menu.ts）用 renderEditInfo，两者画同一套 class。
// 顶栏常驻的「3分钟前编辑」是 <EditedAgo>，自己订阅缓存，打字时只重画这一小段，每 30 秒重算相对时间。

import { useEffect, useState } from 'react'
import { editInfoOf, subscribeEditMarks, type EditInfo } from './edit-marks-store'
import { Avatar } from './Avatar'
import { COPY } from './copy'
import { Icon, iconSvg } from './icons'
import { fillAvatar, type Person } from './people'
import { agentLabel, relativeTime } from './UpdatesFeed'

interface Look {
  name: string
  /** null = AI（画机器人） */
  person: Person | null
  when: string
  /** 悬停全文：上次编辑于 2026/10/25 14:30:05 */
  title: string
}

function lookOf(info: EditInfo): Look {
  const agent = info.actor === 'agent'
  const name = agent ? agentLabel(info.actor_agent) : (info.username ?? COPY.editInfo.someone)
  const person = agent ? null : { id: info.user_id ?? '', username: info.username ?? '?', avatar: info.avatar }
  const date = new Date(info.edited_at)
  const full = Number.isNaN(date.getTime()) ? info.edited_at : date.toLocaleString('zh-CN', { hour12: false })
  return { name, person, when: relativeTime(info.edited_at), title: COPY.editInfo.editedAt(full) }
}

/** React：最近修改 / 头像 + 名字 / 时间 / 字数（info 为 null = 没有记录 / 还没取到，只显示字数） */
export function EditInfoLines({ words, info }: { words: number | null; info: EditInfo | null }) {
  const look = info ? lookOf(info) : null
  return (
    <div className="edit-info">
      {look && (
        <>
          <div className="edit-info-label">{COPY.editInfo.label}</div>
          <div className="edit-info-by">
            {look.person ? (
              <Avatar person={look.person} size={16} />
            ) : (
              <span className="avatar avatar-round is-none" style={{ '--avatar-size': '16px' } as React.CSSProperties} aria-hidden="true">
                <Icon name="bot" size={11} />
              </span>
            )}
            <span className="edit-info-name">{look.name}</span>
          </div>
          <div className="edit-info-when" title={look.title}>
            {look.when}
          </div>
        </>
      )}
      {words !== null && <div className="edit-info-words">{COPY.editInfo.words(words)}</div>}
    </div>
  )
}

/** 顶栏：「3分钟前编辑」，悬停给编辑者与完整时间，点击打开版本历史；没有记录（还没取到 / 从没编辑过）不画（历史在 ⋮ 菜单里也有） */
export function EditedAgo({ pageId, onOpen }: { pageId: string; onOpen: () => void }) {
  const [info, setInfo] = useState(() => editInfoOf(pageId))
  const [, setTick] = useState(0)
  useEffect(() => {
    const sync = () => setInfo(editInfoOf(pageId))
    sync()
    const off = subscribeEditMarks(sync)
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [pageId])
  if (!info) return null
  const look = lookOf(info)
  return (
    <button type="button" className="topbar-edited" title={`${look.name} · ${look.title}`} onClick={onOpen}>
      {COPY.editInfo.edited(look.when)}
    </button>
  )
}

/** DOM：同上，画进 host（先清空）。块菜单先画字数、编辑信息到了再调一次补上 */
export function renderEditInfo(host: HTMLElement, words: number | null, info: EditInfo | null): void {
  host.className = 'edit-info'
  host.replaceChildren()
  const line = (cls: string, text: string): HTMLDivElement => {
    const el = document.createElement('div')
    el.className = cls
    el.textContent = text
    return el
  }
  if (info) {
    const look = lookOf(info)
    const row = document.createElement('div')
    row.className = 'edit-info-by'
    const plate = document.createElement('span')
    plate.classList.add('avatar-round')
    plate.style.setProperty('--avatar-size', '16px')
    plate.setAttribute('aria-hidden', 'true')
    if (look.person) fillAvatar(plate, look.person)
    else {
      plate.classList.add('avatar', 'is-none')
      plate.innerHTML = iconSvg('bot', 11)
    }
    const name = document.createElement('span')
    name.className = 'edit-info-name'
    name.textContent = look.name
    row.append(plate, name)
    const when = line('edit-info-when', look.when)
    when.title = look.title
    host.append(line('edit-info-label', COPY.editInfo.label), row, when)
  }
  if (words !== null) host.append(line('edit-info-words', COPY.editInfo.words(words)))
}
