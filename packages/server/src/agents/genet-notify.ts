// ---------- 往 Genet 页尾写一块并叫醒 Genet（任务回报与定时触发共用的唯一实现） ----------
// 写的是 user_message（带 notice 属性），不是新节点：runTurn 取「最后一条用户消息」当这一轮的输入、seen 增量、排队 continue 都直接可用。
// 写之前按发起人现查身份重判权限（Genet 页可写、Genet 可用），同排队派发：不替失权的人跑；不能写就返回原因，什么都不写、也不叫醒。
// 同一个 Genet 页上的写入排成一条链：两件事同时到时，「已经有排队项就不再排」（SendQueue.wake）的判断才不会被并发穿过去。

import type * as Y from 'yjs'
import type { Pool } from 'pg'
import type { DocWriter } from '../collab.js'
import { ASSISTANT_ID } from './assistant-agent.js'
import type { QueueHost, SendQueue } from './send-queue.js'

export type GenetNotifyDeps = {
  pool: Pool
  host: Pick<QueueHost, 'writable' | 'usable'>
  queue: Pick<SendQueue, 'wake'>
  writeDoc?: DocWriter
}

export class GenetNotify {
  private chains = new Map<string, Promise<unknown>>()

  constructor(private deps: GenetNotifyDeps) {}

  /** 在 home（Genet 页）末尾插 build 出来的一块，再叫醒 Genet。写不了 = 原因（没写、没叫醒），写好了 = null */
  async post(home: string, userId: string, build: (fragment: Y.XmlFragment) => Y.XmlElement): Promise<string | null> {
    const prev = this.chains.get(home) ?? Promise.resolve()
    // 前一件失败了也不能挡住这一件
    const next = prev.catch(() => undefined).then(() => this.write(home, userId, build))
    this.chains.set(home, next)
    try {
      return await next
    } finally {
      if (this.chains.get(home) === next) this.chains.delete(home)
    }
  }

  private async write(home: string, userId: string, build: (fragment: Y.XmlFragment) => Y.XmlElement): Promise<string | null> {
    const role = (await this.deps.pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId])).rows[0]?.role
    const user = role ? { id: userId, role } : null
    if (!user) return '发起人已经不在了'
    if (!this.deps.writeDoc) return '没有文档写入通道'
    if (!(await this.deps.host.writable(home, user))) return '发起人已经不能编辑 Genet 页了'
    const unusable = await this.deps.host.usable(home, user, ASSISTANT_ID)
    if (unusable) return unusable
    await this.deps.writeDoc(`page:${home}`, user, (doc, origin) =>
      doc.transact(() => {
        const frag = doc.getXmlFragment('prosemirror')
        frag.insert(frag.length, [build(frag)])
      }, origin),
    )
    await this.deps.queue.wake(home, user, ASSISTANT_ID)
    return null
  }
}
