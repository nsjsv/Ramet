// ---------- 随手 AI：把草稿写清楚（对话输入框 / 文档里的 `>>` 草稿）----------
// 只改草稿，不发送，一步可撤销。指令固定（不弹输入框），状态条锚在输入卡 / 草稿旁，
// 流式生成完成后整段换掉草稿（宿主的一次事务）。生成期间草稿被改了就不替换，不冲掉刚打的字。
// 宿主只需给：读草稿（记号文字，chip 落成 `@[名字](agent:…)` 这类记号）、整段换成新文字、锚点。

import { COPY } from '../copy'
import { needsSettings, quickReadiness, streamQuick } from '../quick-api'
import { openSettings } from '../settings-bus'
import { QuickPopover } from './quick-popover'

export interface DraftHost {
  /** 草稿当前的记号文字 */
  get(): string
  /** 整段换成 text（宿主负责单事务 + 升 chip）。草稿已经不在了返回 false */
  set(text: string): boolean
  /** 状态条锚在哪（视口坐标） */
  anchor(): DOMRect | null
}

/** 同一时刻只整理一份草稿：再按 ⌘J 不叠加 */
let active: (() => void) | null = null

export function rewriteDraft(host: DraftHost): void {
  if (active) return
  const original = host.get()
  if (!original.trim()) return
  const ctrl = new AbortController()
  const pop = new QuickPopover({
    input: false,
    anchor: host.anchor,
    onClose: finish,
    onSettings: () => {
      finish()
      openSettings('quick')
    },
  })
  function finish(): void {
    ctrl.abort()
    pop.destroy()
    if (active === finish) active = null
  }
  active = finish
  pop.setPhase({ kind: 'running' })

  void (async () => {
    const ready = await quickReadiness()
    if (ctrl.signal.aborted) return
    if (!ready.ok) {
      pop.setPhase({ kind: 'error', message: ready.message, settings: true })
      return
    }
    let result = ''
    const out = await streamQuick({ kind: 'composer', instruction: COPY.quick.composerInstruction, text: original }, (d) => (result += d), ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!out.ok) {
      pop.setPhase({ kind: 'error', message: out.message, settings: needsSettings(out.code) })
      return
    }
    // 草稿已经不在了（切页 / 发走了）就悄悄收掉；生成期间被改过则不覆盖，说明原因
    const now = host.get()
    if (!now.trim()) {
      finish()
      return
    }
    if (now !== original) {
      pop.setPhase({ kind: 'error', message: COPY.quick.composerStale })
      return
    }
    const text = result.trim()
    if (text && host.set(text)) finish()
    else pop.setPhase({ kind: 'error', message: COPY.quick.errInterrupted })
  })()
}
