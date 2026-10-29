import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { diagnosticsEnabled, initClientDiagnostics } from './debug-log'
import { installFileFallback } from './file-fallback'
import './styles.css'
import UpdateNotice from './UpdateNotice'
import { trackKeyboardInset } from './viewport'

// 客户端诊断：只在 ?diag=1 / localStorage['ramet:diag']='1' 时挂监听并上报（默认零开销）
if (diagnosticsEnabled()) initClientDiagnostics()

// 图床回退：站内图片从图床加载失败时改走源站（见 file-fallback.ts）
installFileFallback()

// 软键盘：把被键盘盖住的高度写进 --kb（iOS Safari 键盘不改布局视口，见 viewport.ts）
trackKeyboardInset()

// 按需加载的 chunk 拉不到（旧标签页还在要旧哈希的文件，而部署只保留近 14 天的旧产物）：刷新一次换成新版本。
// 平时发版只弹提示（UpdateNotice），走到这里说明标签页旧得超出了保留范围。
// 生产构建里源码的每个 import()（含 React.lazy、editor/lazy.ts、EmojiPicker、TermPane）都经 Vite 的 __vitePreload 包装，
// 失败时派发这个事件。10 秒内刷过一次就不再刷（真断网 / 新版本也拉不到时不死循环），错误照常抛出。
const RELOAD_KEY = 'ramet:chunk-reload'
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY))
    if (Date.now() - last < 10_000) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return // sessionStorage 不可用就记不住刷没刷过：宁可不刷，也不冒循环刷新的险
  }
  location.reload()
})

// 不用 StrictMode：dev 下双调用 effect 会重复建页/重复连 WS
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)

// 发版提示单独一个 root：App 渲染崩了（比如新旧接口对不上）整棵树会被卸掉，这时最需要它还在
const notice = document.createElement('div')
document.body.append(notice)
createRoot(notice).render(<UpdateNotice />)
