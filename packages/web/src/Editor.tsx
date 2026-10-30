import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { editorViewCtx, type Editor } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { Page } from './api'
import type { Identity } from './identity'
import HistoryDrawer from './HistoryDrawer'
import { iconAttrOf } from './editor/page-ref'
import { isCollectionBlock } from './editor/collection-block'
import { SourcePane } from './editor/source-mode'
import { useEditMode } from './editor/edit-mode'
import { focusBlockById } from './editor/block-id'
import { focusTextAnchor, textParam } from './editor/text-anchor'
import { usePrepareAgent } from './editor/agent-controls'
import { onViewToggleRequest, readViewMode, writeViewMode } from './view-mode'
import { recordRecentPage } from './recent-pages'
import TopBar from './TopBar'
import { PageIconHeader } from './PageIcon'
import { addRandomCover, PageCover } from './PageCover'
import { resetFind } from './editor/find'
import FindBar from './FindBar'
import { RunFoot, RunHead, useRunDetail } from './editor/run-board'
import BacklinksPanel from './editor/backlinks-panel'
import { agentName } from './editor/ai-block'
import { exportZip } from './export/export-pages'
import { COPY } from './copy'
import { countNodeWords } from './word-count'
import { refreshEditMarks } from './edit-marks-store'
import SkillHead from './editor/skill-head'
import RowProperties from './collection/RowProperties'
import { restoreRowProps } from './collection/schema-ops'
import { setRunInfo } from './editor/run-store'
import { morphViewMode } from './editor/view-morph'
import { setRunOpener } from './hud/hud-store'
import { enterRun, leaveRun } from './editor/run-door'
import { carryToChat, takeComposerText } from './editor/composer-bridge'
import { startMessageDraft, takeDraftText } from './editor/doc-send'
import type { BlockHandleProvider } from './editor/block-handle'
import type { TouchBlockSetup } from './editor/block-touch'
import ChatView from './editor/chat-view'
import { DocRail, createRailStore, railScope, scrollRailTarget, type RailStore } from './editor/doc-rail'
import { AgentPanel, RunErrorBar, useAgentEvents } from './editor/agent-bar'
import { attachBlockDragSelect, caretNear } from './editor/block-select'
import { startEditorSession } from './editor/editor-session'
import { useFullWidth } from './editor/full-width'
import { useReadPosition } from './editor/read-position'

// 聊天 / 文档双模式的存储与优先级在 view-mode.ts（页面自己的记忆 > 全局默认 > 文档），这里只消费。

interface Props {
  pages: Page[] | null
  onChanged: () => void
  username: string
  /** 只读空间（viewer）：编辑器不可输入、标题锁定。纯 UX，服务端已丢弃 viewer 增量、REST 写 403 */
  readOnly?: boolean
  /** 可管理公开状态（空间 owner）：⋮ 菜单出现「分享」 */
  canPublish?: boolean
  /** 标题 fragment 一变就上报（Shell 乐观更新侧栏页面树）；
   *  与 500ms 防抖 REST 写库相互独立，且必须稳定引用（否则 effect 重建 ws 连接） */
  onTitleLive: (id: string, title: string) => void
}

