/* ---------- 输入卡里的 `/记住`：处理 + 轻提示 ----------
 * run(text, onDone)：text 是 `/记住 …` → 返回 true（已接手，调用方不要再当消息发）；成功后调 onDone（清输入框）并给一句轻提示，
 * 失败保留输入框（让人改了再试）并给原因。不是命令 → 返回 false，什么都不做。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { COPY } from '../copy'
import { parseRemember, remember } from './remember'

export type RememberHint = { text: string; error: boolean }

const HINT_MS = 3500

export function useRemember(spaceId: string | undefined | null, canWrite: boolean) {
  const [hint, setHint] = useState<RememberHint | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const busy = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const show = useCallback((next: RememberHint) => {
    window.clearTimeout(timer.current)
    setHint(next)
    timer.current = window.setTimeout(() => setHint(null), HINT_MS)
  }, [])

  const run = useCallback(
    (text: string, onDone: () => void): boolean => {
      const content = parseRemember(text)
      if (content === null) return false
      if (!canWrite) {
        show({ text: COPY.memory.command.readOnly, error: true })
        return true
      }
      if (busy.current) return true // 上一条还在路上：连按回车不重复记
      busy.current = true
      void remember(spaceId, content).then((res) => {
        busy.current = false
        if (res.ok) {
          onDone()
          show({ text: COPY.memory.command.saved, error: false })
        } else show({ text: res.message, error: true })
      })
      return true
    },
    [spaceId, canWrite, show],
  )

  return { hint, run }
}
