// 全宽：页面属性 pages.full_width，协作者与公开页同看（服务端写了就广播，各端重拉页面树）。
// 切换时先按本地意图排版（乐观）、FLIP 把正文列从旧位置滑过去；pages 重拉对上了就撤掉本地意图、
// 以服务端为准（别人切的也就跟着变）；写失败退回并提示。列宽本身全在 CSS（.editor-page.full-width）。

import { useEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { api, type Page } from '../api'
import { COPY } from '../copy'
import { flip } from '../motion'

type Pending = { id: string; on: boolean }

export function useFullWidth(
  page: Page | null,
  pageEl: RefObject<HTMLElement | null>,
  onChanged: () => void,
): [boolean, (on: boolean) => void] {
  const [pending, setPending] = useState<Pending | null>(null)
  const saved = page?.full_width === true
  const mine = pending !== null && pending.id === page?.id
  useEffect(() => {
    if (mine && pending.on === saved) setPending(null)
  }, [mine, pending, saved])

  const apply = (next: Pending | null) => {
    const el = pageEl.current
    if (el) flip([el], () => flushSync(() => setPending(next)))
    else setPending(next)
  }
  const toggle = (on: boolean) => {
    if (!page) return
    apply({ id: page.id, on })
    api.setFullWidth(page.id, on).then(onChanged, (err: unknown) => {
      console.error('set full width failed:', err)
      apply(null)
      window.alert(COPY.top.fullWidthFailed)
    })
  }
  return [mine ? pending.on : saved, toggle]
}
