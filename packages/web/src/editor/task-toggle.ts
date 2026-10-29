/* 待办复选框点击切换：复选框是 li[data-item-type='task'] 的 ::before 画的，不是真实 DOM，点不上，
 * 所以用 handleClickOn + 坐标判断点在 li 左侧框区时，翻转 list_item 的 checked attr（gfm schema 渲染回 data-checked）。
 * 切换动画：改 attr 会让 PM 重建整条 li，CSS 过渡播不了；直接往 li 上加类又会被 DOMObserver 当成正文改动重读。
 * 所以给刚翻转的那条挂一个节点装饰（class task-flipped，新 li 一挂上就播 prose.css 的动画），下次文档变化就撤。 */

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

/** 框区宽度 = styles.css 里 li[data-item-type='task'] 的 padding-left，两处须同步改 */
const CHECKBOX_ZONE_PX = 32

/** 刚翻转的 list_item 起点，-1 表示没有 */
const flippedKey = new PluginKey<number>('rametTaskFlipped')

export const taskToggle = $prose(
  () =>
    new Plugin({
      key: flippedKey,
      state: {
        init: () => -1,
        apply: (tr, value) => {
          const meta = tr.getMeta(flippedKey) as number | undefined
          if (meta !== undefined) return meta
          return tr.docChanged ? -1 : value
        },
      },
      props: {
        decorations: (state) => {
          const pos = flippedKey.getState(state) ?? -1
          const node = pos >= 0 ? state.doc.nodeAt(pos) : null
          if (!node || node.type.name !== 'list_item') return DecorationSet.empty
          return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'task-flipped' })])
        },
        handleClickOn: (view, _pos, _node, _nodePos, event) => {
          if (!view.editable) return false
          const li = (event.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
          if (!li) return false
          if (event.clientX - li.getBoundingClientRect().left > CHECKBOX_ZONE_PX) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (!at) return false
          const $at = view.state.doc.resolve(at.pos)
          for (let d = $at.depth; d > 0; d--) {
            const node = $at.node(d)
            if (node.type.name === 'list_item' && node.attrs.checked !== undefined) {
              const pos = $at.before(d)
              view.dispatch(
                view.state.tr
                  .setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    checked: !node.attrs.checked,
                  })
                  .setMeta(flippedKey, pos),
              )
              return true
            }
          }
          return false
        },
      },
    }),
)
