// ---------- 反向链接面板（页面底部） ----------
// 哪些页面 / 块引用了本页：服务端从正文已有的引用派生（@ 页面、块提及、同步块、站内链接），只列此人看得见的来源。
// 没有反链就不画。每条给来源页标题和引用所在块的当前文字，点块跳过去并定位。
// 换页、窗口回到前台（距上次 ≥ 30 秒）各拉一次，不随页面列表广播刷新（服务端要读来源页正文）。

import { useEffect, useState } from 'react'
import { api, type Backlink } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'

const REFRESH_MS = 30_000

export default function BacklinksPanel({ pageId, onNavigate }: { pageId: string; onNavigate: (to: string) => void }) {
  const [data, setData] = useState<{ backlinks: Backlink[]; total: number } | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    let last = 0
    setData(null)
    const load = (): void => {
      last = Date.now()
      api
        .backlinks(pageId)
        .then((res) => {
          if (!cancelled) setData(res)
        })
        .catch((err: unknown) => console.error(COPY.backlinks.loadFailed, err))
    }
    load()
    const onFocus = (): void => {
      if (document.visibilityState !== 'hidden' && Date.now() - last >= REFRESH_MS) load()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [pageId])

  if (!data || data.total === 0) return null
  return (
    <section className="backlinks" aria-label={COPY.backlinks.title}>
      <button type="button" className="bl-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={10} className={open ? 'bl-chev is-open' : 'bl-chev'} />
        <span>{COPY.backlinks.title}</span>
        <span className="bl-count">{COPY.backlinks.count(data.total)}</span>
      </button>
      {open && (
        <div className="bl-list">
          {data.backlinks.map((page) => (
            <div className="bl-page" key={page.pageId}>
              <button type="button" className="bl-title" onClick={() => onNavigate(`/page/${page.pageId}`)}>
                <Icon name="file" size={13} />
                {page.title || COPY.untitled}
              </button>
              {page.blocks
                .filter((b) => b.blockId)
                .map((b) => (
                  <button
                    type="button"
                    className="bl-block"
                    key={`${b.blockId}:${b.kind}:${b.targetBlockId}`}
                    onClick={() => onNavigate(`/page/${page.pageId}?block=${b.blockId}`)}
                  >
                    <span className="bl-kind">{COPY.backlinks.kind[b.kind]}</span>
                    <span className="bl-text">{b.text || COPY.untitled}</span>
                  </button>
                ))}
            </div>
          ))}
          {data.total > data.backlinks.length && <div className="bl-more">{COPY.backlinks.more(data.total - data.backlinks.length)}</div>}
        </div>
      )}
    </section>
  )
}
