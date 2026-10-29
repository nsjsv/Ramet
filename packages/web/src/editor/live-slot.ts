// 实时回复的挂载位（文档模式 AI 块与聊天气泡两个宿主共用的生命周期）。
// 判定「这个回复块现在归实时视图管吗」只有一处：
//   - 块的 id 等于 store 里正在跑的 run.replyId，且块的 stats 仍是 `o:run` → live（实时正文 + 状态条）
//   - 收尾事务到了（stats 变成终态）→ landing：真内容在原位渲染，状态条留着飞进用量标签，飞完摘掉
//   - run 从 store 消失而块仍是 `o:run`（服务端没收尾就断了）→ 交还普通渲染（标签显示「已中断」）
// 「一轮」的身份是 replyId + 本轮开始时刻（startedAt）：重试 / 重新生成复用同一个块 id，但是新的一轮，要重新挂一个实时视图。
// 宿主不可见（聊天 / 源码模式下的文档编辑器是 display:none）时不建控制器：同一时刻只有看得见的那份在画。
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { decodeStats } from '@ramet/shared/reply-stats'
import { agentStateFor, subscribeAgentEvents, type LiveRun } from './agent-bar'
import { createLiveReply, type LiveReply } from './live-reply'

export type LiveHit = { ctrl: LiveReply; phase: 'live' | 'landing' }

export class LiveSlot {
  private run: LiveRun | null
  private cur: { replyId: string; startedAt: number; ctrl: LiveReply; phase: 'live' | 'landing' | 'gone'; flying: boolean } | null = null
  /** 已经收回过的轮（replyId@startedAt）：store 里那轮还留着时不能再挂一次 */
  private finished = new Set<string>()
  private off: () => void

  constructor(private opts: { pageId: string; canStop: boolean; visible: () => boolean; onChange: () => void; rest: (replyId: string) => number }) {
    this.run = agentStateFor(opts.pageId).run
    this.off = subscribeAgentEvents(opts.pageId, (state) => {
      const next = state.run
      // 正文/条目的变化归控制器自己画；宿主只关心「换了一轮 / 结束了」
      const changed =
        next?.replyId !== this.run?.replyId || next?.startedAt !== this.run?.startedAt || next?.outcome !== this.run?.outcome
      this.run = next
      if (changed) opts.onChange()
    })
  }

  /** 宿主每次重算装饰时对每个回复块调用：null = 普通渲染 */
  attach(node: PMNode): LiveHit | null {
    const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    if (!id) return null
    const finalized = decodeStats(node.attrs.stats).o !== 'run'
    let cur = this.cur
    // 同一个块的下一轮（重试 / 重新生成）：旧轮的视图作废，下面按新一轮重新挂
    if (cur && cur.replyId === id && !finalized && this.run?.replyId === id && this.run.startedAt !== cur.startedAt) {
      this.release()
      cur = null
    }
    if (cur && cur.replyId === id) {
      if (cur.phase === 'gone') return null
      if (finalized) cur.phase = 'landing'
      else if (this.run?.replyId !== id) {
        this.release()
        return null
      }
      return { ctrl: cur.ctrl, phase: cur.phase === 'landing' ? 'landing' : 'live' }
    }
    const run = this.run
    if (finalized || !run || run.replyId !== id || this.finished.has(this.runKey(run)) || !this.opts.visible()) return null
    this.release()
    const ctrl = createLiveReply({
      pageId: this.opts.pageId,
      replyId: id,
      schema: node.type.schema,
      canStop: this.opts.canStop,
      rest: () => this.opts.rest(id),
    })
    this.cur = { replyId: id, startedAt: run.startedAt, ctrl, phase: 'live', flying: false }
    return { ctrl, phase: 'live' }
  }

  /** 收尾动画：宿主在真内容与用量标签渲染出来之后调（chip = 落点，可为 null） */
  land(chip: HTMLElement | null): void {
    const cur = this.cur
    if (!cur || cur.phase !== 'landing' || cur.flying) return
    cur.flying = true
    void cur.ctrl.land(chip).then(() => {
      if (this.cur !== cur) return
      cur.phase = 'gone'
      this.finished.add(`${cur.replyId}@${cur.startedAt}`)
      this.opts.onChange()
      cur.ctrl.dispose()
    })
  }

  dispose(): void {
    this.off()
    this.release()
  }

  private runKey(run: LiveRun): string {
    return `${run.replyId}@${run.startedAt}`
  }

  private release(): void {
    this.cur?.ctrl.dispose()
    this.cur = null
  }
}
