/* ---------- control:global 信令通道 ----------
 * 服务端往这个无内容文档 broadcastStateless 几类事件：
 *   'changed'  页面 / 空间写库成功（树、空间列表要重拉）
 *   'agents'   agent 目录变了（connector 上线 / 下线；catalog = 本机配置 + 在线 connector）
 *   'inbox'    收件箱里有东西可能变了（审批 / 回合 / 使用申请 / 机器接入…），服务端 300ms 去抖，不带内容，只通知去重拉
 *   'memories' 空间公共记忆被增删（不带 spaceId / 内容，记忆面板收到后重拉当前空间）
 *   'boards'   目录树结构变了（目录 / 挂载增删改、挂着的页被恢复），只重拉目录树列表
 * 客户端据此失效各自的缓存。这条连接全局只开一份：App（刷侧栏树）、agent 目录（失效缓存）、
 * 设置弹窗（刷连接器在线态）订同一条，各开一条 ws 是白费带宽。
 * 另有本地事件 'sync'：(重)连上时发一次，补拉断线期间错过的广播。
 * 端口预览的共享列表变了（`previews:<pageId>`）单独走 subscribePreviews，不进上面的事件，老订阅方不会因此多刷一次树 / 目录。 */

import { HocuspocusProvider } from '@hocuspocus/provider'
import { collabUrl } from './editor/collab-url'

export type ControlEvent = 'changed' | 'agents' | 'inbox' | 'memories' | 'boards' | 'sync'

const listeners = new Set<(ev: ControlEvent) => void>()
/** 旁听者：不让连接因它而建立 / 保持（见 listenControl） */
const bystanders = new Set<(ev: ControlEvent) => void>()
/** 端口预览：参数 = 哪个页面的预览列表变了；null = 不知道哪个（重连补拉），都当变了 */
const previewListeners = new Set<(pageId: string | null) => void>()
let provider: HocuspocusProvider | undefined

/** 无人订阅时断开连接（App 常驻订阅，实际长期在线） */
export function subscribeControl(cb: (ev: ControlEvent) => void): () => void {
  listeners.add(cb)
  if (!provider) {
    const p = new HocuspocusProvider({ url: collabUrl(), name: 'control:global' })
    // 未知 payload 一律当 'changed'（宁可多刷树也不漏）
    p.on('stateless', ({ payload }: { payload: string }) => {
      if (payload.startsWith('previews:')) {
        for (const l of previewListeners) l(payload.slice('previews:'.length))
        return
      }
      const known: ControlEvent[] = ['agents', 'inbox', 'memories', 'boards']
      emit(known.find((ev) => ev === payload) ?? 'changed')
    })
    p.on('synced', () => {
      emit('sync')
      for (const l of previewListeners) l(null)
    })
    provider = p
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      provider?.destroy()
      provider = undefined
    }
  }
}

/** 订阅「某个页面的预览列表变了」。和 subscribeControl 共用同一条连接 */
export function subscribePreviews(cb: (pageId: string | null) => void): () => void {
  previewListeners.add(cb)
  const off = subscribeControl(() => undefined)
  return () => {
    previewListeners.delete(cb)
    off()
  }
}

/** 旁听：只在别人（App）开着连接时收事件，自己不建连接。发版检查用它接 'sync'——部署会重建 web 容器，
 * 连接必断一次再重连；登录页 / 公开页不该为它多开一条 ws */
export function listenControl(cb: (ev: ControlEvent) => void): () => void {
  bystanders.add(cb)
  return () => bystanders.delete(cb)
}

function emit(ev: ControlEvent): void {
  for (const l of listeners) l(ev)
  for (const l of bystanders) l(ev)
}
