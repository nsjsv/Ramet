/* ---------- 人员目录：用户 id → 名字 + 头像 ----------
 * 对话气泡按发言人画头像（非 React 的 widget，chat-view.tsx）、侧栏账号处与设置里画自己，都读这里。
 * 数据源：
 *   - 自己 = 登录态（App 的 user 经 setSelf 镜像过来，改头像后立即生效）；
 *   - 别人 = 页面所在空间的成员列表（GET /api/spaces/:id/members 带 avatar），按空间惰性取一次，缓存到刷新为止
 *     （control 广播每次改页名都会发，跟着它重取成员太费流量；别人换头像下次刷新可见）。
 *     只认同空间成员：服务端成员列表本身就这么限，头像只给有共同空间的人看。
 * 头像图是上传文件的 160px 方图派生（/api/files/:id/icon，与页面图标同一条）。
 * 显示规则只有一份（avatarLook）：有图画图；没图 = 用户名首字 + 按用户名稳定取色（同协作光标色）；
 * 不认识的人（已退出空间 / 成员还没取到）= 中性人形。 */

import { api } from './api'
import { cursorIdentity } from './identity'
import { iconSvg } from './icons'

export interface Person {
  id: string
  username: string
  /** 头像图片的 files.id；null = 没上传 */
  avatar: string | null
}

let self: Person | null = null
/** 空间 id → 成员；null = 取数中（不重复发请求） */
const spaces = new Map<string, Map<string, Person> | null>()
/** 取数中的请求（spaceMembers 的等待方用；落定后摘掉） */
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((l) => l())
}

/** 登录态镜像（Shell 在 user 变化时调用）；同值不通知 */
export function setSelf(p: Person): void {
  if (self && self.id === p.id && self.username === p.username && self.avatar === p.avatar) return
  self = p
  notify()
}

/** 当前登录用户（菜单里「最近修改」的本地即时记录署名用）；未登录 null */
export function selfPerson(): Person | null {
  return self
}

/** 当前登录用户 id（编辑器内新写的用户消息记发言人用）；未登录 '' */
export function selfId(): string {
  return self?.id ?? ''
}

/** 某空间里的某人；自己永远取登录态（换头像立即可见）。成员没取到时先回 null 并发起取数，到了 subscribePeople 通知 */
export function personOf(spaceId: string | null, userId: string): Person | null {
  if (!userId) return null
  if (self && userId === self.id) return self
  if (!spaceId) return null
  const members = spaces.get(spaceId)
  if (members === undefined) load(spaceId)
  return members?.get(userId) ?? null
}

/** 某空间的全部成员（`@` 大菜单的「成员」分类）。没取过就发起取数并先回 null，到了 subscribePeople 通知 */
export function spaceMembers(spaceId: string): Person[] | null {
  const members = spaces.get(spaceId)
  if (members === undefined) load(spaceId)
  return members ? [...members.values()] : null
}

/** 等某空间的成员取到（已有直接 resolve；失败也 resolve，当作没有成员） */
export function loadSpaceMembers(spaceId: string): Promise<void> {
  if (spaces.get(spaceId) === undefined) load(spaceId)
  return inflight.get(spaceId) ?? Promise.resolve()
}

function load(spaceId: string): void {
  spaces.set(spaceId, null)
  const req = api
    .listSpaceMembers(spaceId)
    .then((list) => {
      spaces.set(spaceId, new Map(list.map((m) => [m.user_id, { id: m.user_id, username: m.username, avatar: m.avatar ?? null }])))
      notify()
    })
    .catch((err: unknown) => {
      // 没权限 / 网络失败：当作没有成员（中性头像），不反复重试，刷新页面再取
      console.error(err)
      spaces.set(spaceId, new Map())
    })
    .finally(() => inflight.delete(spaceId))
  inflight.set(spaceId, req)
}

export function subscribePeople(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export type AvatarLook =
  | { kind: 'image'; src: string; title: string }
  | { kind: 'initial'; text: string; color: string; title: string }
  | { kind: 'none' }

/** 头像怎么画（DOM 与 React 两个渲染器共用这一份） */
export function avatarLook(person: Person | null): AvatarLook {
  if (!person) return { kind: 'none' }
  if (person.avatar) return { kind: 'image', src: `/api/files/${person.avatar}/icon`, title: person.username }
  const text = Array.from(person.username.trim())[0]?.toUpperCase() ?? '?'
  return { kind: 'initial', text, color: cursorIdentity(person.username).color, title: person.username }
}

/** 头像变化的身份串：放进 widget key，头像 / 名字变了 DOM 才重建 */
export function avatarKey(person: Person | null): string {
  return person ? `${person.id}:${person.avatar ?? ''}:${person.username}` : '?'
}

/** 把头像画进一个已有的底托元素（非 React 宿主：对话气泡）。底托自己管尺寸与圆角，这里只填内容 */
export function fillAvatar(plate: HTMLElement, person: Person | null): void {
  const look = avatarLook(person)
  plate.classList.add('avatar', `is-${look.kind}`)
  plate.replaceChildren()
  if (look.kind === 'image') {
    const img = document.createElement('img')
    img.src = look.src
    img.alt = ''
    img.draggable = false
    plate.title = look.title
    plate.append(img)
  } else if (look.kind === 'initial') {
    plate.textContent = look.text
    plate.style.setProperty('--avatar-bg', look.color)
    plate.title = look.title
  } else {
    plate.innerHTML = iconSvg('user', 15)
  }
}
