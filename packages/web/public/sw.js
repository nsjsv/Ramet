/* ---------- Ramet 的 service worker：只管系统通知（推送 + 点击），不拦任何请求 ----------
 * 不加 fetch 处理：页面、接口照旧直连服务器，发版不会被旧缓存卡住。
 * 推送内容由服务端组好（packages/shared/src/inbox-notice.ts）：{ title, body, url, tag }。
 * 页面自己弹的桌面通知（推送用不了时的兜底）也走 registration.showNotification，点击同样落到这里。 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  // 收到推送必须弹一条：Safari 对「收到却不显示」会撤销订阅，Chrome 会自己弹一条「网站在后台更新了」
  const title = typeof data.title === 'string' && data.title ? data.title : 'Ramet'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' && data.tag ? data.tag : undefined,
      icon: '/icon-192.png',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/inbox' },
    }),
  )
})

/** 有已开的 Ramet 窗口：有焦点的优先，再可见的，再随便一个；聚焦后让页面自己跳（站内路由，不整页刷新）。没有就新开 */
async function openUrl(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const top = windows.filter((c) => c.frameType !== 'nested')
  const target = top.find((c) => c.focused) || top.find((c) => c.visibilityState === 'visible') || top[0]
  if (target) {
    await target.focus().catch(() => undefined)
    target.postMessage({ type: 'ramet:open', url })
    return
  }
  await self.clients.openWindow(url)
}

self.addEventListener('notificationclick', (event) => {
  // 安卓点了不会自己关
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/inbox'
  event.waitUntil(openUrl(url))
})

/** 浏览器换了订阅（过期 / 轮换）：用新的重新登记、注销旧的。同源 fetch 带着登录 cookie；没登录就算了，下次打开页面会补登 */
self.addEventListener('pushsubscriptionchange', (event) => {
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription
      if (!sub) {
        const res = await fetch('/api/push/key')
        if (!res.ok) return
        const { publicKey } = await res.json()
        const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'))
        const key = Uint8Array.from(raw, (c) => c.charCodeAt(0))
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      }
      const json = sub.toJSON()
      await post('/api/push/subscriptions', { endpoint: json.endpoint, keys: json.keys })
      if (event.oldSubscription && event.oldSubscription.endpoint !== json.endpoint) {
        await post('/api/push/unsubscribe', { endpoint: event.oldSubscription.endpoint })
      }
    })().catch(() => undefined),
  )
})
