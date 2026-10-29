/** 复制文本到剪贴板，返回是否成功。navigator.clipboard 只在安全上下文（HTTPS / localhost）存在，
 * HTTP 部署下为 undefined，兜底走隐藏 textarea + execCommand('copy')。 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限拒绝等：继续走兜底
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed' // 不产生滚动跳动
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
