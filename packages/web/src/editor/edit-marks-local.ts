/* ---------- 「最近修改」的本地即时记录与远端改动后的缓存刷新（edit-marks-store.ts） ----------
 * 服务端改动停约 2s 才落库，自己刚打完字就点菜单的话只看服务端会先显示上一个人，所以本机用户的编辑当场记一笔：
 *   - 只认本机用户的事务：根事务（appended tr 追到 'appendedTransaction'）不是 ySync 灌进来的远端 / 首灌改动；
 *   - 只补块 id 的 AttrStep 不算（同服务端 edit-marks.ts 的口径）；
 *   - 改动范围映射到本轮最终文档再找块：排在补 id 插件之后，新建块这时已经有 id；
 *     范围所在的可寻址祖先和范围内的可寻址块都记（判定同 @ramet/shared/block-address，与服务端同一份）。
 * 远端改动（别人 / AI）停下 3s 后（服务端已落库）重拉一次，下次打开菜单就是新的。 */

import { $prose } from '@milkdown/kit/utils'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, type Transaction } from '@milkdown/kit/prose/state'
import { AttrStep } from '@milkdown/kit/prose/transform'
import { ySyncPluginKey } from 'y-prosemirror'
import { isAddressable } from '@ramet/shared/block-address'
import { noteLocalEdits, refreshEditMarks } from '../edit-marks-store'

const REMOTE_SETTLE_MS = 3000

function isRemote(tr: Transaction): boolean {
  const root = (tr.getMeta('appendedTransaction') as Transaction | undefined) ?? tr
  return !!(root.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
}

/** [from, to] 涉及的可寻址块 id：from 所在的可寻址祖先和范围内的可寻址块 */
function collect(doc: PMNode, from: number, to: number, out: Set<string>): void {
  const add = (node: PMNode, parentName: string | null): void => {
    const id: unknown = node.attrs.id
    if (typeof id === 'string' && id && isAddressable(node.type.name, parentName)) out.add(id)
  }
  const size = doc.content.size
  const a = Math.max(0, Math.min(from, size))
  const b = Math.max(a, Math.min(to, size))
  const $a = doc.resolve(a)
  for (let d = $a.depth; d > 0; d--) add($a.node(d), d === 1 ? null : $a.node(d - 1).type.name)
  if (b > a) {
    doc.nodesBetween(a, b, (node, _pos, parent) => {
      if (node.isBlock) add(node, !parent || parent === doc ? null : parent.type.name)
    })
  }
}

/** editable 表示本机能编辑（viewer 只刷新、不记） */
export function editMarksLocal(pageId: string, editable: boolean) {
  return $prose(() => {
    let timer = 0
    return new Plugin({
      appendTransaction(trs, _old, state) {
        const ids = new Set<string>()
        let local = false
        let remote = false
        trs.forEach((tr, k) => {
          if (!tr.docChanged) return
          if (isRemote(tr)) {
            remote = true
            return
          }
          // 把步骤 i 的位置映射到本轮最终文档：先过本事务余下的步骤，再过之后的事务
          const settle = (pos: number, i: number, assoc: number): number => {
            let p = tr.mapping.slice(i + 1).map(pos, assoc)
            for (const later of trs.slice(k + 1)) p = later.mapping.map(p, assoc)
            return p
          }
          tr.steps.forEach((step, i) => {
            if (step instanceof AttrStep) {
              if (step.attr === 'id') return
              local = true
              const p = settle(step.pos, i, 1)
              collect(state.doc, p, p, ids)
              return
            }
            step.getMap().forEach((_oldFrom, _oldTo, from, to) => {
              local = true
              collect(state.doc, settle(from, i, -1), settle(to, i, 1), ids)
            })
          })
        })
        if (local && editable) noteLocalEdits(pageId, ids)
        if (remote) {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => void refreshEditMarks(pageId), REMOTE_SETTLE_MS)
        }
        return null
      },
      view: () => ({ destroy: () => window.clearTimeout(timer) }),
    })
  })
}