export default function EditorPage({
  pages,
  onChanged,
  onTitleLive,
  username,
  readOnly = false,
  canPublish = false,
}: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | undefined>(undefined)
  // 当前已建好的正文编辑器所属页面 id：create().then 里置位、cleanup 同步清空，
  // 供各 effect 判断编辑器是否属于当前页
  const editorPageIdRef = useRef<string | undefined>(undefined)
  const blockProviderRef = useRef<BlockHandleProvider | TouchBlockSetup | null>(null)
  // 标题视图引用：快照面板恢复时对它 dispatch 协同事务
  const titleViewRef = useRef<EditorView | null>(null)
  // provider 经 ref 暴露给聊天模式（ChatView 绑同一 Y.Doc 建只读渲染视图）；换页串行销毁链
  // 拆 provider，ChatView 的视图随组件卸载 / key 变化先行销毁
  const providerRef = useRef<HocuspocusProvider | undefined>(undefined)
  // 聊天 / 文档模式，按页面 id 记忆在 localStorage
  const [chatMode, setChatMode] = useState(() => readViewMode(id))
  // 右轨清单暂存（每页一个）：正文编辑器的插件往里推，右轨订阅它；状态留在右轨组件里，
  // 编辑 / 流式追加不牵动整页重渲染
  const railStoreRef = useRef<RailStore | null>(null)
  if (!railStoreRef.current) railStoreRef.current = createRailStore()
  const railStore = railStoreRef.current
  const railJump = useCallback(
    (railId: number) => scrollRailTarget(railScope(chatMode), railId),
    [chatMode],
  )
  // agent SSE 状态（status/permission/commands；server 未就绪保持 idle，UI 降级）
  const agentState = useAgentEvents(id)
  // 消息 chip 的「来源/路径」不需要会话，但「模型/思考」来自 agent 的会话 —— 进页面就预备（同一所有者）
  usePrepareAgent(id, agentState, readOnly)
  // 换页恢复目标页的模式（含首挂载，重复 no-op 无害）
  useEffect(() => {
    setChatMode(readViewMode(id))
  }, [id])
  const getDoc = useCallback(() => providerRef.current?.document, [])
  // 行页面属性区要的 doc：只认属于当前页的那条连接（换页的头一帧 providerRef 还是上一页的）
  const getRowDoc = useCallback(() => {
    const provider = providerRef.current
    return provider && provider.configuration.name === `page:${id}` ? provider.document : undefined
  }, [id])
  // 右侧抽屉（更新 / 历史版本两个 Tab，打开落在「更新」）
  const [historyOpen, setHistoryOpen] = useState(false)
  // 在场头像：同页其他人（editor-session 订阅 awareness，名单变了才推）
  const [peers, setPeers] = useState<Identity[]>([])
  // 编辑器就绪 / 迁移完成信号：改名跟随 effect 只盯 [id, pages, readOnly]，而正文编辑器是异步
  // 创建、旧数据转换 pass 又在其后 500ms 才跑，打开页面时 pages 往往早已不变，effect 没机会
  // 重跑，改过名的子页块 / 刚迁移出来的块会一直显示旧 title。tick 在这两个时点 +1 各补跑一次
  const [editorTick, setEditorTick] = useState(0)
  // slash「创建页面」要读页面所属空间：effect 只在 id/username 变化时建立，经 ref 拿最新 pages
  const pagesRef = useRef(pages)
  useEffect(() => {
    pagesRef.current = pages
  })
  // 标题实时上树回调同理经 ref 穿进 effect：父组件每次渲染换新函数也不能重建 ws 连接
  const onTitleLiveRef = useRef(onTitleLive)
  useEffect(() => {
    onTitleLiveRef.current = onTitleLive
  })
  // REST 成功写库的最近文本（跳过判定基线）：effect 建立时 seed 自打开时的 pages.title，
  // REST 成功后更新。不能改成与 pages.title 比较：乐观更新（onTitleLive）后两者恒等，会永久漏写库
  const lastPersistedTitleRef = useRef<string | null>(null)

  // ?block= 直访定位：URL 带目标块 id 时滚动到块并闪烁（editor/block-id.ts）。
  // 编辑器 create().then（editorTick+1）与 ws synced（同一 tick 信号）各尝试一次：
  // IDB 缓存先出内容时第一枪就中，老文档的 id 随首笔补 id 事务落在 synced 后。
  // 找不到静默放弃（键 = 页+块，命中即记，同页再点同块不重闪）；换页换参数重置。
  // 带 ?text=（editor/text-anchor.ts）：滚到块里那段字并高亮，字找不到退回整块闪烁
  const [searchParams] = useSearchParams()
  const blockParam = searchParams.get('block')
  const textAnchor = textParam(searchParams)
  const anchorText = textAnchor?.text ?? ''
  const anchorN = textAnchor?.n ?? 0
  const focusedBlockRef = useRef('')
  useEffect(() => {
    if (!id || !blockParam) return
    if (editorPageIdRef.current !== id) return // 换页拆建窗口期：editorRef 还是上一页的旧编辑器
    const key = `${id}:${blockParam}:${anchorN}:${anchorText}`
    if (focusedBlockRef.current === key) return
    let view: EditorView | undefined
    editorRef.current?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    if (!view || view.isDestroyed) return
    const hit = anchorText ? focusTextAnchor(view, blockParam, { text: anchorText, n: anchorN }) : focusBlockById(view, blockParam)
    if (hit) focusedBlockRef.current = key
  }, [id, blockParam, anchorText, anchorN, editorTick])

  // 快照面板用的活视图:正文(经 milkdown editorViewCtx)与标题(titleViewRef)
  const getViews = useCallback(() => {
    let body: EditorView | undefined
    editorRef.current?.action((ctx) => {
      body = ctx.get(editorViewCtx)
    })
    return { body, title: titleViewRef.current ?? undefined }
  }, [])

  // 源码模式（editor/source-mode.tsx）、对话视图等共用的编辑器取值器：带 editorPageIdRef 门闩，换页拆建窗口期不触碰异步销毁中的旧实例
  const getEditor = useCallback(() => (editorPageIdRef.current === id ? editorRef.current : undefined), [id])
  // 换页先归零（.main 各页共用）；浏览器后退 / 前进回到离开时的位置（本标签页内存）
  const getBodyView = useCallback(() => {
    let view: EditorView | undefined
    getEditor()?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view
  }, [getEditor])
  useReadPosition({ pageId: id, rootRef, getView: getBodyView, tick: editorTick, enabled: !chatMode, skip: !!blockParam })
  // 「最近修改」进页面就预取（⋮ 菜单与块手柄菜单打开即画，edit-marks-store.ts）
  useEffect(() => {
    if (id) void refreshEditMarks(id)
  }, [id])
  // 顶栏 ⋮ 菜单的字数：读活编辑器的正文（三种视图下正文编辑器都在，对话视图只是隐藏它）
  const getWordCount = useCallback(() => {
    let words: number | null = null
    getEditor()?.action((ctx) => {
      words = countNodeWords(ctx.get(editorViewCtx).state.doc)
    })
    return words
  }, [getEditor])
  const onSourceApplied = useCallback(() => setEditorTick((t) => t + 1), []) // 源码写回升级出的 page_ref 标题要跟随改名
  const editMode = useEditMode()

  // 标题按 Enter，光标进正文开头。正文视图可能还没建好（create() 异步），拿不到就 no-op。
  // caretNear 对空文档返回首段落光标；纯 hr 等拿不到合法文本光标（null）时只 focus。
  // 引用必须稳定：它穿进编辑器 effect 作标题 keymap 的 onEnter，不能引起连接重建
  const focusBodyFromTitle = useCallback(() => {
    let body: EditorView | undefined
    editorRef.current?.action((ctx) => {
      body = ctx.get(editorViewCtx)
    })
    if (!body) return
    body.focus()
    const caret = caretNear(body.state.doc, 0)
    if (caret) body.dispatch(body.state.tr.setSelection(caret))
  }, [])

  // 回退：对正文与标题各 dispatch 一条整篇替换的事务（replaceWith(0, size, content)），
  // ySyncPlugin 翻译成 Yjs 增量走正常协同广播与持久化，不绕过协同改文档。
  // 集合的行另带 props，对行文档的 Y.Map('props') 一次 transact 写回（副本与集合增量由投影器照常出）
  const restoreSnapshot = useCallback(
    (body: ProsemirrorNode, title: ProsemirrorNode, props?: Record<string, unknown>) => {
      const views = getViews()
      if (views.body) {
        const v = views.body
        v.dispatch(v.state.tr.replaceWith(0, v.state.doc.content.size, body.content))
      }
      if (views.title) {
        const t = views.title
        t.dispatch(t.state.tr.replaceWith(0, t.state.doc.content.size, title.content))
      }
      const doc = props ? getRowDoc() : undefined
      if (props && doc) restoreRowProps(doc, props)
    },
    [getViews, getRowDoc],
  )

  // 导出当前页（顶栏 ⋮ 菜单）：序列化用活编辑器自己的 markdown 序列化（export/ 下只做节点换形与打包）
  const exportPage = useCallback(
    async (): Promise<boolean> => {
      const editor = getEditor()
      if (!editor || !id) return false
      const label = (agentId: string): string => agentName(agentId) || agentId
      try {
        const { warnings, truncated } = await exportZip(editor, id, label)
        if (warnings > 0 || truncated) window.alert(COPY.export.partial(warnings, truncated))
        return true
      } catch (err) {
        console.error(err)
        window.alert(COPY.export.failed)
        return false
      }
    },
    [getEditor, id],
  )

  // 单块恢复：把历史版本里的一个顶层块（带着原来的 id）插回当前页，位置在 afterId 那块之后（null = 页首）。
  // 走正常的 dispatch → ySync 协同广播与持久化，同恢复整个版本一样可撤销
  const restoreBlock = useCallback(
    (node: ProsemirrorNode, afterId: string | null): boolean => {
      const body = getViews().body
      if (!body || body.isDestroyed || !body.editable) return false
      let pos = 0
      if (afterId) {
        body.state.doc.forEach((child, offset) => {
          if (child.attrs.id === afterId) pos = offset + child.nodeSize
        })
      }
      body.dispatch(body.state.tr.insert(pos, node))
      return true
    },
    [getViews],
  )

  // 换页关面板：列表 / 选中态由组件随 pageId 自清理，这里只避免上一页的抽屉挂到新页（顶栏菜单 / 分享弹层由 TopBar 自收）。
  // 源码编辑器按页 key：换页即卸载，把没写回的改动写回它挂载时取到的那一页（不会写错页），新页的编辑器建好后再挂
  useEffect(() => {
    setHistoryOpen(false)
    resetFind() // 查找浮条跨页无意义（命中清单是本页文档的），换页即关
    if (id) recordRecentPage(id) // `@` 大菜单的「最近」分组（本机记录；过程页 / skill 页在候选里自然被滤掉）
  }, [id])

  // page_ref（与集合块的集合名快照）的标题 / 图标跟随改名与换图标：树上双击改名、子页标题输入、
  // 任意页面改了图标都会广播刷新 pages，这里把 attrs 与 pages 最新值不一致的 page_ref 块
  // 合并进一次 dispatch（标题空按「新页面」；图标 null 表示未设）。
  // 防循环：只有 diff 才写事务，事务不改 pages，本 effect 不重跑，写完即收敛。
  // readOnly 无写权跳过；editorPageIdRef 守卫换页拆建窗口期：cleanup 同步清 ref，而编辑器
  // 异步销毁，窗口期对旧编辑器 action 会抛 editorState not found。
  // editorTick 补偿编辑器异步创建 / 转换 pass 的时点
  useEffect(() => {
    if (readOnly || !pages || editorPageIdRef.current !== id) return
    let view: EditorView | undefined
    editorRef.current?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    if (!view || view.isDestroyed) return
    const latest = pagesRef.current // 与 pages 同值，经 ref 取
    if (!latest) return
    const tr = view.state.tr
    let changed = false
    view.state.doc.descendants((node, pos) => {
      // 集合块 / 链接视图块：title 是集合名快照（公开页、快照面板、源码记号与 agent 读到的都是它），同样跟随改名
      if (isCollectionBlock(node.type.name)) {
        const hit = latest.find((p) => p.id === node.attrs.collectionId)
        if (hit && hit.title !== node.attrs.title) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: hit.title })
          changed = true
        }
        return
      }
      if (node.type.name !== 'page_ref') return
      const page = latest.find((p) => p.id === node.attrs.pageId)
      if (!page) return
      const title = page.title.trim() || '新页面'
      // 图标 attr 是字符串编码形式（见 page-ref.ts iconAttrOf）：直接与 attr 字面量比对
      const icon = iconAttrOf(page.icon)
      if (title === node.attrs.title && icon === (node.attrs.icon ?? null)) return
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, title, icon })
      changed = true
    })
    // 标题 / 图标快照是跟随页面列表的派生值，不进撤销栈（⌘Z 不该把块的名字退回旧名，也不该占掉一步撤销）
    if (changed) view.dispatch(tr.setMeta('addToHistory', false))
  }, [id, pages, readOnly, editorTick])

  // 列外块拖选：编辑器 DOM 收不到列外区域的 mousedown，只能在外层监听（editor/block-select.ts）
  useEffect(() => {
    function getView(): EditorView | undefined {
      let view: EditorView | undefined
      editorRef.current?.action((ctx) => {
        view = ctx.get(editorViewCtx)
      })
      return view
    }
    return attachBlockDragSelect(getView, () => blockProviderRef.current?.active)
  }, [])

  // 进 / 出过程页（run-door.ts）：用量标签胶囊 ⇄ 过程页标题变形；新编辑器属于目标页（editorPageIdRef）才算到了
  const openRun = useCallback(
    (runId: string, chip: HTMLElement | null) => {
      enterRun({
        runId,
        parentId: id ?? '',
        chip,
        go: () => navigate(`/page/${runId}`),
        ready: () => editorPageIdRef.current === runId,
        title: () => titleRef.current,
      })
    },
    [id, navigate],
  )
  // 右上角工作台的「在过程页里看」也走这条（起点是回复抬头停靠的岛）
  useEffect(() => {
    setRunOpener(openRun)
    return () => setRunOpener(null)
  }, [openRun])
  const backFromRun = useCallback(
    (parentId: string) => {
      leaveRun({
        runId: id ?? '',
        parentId,
        from: titleRef.current,
        go: () => navigate(`/page/${parentId}`),
        ready: () => editorPageIdRef.current === parentId,
      })
    },
    [id, navigate],
  )

  // 编辑器会话（provider + IDB、标题、插件、销毁链）：editor/editor-session.ts
  useEffect(() => {
    if (!id) return
    return startEditorSession({
      id, username, readOnly, onChanged, navigate, backFromRun, rootRef, titleRef, editorRef, editorPageIdRef,
      titleViewRef, providerRef, blockProviderRef, pagesRef, onTitleLiveRef, lastPersistedTitleRef, setEditorTick,
      railStore, focusBodyFromTitle, setPeers,
    })
  }, [id, username, readOnly, onChanged])

  // 文档 ⇄ 对话：View Transitions 变形（view-morph.ts）+ 没发出去的输入跟着走（composer-bridge.ts）：
  // 文档→对话把草稿的字搬进输入框并从文档删掉，对话→文档把输入框的字变成文档末尾的草稿、光标落进去。viewer 不搬。
  // 命令面板的「切到文档 / 对话视图」：走同一个 switchView（带动画、带草稿）；经 ref 取最新的闭包
  const switchRef = useRef<() => void>(() => undefined)
  switchRef.current = () => switchView(!chatMode)
  useEffect(() => onViewToggleRequest(() => switchRef.current()), [])
  const switchView = (next: boolean) => {
    let carry = ''
    morphViewMode({
      change: () => {
        const body = getViews().body
        if (next) {
          carry = !readOnly && body ? takeDraftText(body) : ''
          carryToChat(carry)
        } else {
          carry = readOnly ? '' : takeComposerText()
        }
        setChatMode(next)
        writeViewMode(id, next)
      },
      after: () => {
        const body = getViews().body
        if (!next && carry && body) startMessageDraft(body, carry)
      },
      docView: () => getViews().body,
    })
  }

  // 标题没有草稿态：Yjs 即时同步 + observeDeep 防抖写回（树上 / 刷新后的名字以 pages.title 为准）
  const page = pages?.find((p) => p.id === id) ?? null
  const parentKind = page?.parent_id ? pages?.find((p) => p.id === page.parent_id)?.kind : undefined
  const [fullWidth, setFullWidth] = useFullWidth(page, pageRef, onChanged)
  // 过程页：步骤是正文里的块，头（摘要 / 返回链接 / 用量）与尾（最终输出 / 附加信息）按 record 画
  const runDetail = useRunDetail(page?.kind === 'run' && id ? id : null)
  useEffect(() => {
    if (id && runDetail) setRunInfo(id, runDetail) // 步骤块按 sid 取详情、「引用」找所属页面都读这里
  }, [id, runDetail])
  // 源码模式（editor/edit-mode.tsx）是 CodeMirror 编辑 markdown 原文：过程页（步骤是结构化的块）
  // 与对话视图没有 markdown 编辑，照常显示所见即所得。正文编辑器建好才挂（editorTick bump 会重渲到这里），它挂载时一次性取正文视图
  const sourceOn = editMode !== 'rich' && page?.kind !== 'run' && !chatMode && getEditor() !== undefined
  return (
    <>
      <TopBar
        pages={pages}
        pageId={id}
        peers={peers}
        canPublish={canPublish}
        published={page?.published ?? false}
        includeRuns={page?.publish_includes_runs ?? false}
        onChanged={onChanged}
        onNavigate={navigate}
        chatOn={chatMode}
        onViewChange={(next) => {
          if (next === chatMode) return
          switchView(next)
        }}
        onOpenHistory={() => setHistoryOpen(true)}
        onExport={exportPage}
        fullWidth={fullWidth}
        onFullWidth={readOnly ? undefined : setFullWidth}
        getWordCount={getWordCount}
      />
      {/* 右轨（文档导航）：直出 .main 里，它是视口级 HUD（sticky 定位，见 styles/editor.css），
          不属于正文流；两种视图共用这一个挂载点，跳转容器按模式选（chatMode） */}
      <DocRail store={railStore} onJump={railJump} />
      {/* 正文列是 [data-flip]（侧栏收起 / 展开时 FLIP 跟着滑）：里面不能有 fixed 后代，
          祖先带 transform 会让它们跟着位移，所以查找条与历史抽屉挂在列外 */}
      {/* 封面铺满内容区宽度，所以挂在正文列外（也不进 [data-flip] 的列，FLIP 位移不带着它） */}
      {id && <PageCover pageId={id} cover={page?.cover ?? null} readOnly={readOnly} onChanged={onChanged} />}
      <div
        className={'editor-page' + (chatMode ? ' chat-mode' : '') + (fullWidth ? ' full-width' : '') + (page?.cover ? ' has-cover' : '')}
        ref={pageRef}
        data-flip
      >
        {id && (
          <PageIconHeader
            pageId={id}
            icon={page?.icon ?? null}
            readOnly={readOnly}
            onChanged={onChanged}
            onAddCover={page && !page.cover ? () => void addRandomCover(id).then(onChanged, (err: unknown) => console.error(err)) : undefined}
          />
        )}
        <div className="page-title title-editor" ref={titleRef} />
        {runDetail && (
          <RunHead
            detail={runDetail}
            replyHref={(parentId, replyId) => `/page/${parentId}${replyId ? `?block=${replyId}` : ''}`}
            onBack={backFromRun}
          />
        )}
        {id && page?.kind === 'skill' && <SkillHead pageId={id} readOnly={readOnly} pages={pages} />}
        {/* 集合的行：标题下面是属性区（按页面 id 做 key：换页时先卸载、摘掉对旧行文档的观察） */}
        {id && page && parentKind === 'collection' && page.parent_id && !chatMode && (
          <RowProperties key={id} page={page} collectionId={page.parent_id} getDoc={getRowDoc} tick={editorTick} readOnly={readOnly} />
        )}
        {/* 运行错误：与聊天模式共用同一份 runError，不按模式分叉（否则文档模式失败就"点了没反应"） */}
        <RunErrorBar />
        <div
          className={
            'editor-root' + (sourceOn ? ' source-hidden' : '') + (chatMode ? ' chat-hidden' : '')
          }
          ref={rootRef}
        />
        {/* 源码编辑器占正文原位（反链等仍在它下面）；按页 key：一次挂载一次源码会话 */}
        {sourceOn && (
          <SourcePane
            key={id}
            getEditor={getEditor}
            readOnly={readOnly}
            onApplied={onSourceApplied}
          />
        )}
        {runDetail && <RunFoot detail={runDetail} />}
        {/* 反向链接：哪些页面 / 块引用了本页（过程页没有；没有反链时整块不画） */}
        {id && !chatMode && page && page.kind !== 'run' && <BacklinksPanel pageId={id} onNavigate={navigate} />}
        {chatMode && id && (
          <ChatView
            key={id}
            pageId={id}
            readOnly={readOnly}
            pages={pages}
            onPagesChanged={onChanged}
            getEditor={getEditor}
            getDoc={getDoc}
            tick={editorTick}
            agentState={agentState}
          />
        )}
        {/* 审批弹条（两种视图都渲染：权限请求不能只在一种视图里可批）；viewer 只读不渲染 */}
        {id && !readOnly && <AgentPanel pageId={id} state={agentState} />}
      </div>
      {/* 页内查找/替换浮条：视口级浮层（fixed 顶栏下方），viewer 也能查找（替换 action 自带 editable 守卫） */}
      <FindBar />
      {historyOpen && id && (
        <HistoryDrawer
          pageId={id}
          readOnly={readOnly}
          username={username}
          getViews={getViews}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreSnapshot}
          onRestoreBlock={restoreBlock}
          row={
            page && parentKind === 'collection' && page.parent_id
              ? { collectionId: page.parent_id, spaceId: page.space_id, getDoc: getRowDoc }
              : null
          }
        />
      )}
    </>
  )
}
