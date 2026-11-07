/* ---------- 设置 → Genet：模型框下面那一行 ----------
 * 这个模型在公开模型目录（models.dev）里的上下文 / 输出上限，以及 Genet 输入框旁会给的思考档位。
 * 档位由服务端按与 chip 同一份判定算好（GET /api/me/model-spec），这里只负责显示，不另写一套规则。
 * 表单还没保存也能看：跟着类型 / 地址 / 模型变，地址边打边问会刷屏，停 300ms 再问；地址不合法（400）就不显示。 */
import { useEffect, useState } from 'react'
import { COPY } from './copy'
import { quickApi, type ModelSpecView, type Protocol } from './quick-api'

const C = COPY.quickSettings
const DEBOUNCE_MS = 300

/** 1000000 → 1M，384000 → 384K（与服务端 chip 说明同一写法） */
function tokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

function describe(view: ModelSpecView): string {
  // 「默认」= 不发思考参数，不算一档
  const levels = view.thinking.filter((v) => v.value !== 'default').map((v) => v.name)
  const thinking = levels.length > 0 ? C.specThinking(levels.join(' / ')) : C.specNoThinking
  const m = view.match
  if (!m) return `${view.catalog ? C.specMissing : C.specOffline} · ${thinking}`
  return [m.context && C.specContext(tokens(m.context)), m.output && C.specOutput(tokens(m.output)), thinking, !m.exact && C.specByName]
    .filter(Boolean)
    .join(' · ')
}

export function ModelSpecHint({ protocol, baseUrl, model }: { protocol: Protocol; baseUrl: string; model: string }) {
  const [view, setView] = useState<ModelSpecView | null>(null)
  useEffect(() => {
    setView(null)
    if (!model) return
    let alive = true
    const timer = setTimeout(() => {
      quickApi.modelSpec({ protocol, baseUrl: baseUrl.trim(), model }).then(
        (v) => alive && setView(v),
        () => undefined, // 地址还没填对 / 网络抖动：这一行只是参考，不报错
      )
    }, DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [protocol, baseUrl, model])
  if (!view) return null
  return (
    <small data-tip={view.match && !view.match.exact ? C.specByNameTip : C.specTip}>
      {describe(view)}
    </small>
  )
}
