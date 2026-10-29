/* ---------- collab ws 地址推导（Editor.tsx / editor/block-sync.ts 共用） ----------
 * 放在独立小模块而不是从 Editor.tsx export：block-sync.ts 被 Editor.tsx 引用，反向 import 组件模块会成环。 */

/** dev 走 vite proxy，prod 同源直连：一律由 location.host 推导 */
export function collabUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/collab`
}
