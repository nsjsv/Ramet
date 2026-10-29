// ---------- 终端的权威屏幕：connector 上一个不渲染的 xterm 内核，重新打开网页时据它还原 ----------
// 每个终端一个。pty 的全部输出都喂给它（与回放缓冲同一处：PtyManager.flush），它时刻知道屏幕现在是什么样。
// 网页全新打开、或断得太久回放缓冲接不上时，attach 发它的快照（@xterm/addon-serialize 序列化成可以原样写回的转义序列：
// 内容、颜色、光标、备用屏、终端模式，外加 SNAPSHOT_SCROLLBACK 行滚动历史），不再重放字节流，
// 不管之前刷过多少输出、开没开过 vim 都能还原成一模一样。只在 connector 进程里加载（pty.ts 引用），中心不加载。
//
// 不变量：
//   - 快照与 seq 严格对齐。xterm 的 write 是异步解析的，一次 write 的回调触发后下一段可能在同一轮里已被解析掉一部分，
//     所以不能等回调再序列化，而是在一个空 write 的回调里面同步序列化：此刻恰好解析完它之前写入的全部、
//     之后写入的一个字节都还没动，快照内容就是 seq ≤ 调用时 fedSeq 的全部输出。
//   - 尺寸变化也排进同一条写入队列（空 write 的回调里 resize）：与输出的先后关系和真实终端一致。
//   - 它对查询（光标位置、设备属性等）生成的应答不转给 shell：网页上的 xterm 已经答过一次，再答就重复了。

import headless from '@xterm/headless'
// 直接导入包里的 JS 文件（类型见同目录 addon-serialize.d.ts 的说明：避开官方声明带进来的 DOM 类型）
import serialize from '@xterm/addon-serialize/lib/addon-serialize.js'
import { SNAPSHOT_SCROLLBACK, type PtySnapshot } from '../agents/pty-types.js'

// 两个包都是 CommonJS（webpack 打的包，没有 exports 字段）：ESM 里只能默认导入再取
const { Terminal } = headless
const { SerializeAddon } = serialize

export class PtyScreen {
  private readonly term: InstanceType<typeof Terminal>
  private readonly addon: InstanceType<typeof SerializeAddon>
  /** 最后喂进去的那一块输出的 seq（还没有输出 = -1） */
  private fedSeq = -1
  private disposed = false
  /** 等着回调的快照：终端被关时一并失败，别让 attach 挂到超时 */
  private readonly waiting = new Set<(err: Error) => void>()

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: SNAPSHOT_SCROLLBACK, allowProposedApi: true })
    this.addon = new SerializeAddon()
    // 插件本来是给 @xterm/xterm 的 Terminal 写的；运行时它只用两者共有的 buffer / modes / options（官方支持 headless）
    this.term.loadAddon(this.addon as Parameters<typeof this.term.loadAddon>[0])
  }

  /** 一块输出（PtyManager 合并后的块，seq 递增） */
  feed(seq: number, data: string): void {
    if (this.disposed) return
    this.fedSeq = seq
    this.term.write(data)
  }

  /** pty 改了尺寸：排在已写入的输出之后生效 */
  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.term.write('', () => {
      if (!this.disposed) this.term.resize(cols, rows)
    })
  }

  /** 此刻的屏幕（含调用之前喂进来的全部输出，不含之后的） */
  snapshot(): Promise<PtySnapshot> {
    const seq = this.fedSeq
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error('这个终端已经关闭'))
      this.waiting.add(reject)
      this.term.write('', () => {
        if (!this.waiting.delete(reject)) return // dispose 已经让它失败了
        resolve({
          seq,
          cols: this.term.cols,
          rows: this.term.rows,
          data: this.addon.serialize({ scrollback: SNAPSHOT_SCROLLBACK }),
        })
      })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const reject of this.waiting) reject(new Error('这个终端已经关闭'))
    this.waiting.clear()
    this.term.dispose()
  }
}
