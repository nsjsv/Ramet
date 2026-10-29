/* ---------- 图床回退 ----------
 * 站内文件地址 /api/files/<uuid>[/display|/icon] 在服务端可能 302 到 TG 图床（server/src/routes/files.ts）。
 * 图床那头加载失败（网络不通、Worker 配额用完、5xx）时，把这个元素的地址改成 ?direct=1，服务端恒本地出。
 * 挂在 window 的捕获阶段：资源加载的 error 不冒泡，但捕获阶段收得到，一处监听覆盖编辑器、公开页、页面图标、头像、灯箱。
 * 编辑器里的 <img> 在叶子节点 / widget 里（没有 contentDOM），改 src 不会被 PM 当成文档变更读回去。
 * 只看 src 属性（不看 currentSrc，跳转后那是图床地址）；已带 direct 的不再改：本地也坏了就是真坏了，不能来回打转。 */

const FILE_SRC_RE = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/display|\/icon)?$/i

/** 站内文件地址换成固定走源站的地址；不是站内文件地址（外链、已带查询串）返回 null */
export function directUrl(src: string): string | null {
  return FILE_SRC_RE.test(src) ? `${src}?direct=1` : null
}

export function installFileFallback(): void {
  window.addEventListener(
    'error',
    (event) => {
      const el = event.target
      if (!(el instanceof HTMLImageElement || el instanceof HTMLMediaElement || el instanceof HTMLSourceElement)) return
      const next = directUrl(el.getAttribute('src') ?? '')
      if (!next) return
      el.setAttribute('src', next)
      // <source> 改了地址不会自己重载，要父级媒体元素 load 一次
      if (el instanceof HTMLSourceElement && el.parentElement instanceof HTMLMediaElement) el.parentElement.load()
    },
    true,
  )
}
