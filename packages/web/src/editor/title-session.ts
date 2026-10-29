/* ---------- 一页标题的协作会话：标题视图、单行规范、防抖写库、乐观上树 ----------
 * 文档页（editor-session.ts）与集合页（collection/CollectionPage.tsx）共用，标题持久化的基线语义只有这一处实现。
 * 生命周期：provider 建好就 startTitleSession（观察 fragment、播种基线）；编辑器能建时 mount 建视图；
 * 卸载时先同步 stop（摘观察 + 补写防抖中的标题），串行销毁链里再 destroyView。 */
import type { EditorView } from '@milkdown/kit/prose/view'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { api, type Page } from '../api'
import { createTitleView } from './title-editor'

type Ref<T> = { current: T }

export type TitleSessionDeps = {
  id: string
  provider: HocuspocusProvider
  readOnly: boolean
  onChanged: () => void
  pagesRef: Ref<Page[] | null>
  onTitleLiveRef: Ref<(id: string, title: string) => void>
  lastPersistedTitleRef: Ref<string | null>
}

export type TitleSession = {
  /** 建标题视图（与正文同一 provider，复用连接与 awareness，绑独立 title fragment）；容器为空不建 */
  mount: (place: HTMLElement | null, onEnter: () => void) => EditorView | undefined
  view: () => EditorView | undefined
  /** 单行规范（幂等） */
  normalize: () => void
  /** 卸载第一步（同步）：摘观察，防抖中的标题写库立刻补写 */
  stop: () => void
  /** 串行销毁链里拆视图（容器是复用的 React 节点，清掉 PM 留下的内容再重建） */
  destroyView: () => void
}

export function startTitleSession(deps: TitleSessionDeps): TitleSession {
  const { id, provider, readOnly, onChanged, pagesRef, onTitleLiveRef, lastPersistedTitleRef } = deps
  let destroyed = false
  let titleView: EditorView | undefined

  // 标题持久化：fragment 变化后 500ms 防抖，与上次已写库的文本不同才 REST 写回。
  // yjs 13.6 没有 textContent getter；fragment 内容由 ySyncPlugin 与标题 PM doc 保持 1:1，
  // 故直接读 PM doc，段落间以 ' ' 连接（多段是退化兜底，正常单段）。
  const titleFragment = provider.document.getXmlFragment('title')
  lastPersistedTitleRef.current = pagesRef.current?.find((p) => p.id === id)?.title ?? null
  let titleTimer: number | undefined
  const flushTitle = () => {
    titleTimer = undefined
    // 页不在列表里（列表未到或陈旧）时不写：基线未知，避免拿空文本当真值发无效 PATCH；
    // 列表到达后（广播 refresh）再改标题会重新触发
    const current = pagesRef.current?.find((p) => p.id === id)
    const doc = titleView?.state.doc
    if (!current || !doc) return
    const text = doc.textBetween(0, doc.content.size, ' ')
    // 基线已知且同值才跳过（防重复 REST）。基线未知（挂载时页面不在列表里，seed 为 null）就直接写：
    // 文本来自同步后的 Y.Doc，与服务端一致时是幂等 no-op，顺带把基线补上。
    // 不能改用 current.title 兜底：用户先打字的话它已被乐观更新污染，恒等会漏写库
    if (lastPersistedTitleRef.current !== null && text === lastPersistedTitleRef.current) return
    api
      .renamePage(id, text)
      .then(() => {
        // REST 成功才前移基线；失败保持旧值，下次观察重试。卸载时补写的那次回来时 ref 已归新页（Editor 实例级），不碰
        if (!destroyed) lastPersistedTitleRef.current = text
        onChanged() // REST 成功会触发服务端广播，侧栏树跟名
      })
      .catch(console.error) // 写库失败只记录，下次观察再触发，不弹错
  }
  const scheduleTitleFlush = () => {
    if (titleTimer !== undefined) window.clearTimeout(titleTimer)
    titleTimer = window.setTimeout(flushTitle, 500)
  }
  // 即时上树：fragment 一变就报 Shell 乐观更新 pages（侧栏当次输入即变），防抖写库照旧。
  // observeDeep 注册早于 ySyncPlugin 的同名 observer（后者建 titleView 时才挂上，同一 _dEH
  // 列表按注册序回调），回调内标题 PM doc 还旧一拍，所以推迟一个微任务，等事务清理走完再读 titleView
  const onTitleChange = () => {
    queueMicrotask(() => {
      if (destroyed) return
      const doc = titleView?.state.doc
      if (!doc) return
      onTitleLiveRef.current(id, doc.textBetween(0, doc.content.size, ' '))
    })
    scheduleTitleFlush()
  }
  titleFragment.observeDeep(onTitleChange)

  // 单行规范：标题只认第一段，多余段落（历史脏数据或异常插入）删掉；幂等，重复调用无副作用。
  // tryStart（IDB 先到）与 ws synced 各跑一次：历史脏数据或重播种的双排标题可能在 ws 合并
  // 后才凑齐多段，IDB 时点还查不到。删除会触发 observeDeep，防抖把首段文本写回 DB，树上名字自愈
  const normalizeTitle = () => {
    if (titleFragment.length > 1) titleFragment.delete(1, titleFragment.length - 1)
  }

  return {
    mount: (place, onEnter) => {
      if (place) titleView = createTitleView(place, provider, readOnly, onEnter)
      return titleView
    },
    view: () => titleView,
    normalize: normalizeTitle,
    stop: () => {
      destroyed = true
      titleFragment.unobserveDeep(onTitleChange)
      // 防抖中的标题写库立刻补写，不能丢：打完标题 500ms 内离开，库（与父页 page_ref 跟随的 pages）
      // 会停在中间态。标题视图在后面的异步销毁链里才拆，此刻还读得到
      if (titleTimer !== undefined) {
        window.clearTimeout(titleTimer)
        flushTitle()
      }
    },
    destroyView: () => {
      titleView?.destroy()
      titleView?.dom.remove() // 容器是复用的 React 节点，清掉 PM 留下的内容再重建
    },
  }
}
