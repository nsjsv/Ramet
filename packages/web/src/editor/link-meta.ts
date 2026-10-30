// 网页元信息（标题 / 描述 / 预览图 / 站点图标）的取数与缓存：书签卡（bookmark.ts）与行内网页提及（link-mention.ts）共用。
// 元信息不进文档，渲染时向服务端要（server link-preview.ts 现抓、只放内存）；同一地址在一个会话里只要一次
// （模块级缓存，协同重渲 / 多处出现 / 卡片与提及之间都复用）。图片直接外链，不经本站。

import type { LinkMeta } from '../api'

export type FetchLinkMeta = (url: string) => Promise<LinkMeta>

// 键 = 取数通道 + 地址：登录端点与公开端点的结果不混用
const metaCache = new Map<string, Promise<LinkMeta | null>>()

/** scope 区分取数通道（'auth' / 'public:<页面 id>'）；失败记成 null（只显示链接） */
export function metaOf(scope: string, url: string, fetchMeta: FetchLinkMeta): Promise<LinkMeta | null> {
  const key = `${scope}\n${url}`
  let hit = metaCache.get(key)
  if (!hit) {
    hit = fetchMeta(url).catch(() => null)
    metaCache.set(key, hit)
  }
  return hit
}

/** 元信息里没有图标（站点拒绝抓取 / 挂了，服务端只回了地址）时的退路：让浏览器直接加载站点根目录的 favicon。
 * 这是普通的图片加载，不经本站；加载失败由 remoteImg 的 onFail 摘掉 */
export function iconOf(meta: LinkMeta, url: string): string | undefined {
  if (meta.icon) return meta.icon
  try {
    return new URL('/favicon.ico', url).href
  } catch {
    return undefined
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** 外链图片：不带 Referer（不把页面地址给第三方，也绕开按 Referer 的防盗链）；加载失败交给 onFail 摘掉 */
export function remoteImg(src: string, cls: string, onFail: (img: HTMLImageElement) => void): HTMLImageElement {
  const img = el('img', cls)
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  img.addEventListener('error', () => onFail(img), { once: true })
  img.src = src
  return img
}
