/* ---------- 发版提示 ----------
 * 部署后右下角弹「已更新」，点了才刷新；不点也照常编辑、切页面：部署时上一版的 assets 会硬链进新 release，
 * 旧标签页按需加载的 chunk 还拉得到。
 * 版本号是构建时 index.html 的内容哈希（vite.config.ts 的 buildVersion）：本页的在 <meta name="ramet-build">，
 * 线上最新的在 /version.json。dev 没有 meta，整个组件不工作。
 * 什么时候查：control 通道（重）连上（部署会重建 web 容器，连接必断一次）、标签页回到前台、前台时每 5 分钟。 */

import { useEffect, useState } from 'react'
import { listenControl } from './control'
import { COPY } from './copy'
import { Icon } from './icons'

const CURRENT = document.querySelector<HTMLMetaElement>('meta[name="ramet-build"]')?.content
const POLL_MS = 5 * 60_000
/** 两次检查的最小间隔：切标签页很频繁，没必要每次都打一下 */
const MIN_GAP_MS = 10_000

async function latestBuild(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: unknown }
    return typeof data.id === 'string' && data.id ? data.id : null
  } catch {
    return null // 断网 / 部署中途拿到半截：下次再查
  }
}

export default function UpdateNotice() {
  /** 线上比本页新的那个版本；null = 没有新版 */
  const [latest, setLatest] = useState<string | null>(null)
  /** 点了「稍后」的版本：同一个版本不再弹，再发一版照弹 */
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (!CURRENT) return
    let last = 0
    let busy = false
    const check = async (): Promise<void> => {
      if (busy || Date.now() - last < MIN_GAP_MS) return
      busy = true
      last = Date.now()
      const id = await latestBuild()
      busy = false
      // 回滚到本页这一版时收起提示
      if (id) setLatest(id === CURRENT ? null : id)
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    const timer = window.setInterval(onVisible, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    const off = listenControl((ev) => {
      if (ev === 'sync') void check()
    })
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      off()
    }
  }, [])

  if (!latest || latest === dismissed) return null
  return (
    <div className="update-notice pop-card" role="status">
      <button className="update-notice-main" onClick={() => location.reload()}>
        <Icon name="refresh" />
        <span className="update-notice-text">
          <span className="update-notice-title">{COPY.update.title}</span>
          <span className="update-notice-hint">{COPY.update.hint}</span>
        </span>
      </button>
      <button
        className="update-notice-close"
        title={COPY.update.later}
        aria-label={COPY.update.later}
        onClick={() => setDismissed(latest)}
      >
        <Icon name="x" />
      </button>
    </div>
  )
}
