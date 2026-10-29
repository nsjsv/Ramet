/* ---------- 查找 / 替换浮条（editor/find.ts 的 UI 壳） ----------
 * 视口级浮层：fixed 钉顶栏（.topbar）下方右侧，z-index 6 同顶栏。
 * store 在 find.ts，本组件只渲染 + 调 action。Mod+F/H/Esc 在 window capture
 * 拦（抢在浏览器原生查找之前），Enter/Shift+Enter 在输入框里跳上 / 下一处。 */
import { useEffect, useSyncExternalStore, useRef } from 'react'
import {
  findStore,
  subscribeFind,
  openFind,
  closeFind,
  setFindQuery,
  setFindReplacement,
  setFindCase,
  findNext,
  replaceCurrent,
  replaceAll,
  findKeyHandler,
} from './editor/find'
import { Icon } from './icons'

const snapshot = (): number => findStore.version

export default function FindBar(): React.ReactNode {
  useSyncExternalStore(subscribeFind, snapshot)
  const queryRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.addEventListener('keydown', findKeyHandler, true)
    return () => window.removeEventListener('keydown', findKeyHandler, true)
  }, [])

  // 打开瞬间聚焦查询框并全选（反复 Ctrl+F 直接改词）；跳转不抢焦点（焦点留在输入框可连续 Enter）
  useEffect(() => {
    if (!findStore.open) return
    queryRef.current?.focus()
    queryRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在开关翻转时聚焦
  }, [findStore.open])

  if (!findStore.open) return null
  const { query, replacement, caseSensitive, matches, index, replaceOpen } = findStore
  const count = matches.length

  return (
    <div className="find-bar" role="search">
      <div className="find-row">
        <input
          ref={queryRef}
          className="find-input"
          placeholder="查找…"
          value={query}
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              findNext(e.shiftKey ? -1 : 1)
            }
          }}
          spellCheck={false}
        />
        <span className={'find-count' + (query && count === 0 ? ' none' : '')}>
          {query ? (count === 0 ? '无结果' : index >= 0 ? `${index + 1}/${count}` : `${count} 处`) : ''}
        </span>
        <button type="button" className={'find-btn case' + (caseSensitive ? ' on' : '')} title="区分大小写" onClick={() => setFindCase(!caseSensitive)}>
          Aa
        </button>
        <button type="button" className="find-btn" title="上一处（Shift+Enter）" disabled={count === 0} onClick={() => findNext(-1)}>
          <Icon name="arrow-up" size={14} />
        </button>
        <button type="button" className="find-btn" title="下一处（Enter）" disabled={count === 0} onClick={() => findNext(1)}>
          <Icon name="arrow-down" size={14} />
        </button>
        <button type="button" className="find-btn" title="替换（Ctrl+H）" onClick={() => openFind(true)}>
          <Icon name="swap" size={14} />
        </button>
        <button type="button" className="find-btn" title="关闭（Esc）" onClick={closeFind}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {replaceOpen && (
        <div className="find-row">
          <input
            ref={replaceRef}
            className="find-input"
            placeholder="替换为…"
            value={replacement}
            onChange={(e) => setFindReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                replaceCurrent()
              }
            }}
            spellCheck={false}
          />
          <button type="button" className="find-btn" disabled={count === 0} title="替换当前" onClick={replaceCurrent}>
            替换
          </button>
          <button type="button" className="find-btn" disabled={count === 0} title="全部替换" onClick={replaceAll}>
            全部
          </button>
        </div>
      )}
    </div>
  )
}
