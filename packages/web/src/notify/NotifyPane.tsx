/* ---------- 设置 → 通知：这台设备的开关、走哪条通道、测试 ----------
 * 状态全在 push-client.ts 的 store 里，这里只画；开关的打开必须由点击直接触发（浏览器只在用户操作时弹权限请求）。 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { COPY } from '../copy'
import { Card, Row, Switch } from '../ui/form-kit'
import { disableNotify, enableNotify, refreshNotifyStatus, sendTest, useNotifyState } from './push-client'

const C = COPY.notify

export function NotifyPane({ onNavigate }: { onNavigate?: () => void }) {
  const st = useNotifyState()
  const navigate = useNavigate()
  const [test, setTest] = useState<{ busy: boolean; text: string; error: boolean } | null>(null)
  useEffect(() => refreshNotifyStatus(), [])

  // 开关受浏览器能力约束：不是 https / iOS 没装到主屏幕 / 不支持时不能开
  const blocked = st.reason === 'insecure' || st.reason === 'ios-install' || st.reason === 'unsupported'
  const on = st.enabled && st.channel !== 'off'
  const detail = st.reason === 'push-unavailable' ? st.subscribeError : st.reason === 'push-failing' ? st.serverError : null

  const toggle = (next: boolean): void => {
    setTest(null)
    void (next ? enableNotify() : disableNotify())
  }

  const runTest = async (): Promise<void> => {
    setTest({ busy: true, text: C.testing, error: false })
    const res = await sendTest((url) => {
      onNavigate?.()
      navigate(url)
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    setTest(res.ok ? { busy: false, text: C.testOk, error: false } : { busy: false, text: res.error, error: true })
  }

  return (
    <Card title={C.card}>
      <Row label={C.toggle} desc={C.toggleDesc}>
        <Switch checked={on} onChange={(v) => !st.busy && !blocked && toggle(v)} label={C.toggle} />
      </Row>
      <Row
        label={C.state}
        desc={
          <>
            {C.reason[st.reason]}
            {detail && (
              <>
                <br />
                {C.detail(detail)}
              </>
            )}
          </>
        }
      />
      {st.channel !== 'off' && (
        <Row label={C.test} desc={test ? <span className={test.error ? 'admin-form-error' : undefined}>{test.text}</span> : undefined}>
          <button type="button" className="admin-btn" disabled={test?.busy} onClick={() => void runTest()}>
            {C.test}
          </button>
        </Row>
      )}
    </Card>
  )
}
