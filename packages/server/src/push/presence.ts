// ---------- 谁此刻正在用 Ramet（推送据此不打扰人）----------
// 浏览器每个标签页在 control:global 上报自己的状态：`presence:on` = 可见 + 有焦点 + 最近有操作，`presence:off` = 不是。
// 只在状态切换时发（以及连上 / 重连时发一次当前状态），几乎不占流量。
// 按连接（socketId）记，连接断了就删：死连接会被 Hocuspocus 的心跳断开，所以不需要过期时间。
// 只在进程内存里；重启后浏览器重连时会把当前状态再报一遍。
import type { Extension, onDisconnectPayload, onStatelessPayload } from '@hocuspocus/server'
import { CONTROL_DOC_NAME } from '../collab.js'

export const PRESENCE_ON = 'presence:on'
export const PRESENCE_OFF = 'presence:off'

export class Presence {
  /** socketId → 这条连接的用户、是否在用 */
  private readonly sockets = new Map<string, { userId: string; active: boolean }>()

  /** 这个人有没有哪个标签页正在用（任何一台设备） */
  isActive(userId: string): boolean {
    for (const s of this.sockets.values()) if (s.userId === userId && s.active) return true
    return false
  }

  extension(): Extension {
    return {
      onStateless: async ({ connection, documentName, payload }: onStatelessPayload) => {
        if (documentName !== CONTROL_DOC_NAME || (payload !== PRESENCE_ON && payload !== PRESENCE_OFF)) return
        const userId = (connection.context as { user?: { id?: string } } | undefined)?.user?.id
        if (!userId) return
        this.sockets.set(connection.socketId, { userId, active: payload === PRESENCE_ON })
      },
      onDisconnect: async ({ documentName, socketId }: onDisconnectPayload) => {
        if (documentName === CONTROL_DOC_NAME) this.sockets.delete(socketId)
      },
    }
  }
}
