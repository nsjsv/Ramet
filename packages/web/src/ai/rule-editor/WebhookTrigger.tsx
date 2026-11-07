/* ---------- 规则编辑器：「收到外部请求」的触发表单 + 只显示一次的地址 ----------
 * 地址（/api/hooks/<密钥>）由服务端生成，库里只有哈希：建好 / 换地址时的响应里给一次，这里拼上站点的源显示出来；
 * 之后只显示末 4 位（config.hint）。换地址先确认（旧地址立刻失效）。 */
import { useState } from 'react'
import { copyText } from '../../clipboard'
import { COPY } from '../../copy'
import { confirmDialog } from '../../ui/dialog'
import { toastError } from '../../ui/toast'
import { automationApi } from '../automation-api'
import type { TriggerFormProps } from './triggers'

const H = COPY.ai.rule.webhook

export type WebhookDraft = { hint: string }

export const defaultWebhookDraft = (): WebhookDraft => ({ hint: '' })

export function webhookDraftOf(config: unknown): WebhookDraft {
  const hint = (config as { hint?: unknown } | null)?.hint
  return { hint: typeof hint === 'string' ? hint : '' }
}

export function WebhookTrigger({ draft, ruleId, onReveal }: TriggerFormProps<WebhookDraft>) {
  const [busy, setBusy] = useState(false)

  async function rotate(): Promise<void> {
    if (!ruleId || busy) return
    if (!(await confirmDialog({ message: H.rotateConfirm, danger: true, confirmLabel: H.rotate }))) return
    setBusy(true)
    try {
      const out = await automationApi.rotateHook(ruleId)
      onReveal(out.hookPath, out.automation)
    } catch (err) {
      toastError(err, H.rotateFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rule-event">
      {ruleId && (
        <div className="rule-field">
          <span>{H.address}</span>
          <div className="rule-hook-line">
            <span className="rule-muted">{H.hint(draft.hint || '????')}</span>
            <button type="button" className="admin-btn" disabled={busy} onClick={() => void rotate()}>
              {busy ? H.rotating : H.rotate}
            </button>
          </div>
        </div>
      )}
      <p className="rule-muted">{H.note}</p>
      <p className="rule-muted">{H.limits}</p>
    </div>
  )
}

/** 完整地址只显示这一次：复制 + 一行 curl 示例 */
export function HookReveal({ hookPath }: { hookPath: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}${hookPath}`
  const curl = `curl -X POST '${url}' -H 'content-type: application/json' -d '{"msg":"hello"}'`
  return (
    <div className="rule-reveal">
      <p className="rule-reveal-title">{H.revealTitle}</p>
      <p className="rule-muted">{H.revealHint}</p>
      <div className="rule-reveal-url">
        <code>{url}</code>
        <button type="button" className="admin-btn" onClick={() => void copyText(url).then((ok) => setCopied(ok))}>
          {copied ? H.copied : H.copy}
        </button>
      </div>
      <span className="rule-muted">{H.curl}</span>
      <pre className="rule-reveal-curl">{curl}</pre>
    </div>
  )
}
