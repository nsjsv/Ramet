/* ---------- 一页的编辑器会话（React 侧）：ref、tick 与取值器 ----------
 * 编辑器会话本身（provider + IDB、插件装配、串行销毁链）在 editor-session.ts，这里只把它接进组件的生命周期，
 * 并给出 ChatView 要的那一套：schema 与写入通道（getEditor）、同一个 Y.Doc（getDoc）、就绪信号（tick）。
 * 两种档位：
 *  - 'page'：页面编辑器（EditorPage），正文看得见，带页面外壳（标题、块手柄、查找、评论、斜杠菜单……）；
 *  - 'chat'：只给一个 ChatView 当底座（别处嵌着的另一页的对话），正文挂在调用方给的隐藏挂载点上，不装页面外壳。
 *    节点 / mark 与页面编辑器一个不少，见 EditorSessionDeps.chrome。
 * 同一时刻可以有两个会话（当前页 + 嵌着的另一页）：它们各有各的 ref，按页面分存的单例（输入框桥、运行错误、审批宿主）
 * 不会串，模块级单例的页面外壳只有 'page' 档装。 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { editorViewCtx, type Editor } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import type { Page } from '../api'
import { startEditorSession, type PageChrome } from './editor-session'

/** 页面档的外壳：onTitleLive 只在建会话时取一次（经 ref 转），父组件每次渲染换新函数也不重建 ws 连接 */
export type PageShellOptions = Omit<PageChrome, 'onTitleLiveRef'> & {
  /** 标题 fragment 一变就上报（侧栏乐观更新） */
  onTitleLive: (id: string, title: string) => void
}

export type PageSessionOptions = {
  username: string
  /** 只读空间（viewer）：编辑器不可输入，消息不能发 */
  readOnly: boolean
  /** 页面目录（找本页所在空间、@ 候选、标题落库基线）；经 ref 读最新值，变化不重建会话 */
  pages: Page[] | null
} & ({ profile: 'page'; shell: PageShellOptions } | { profile: 'chat' })

export interface PageSession {
  /** 正文编辑器的挂载点：页面档是看得见的 .editor-root，对话档由调用方放一个隐藏的 div */
  rootRef: RefObject<HTMLDivElement>
  editorRef: { current: Editor | undefined }
  /** 已建好的正文编辑器属于哪一页：建好时置位、卸载时同步清空（换页拆建窗口期的门闩） */
  editorPageIdRef: { current: string | undefined }
  providerRef: { current: HocuspocusProvider | undefined }
  /** 编辑器建好 / 旧数据升出了块 / ws synced 时 +1：依赖编辑器的视图据此重建或补跑 */
  tick: number
  /** 手动 +1（源码写回后让改名跟随补跑） */
  bump: () => void
  /** 属于当前页的活编辑器（换页拆建窗口期是 undefined）：schema 来源 + 写入通道 */
  getEditor: () => Editor | undefined
  /** 与正文编辑器同一个 Y.Doc */
  getDoc: () => Y.Doc | undefined
  /** 活编辑器的正文视图 */
  getBodyView: () => EditorView | undefined
}

export function usePageSession(pageId: string | undefined, opts: PageSessionOptions): PageSession {
  const { username, readOnly, pages } = opts
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | undefined>(undefined)
  const editorPageIdRef = useRef<string | undefined>(undefined)
  // provider 经 ref 暴露给对话视图（ChatView 绑同一 Y.Doc 建只读渲染视图）；换页串行销毁链拆 provider，
  // ChatView 的视图随组件卸载 / key 变化先行销毁
  const providerRef = useRef<HocuspocusProvider | undefined>(undefined)
  // 编辑器就绪 / 迁移完成信号：依赖 pages 的 effect（改名跟随）在打开页面时 pages 往往早已不变、没机会重跑，
  // 而正文编辑器是异步创建、旧数据转换 pass 又在其后 500ms 才跑，tick 在这些时点 +1 让它们补跑
  const [tick, setTick] = useState(0)
  // 会话 effect 只在 id / username / readOnly 变化时重建，经 ref 拿最新 pages
  const pagesRef = useRef(pages)
  useEffect(() => {
    pagesRef.current = pages
  })
  const shell = opts.profile === 'page' ? opts.shell : null
  // 标题实时上树回调同理经 ref 穿进 effect：父组件每次渲染换新函数也不能重建 ws 连接
  const onTitleLiveRef = useRef<(id: string, title: string) => void>(shell ? shell.onTitleLive : () => undefined)
  useEffect(() => {
    if (shell) onTitleLiveRef.current = shell.onTitleLive
  })
  const onChanged = shell?.onChanged

  useEffect(() => {
    if (!pageId) return
    const chrome: PageChrome | null = shell
      ? {
          onChanged: shell.onChanged,
          navigate: shell.navigate,
          backFromRun: shell.backFromRun,
          titleRef: shell.titleRef,
          titleViewRef: shell.titleViewRef,
          blockProviderRef: shell.blockProviderRef,
          onTitleLiveRef,
          railStore: shell.railStore,
          setPeers: shell.setPeers,
        }
      : null
    return startEditorSession({
      id: pageId, username, readOnly, rootRef, editorRef, editorPageIdRef, providerRef, pagesRef, setEditorTick: setTick, chrome,
    })
    // 只在这几项变化时重建会话（ws 连接）：shell 里的回调与 ref 取建会话这一刻的
  }, [pageId, username, readOnly, opts.profile, onChanged])

  const bump = useCallback(() => setTick((t) => t + 1), [])
  const getDoc = useCallback(() => providerRef.current?.document, [])
  // 带 editorPageIdRef 门闩：换页拆建窗口期不触碰异步销毁中的旧实例
  const getEditor = useCallback(() => (editorPageIdRef.current === pageId ? editorRef.current : undefined), [pageId])
  const getBodyView = useCallback(() => {
    let view: EditorView | undefined
    getEditor()?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view
  }, [getEditor])
  return { rootRef, editorRef, editorPageIdRef, providerRef, tick, bump, getEditor, getDoc, getBodyView }
}
