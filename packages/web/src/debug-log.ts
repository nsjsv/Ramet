// ---------- 客户端诊断上报 ----------
// 用途：排查"点了没反应"这类只在特定浏览器/设备上出现、服务端日志完全查不到的问题。
// 行为：页面带 ?diag=1（或 localStorage['ramet:diag']='1'）时才启用，采集
//   - 指针事件（capture 阶段）+ 该坐标上真正命中的元素（暴露遮罩/漂浮层）
//   - 焦点、按键、beforeinput/input（含 IME composition）
//   - window error / unhandledrejection
//   - 视口/DPR/UA 基线
// 缓冲后 POST /api/debug/client-log，服务端落 console（docker logs 可读）。

const BUFFER_LIMIT = 20
const FLUSH_MS = 3000
const MAX_TEXT = 60

type Line = string

let started = false
const buffer: Line[] = []
/** 本地环形缓冲：控制台可直接看（window.__rametDiag.dump()），不依赖服务端 */
const local: Line[] = []
let timer: number | undefined

function flush(): void {
  if (!buffer.length) return
  const lines = buffer.splice(0, buffer.length)
  void fetch('/api/debug/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lines }),
  }).catch(() => {
    // 上报失败不递归、不重试：丢的是诊断信息
  })
}

function push(line: Line): void {
  local.push(line)
  if (local.length > 200) local.splice(0, local.length - 200)
  buffer.push(line)
  if (buffer.length >= BUFFER_LIMIT) {
    window.clearTimeout(timer)
    flush()
    return
  }
  if (timer === undefined) timer = window.setTimeout(() => {
    timer = undefined
    flush()
  }, FLUSH_MS)
}

function describe(el: EventTarget | null): string {
  if (!(el instanceof Element)) return String(el)
  const id = el.id ? `#${el.id}` : ''
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${id}${cls}`
}

function clip(value: string | null | undefined): string {
  const text = (value ?? '').replace(/\s+/g, ' ')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

function onPointer(type: string, e: Event): void {
  const ev = e as PointerEvent
  const el = (e.target as Element | null)?.closest?.('.chat-input, .chat-send, .editor-root, .topbar, .modal, .sidebar') ?? null
  // 命中元素用 elementFromPoint 复核：与 target 不一致就是有东西盖在上面
  const hit = document.elementFromPoint(ev.clientX ?? 0, ev.clientY ?? 0)
  push(
    `${type} target=${describe(e.target)} near=${el ? describe(el) : '-'} at=${Math.round(ev.clientX ?? -1)},${Math.round(ev.clientY ?? -1)} hit=${describe(hit)}${hit === e.target ? '' : ' HIT-MISMATCH'} preventedNow=${String(ev.defaultPrevented)} buttons=${ev.buttons} detail=${ev.detail} path=${ev.composedPath().length}`,
  )
  // 事件走完全程后再看：preventedFinal=true 说明有处理器掐掉了默认行为（默认聚焦因此不发生）；
  // 再看焦点落点。两者一起才能区分「被 preventDefault」与「焦点被别处抢走」
  window.setTimeout(() => {
    push(
      `${type}+0ms preventedFinal=${String(ev.defaultPrevented)} cancelsFocus=${String(ev.defaultPrevented)} activeElement=${describe(document.activeElement)} docHasFocus=${String(document.hasFocus())} selection=${(() => { try { return clip(String(window.getSelection()?.toString?.() ?? '')) } catch { return '-' } })()}`,
    )
  }, 0)
}

function onFocus(type: string, e: Event): void {
  push(`${type} target=${describe(e.target)} active=${describe(document.activeElement)}`)
}

function onKey(e: KeyboardEvent): void {
  push(`keydown key=${e.key} mods=${e.ctrlKey ? 'c' : ''}${e.metaKey ? 'm' : ''}${e.altKey ? 'a' : ''} target=${describe(e.target)} composing=${String(e.isComposing)} defaultPrevented=${String(e.defaultPrevented)}`)
}

function onInput(e: Event): void {
  const el = e.target
  const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement | null)?.textContent
  push(`${e.type} target=${describe(el)} value="${clip(value)}" active=${describe(document.activeElement)}`)
}

function onComposition(e: CompositionEvent): void {
  push(`composition:${e.type} target=${describe(e.target)} data="${clip(e.data)}"`)
}

export function initClientDiagnostics(): void {
  if (started) return
  started = true
  // 环境基线：扩展注入的样式/滤镜（暗色扩展、翻译类插件会改这两处）、深浅色偏好
  const bodyStyle = getComputedStyle(document.body)
  push(
    `boot viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ua="${clip(navigator.userAgent)}" url=${location.pathname}${location.search}`,
  )
  push(
    `env styles=${document.querySelectorAll('style').length} links=${document.querySelectorAll('link[rel=stylesheet]').length} bodyFilter=${bodyStyle.filter || '-'} bodyOpacity=${bodyStyle.opacity} htmlFilter=${getComputedStyle(document.documentElement).filter || '-'} dark=${String(window.matchMedia('(prefers-color-scheme: dark)').matches)} hasFocus=${String(document.hasFocus())}`,
  )
  window.addEventListener('pointerdown', (e) => onPointer('pointerdown', e), true)
  window.addEventListener('mousedown', (e) => onPointer('mousedown', e), true)
  window.addEventListener('click', (e) => onPointer('click', e), true)
  window.addEventListener('focusin', (e) => onFocus('focusin', e), true)
  window.addEventListener('focusout', (e) => onFocus('focusout', e), true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('beforeinput', onInput, true)
  window.addEventListener('input', onInput, true)
  window.addEventListener('compositionstart', onComposition, true)
  window.addEventListener('compositionend', onComposition, true)
  window.addEventListener('error', (e) => push(`error message="${clip(e.message)}" src=${clip((e.filename ?? '') + ':' + e.lineno)}`), true)
  window.addEventListener('unhandledrejection', (e) => push(`unhandledrejection reason="${clip(String((e as PromiseRejectionEvent).reason))}"`), true)
  // 聚焦自测：程序化 focus 都失败 = 整个文档拿不到焦点（环境问题，不是这个输入框的问题）
  window.setTimeout(() => {
    const probe = document.createElement('input')
    probe.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(probe)
    probe.focus()
    push(`selftest programmaticFocus=${String(document.activeElement === probe)} docHasFocus=${String(document.hasFocus())} visibility=${document.visibilityState}`)
    probe.remove()
  }, 1500)
  // 控制台可直接看：__rametDiag.dump()
  ;(window as unknown as { __rametDiag?: unknown }).__rametDiag = {
    dump: () => local.slice(-80),
    lines: () => local.length,
  }
  // 页面隐藏/卸载前把剩下的写出去（含用户切走标签页的场景）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

/** 业务模块的诊断行（只在诊断开着时记，否则什么都不做）：例如文档 ⇄ 对话切换的配对 / 跳过原因（view-morph.ts） */
export function diagLog(line: string): void {
  if (started) push(line)
}

/** 是否启用：?diag=1 或 localStorage['ramet:diag']==='1'（默认关闭，不影响正常用户） */
export function diagnosticsEnabled(): boolean {
  try {
    if (new URLSearchParams(location.search).get('diag') === '1') {
      localStorage.setItem('ramet:diag', '1')
      return true
    }
    return localStorage.getItem('ramet:diag') === '1'
  } catch {
    return false
  }
}
