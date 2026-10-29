// 一页正文编辑器的一次会话：provider + IDB、标题协作与落库、旧数据转换、插件装配、串行销毁链。
// 组件里的 ref / 回调经 deps 传入。
import { Editor, rootCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/kit/core'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { EditorView } from '@milkdown/kit/prose/view'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { undo, redo } from 'y-prosemirror'
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { NavigateFunction } from 'react-router-dom'
import { api, type Page } from '../api'
import { agentList } from '../default-agent'
import { cursorIdentity, isIdentity, type Identity } from '../identity'
import type { BlockHandleProvider } from './block-handle'
import type { TouchBlockSetup } from './block-touch'
import { configBlock } from './block-handle-config'
import { selectBlocks } from './block-select'
import { startTitleSession } from './title-session'
import { configSlash, slash, slashSession } from './slash'
import { blankClick } from './blank-click'
import { configDocMention, docMention } from './doc-mention'
import { configClipboardText, configMarkdownOut, configPaste, extraInputRules } from './markdown'
import { rametDialect } from './md-dialect'
import { highlightInputRule, highlightSchema, textColorSchema } from './color-marks'
import { codeBlockView } from './code-view'
import { activeBlock } from './active-block'
import { codeHighlight } from './code-highlight'
import { tableView } from './table-view'
import { calloutSchema, calloutView } from './callout'
import { toggleKeys, toggleSchema, toggleView } from './toggle'
import { tocRefresh, tocSchema, tocView } from './toc'
import { columnSchema, columnsSchema } from './columns'
import { embedSchema } from './embed'
import { mathBlockInputRule, mathBlockSchema, mathInlineInputRule, mathInlineSchema } from './math'
import { mathBlockView, mathInlineView } from './math-view'
import { blockSelectKeys, editingKeys } from './editing-keys'
import { shortcutKeys } from './shortcuts'
import { linkHover } from './link-hover'
import { linkNotInclusive } from './link-mark'
import { createLinkWatcher } from './link-watcher'
import { configLinkNav } from './link-nav'
import { upgradeLinkBlocks, pageRefSchema } from './page-ref'
import { agentMentionSchema } from './agent-mention'
import { userMentionSchema } from './user-mention'
import { mentionUpgrade, upgradeMentions } from './mention-upgrade'
import { pageMentionSchema } from './page-mention'
import { blockIdSchemas, commonmarkPreset, ensureBlockIds } from './block-id'
import { editMarksLocal } from './edit-marks-local'
import { runStepSchema } from './run-step'
import { runStepGuard, runStepView } from './run-step-view'
import { takeQuotes } from './quote-queue'
import { quoteIntoDraft } from './doc-send'
import { aiBlockView, liveReplyView, replyChipView } from './ai-block'
import { messageChipsView, userMessageView } from './message-chips'
import { docModeKeys } from './mode-keys'
import { quickAi } from './quick-ai'
import { agentReplySchema, messageDeleteKeymap, messageEnterView, userMessageSchema, upgradeMessageBlocks } from './message-blocks'
import { docSendView } from './doc-send'
import { bindPageSpace } from '../memory/remember'
import { bindPageView } from '../team/team-send'
import { headingInputRule } from './heading-level'
import { sourceWatch } from './source-sync'
import { listEnterKeymap, listNormalize } from './list-blocks'
import { tableTabKeymap } from './table-nav'
import { findPlugin } from './find'
import { blockRefSchema } from './block-ref'
import { underlineSchema, underlineKeymap } from './underline'
import { configSelectionMenu, selectionTooltip } from './selection-menu'
import { textFlash } from './text-anchor'
import { blockLinkPaste } from './block-link-paste'
import { blockSyncSchema, blockSyncView } from './block-sync'
import { taskToggle } from './task-toggle'
import { attachmentSchema } from './attachment'
import { imageDisplaySchema, uploadPlugin, lightboxPlugin, imageItemMark } from './media'
import { listDrag } from './list-drag'
import { createPageDrop, setPageDropBridge } from './page-drop'
import { collabUrl } from './collab-url'
import { docRail, type RailStore } from './doc-rail'
import { docHeadActs } from './doc-acts'
import { collectionInlineSchema, collectionLinkSchema, collectionPaste } from './collection-block'
import { collectionBlockViews } from '../collection/block-view'

// collab 插件内含 yUndoPlugin（Yjs UndoManager），这里只补快捷键绑定。

const undoRedo = $prose(() =>
  keymap({
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
  }),
)

/** 组件交给会话的 ref 与回调；ref 只读写 current */
type Ref<T> = { current: T }
export type EditorSessionDeps = {
  id: string
  username: string
  readOnly: boolean
  onChanged: () => void
  navigate: NavigateFunction
  backFromRun: (parentId: string) => void
  rootRef: Ref<HTMLDivElement | null>
  titleRef: Ref<HTMLDivElement | null>
  editorRef: Ref<Editor | undefined>
  editorPageIdRef: Ref<string | undefined>
  titleViewRef: Ref<EditorView | null>
  providerRef: Ref<HocuspocusProvider | undefined>
  blockProviderRef: Ref<BlockHandleProvider | TouchBlockSetup | null>
  pagesRef: Ref<Page[] | null>
  onTitleLiveRef: Ref<(id: string, title: string) => void>
  lastPersistedTitleRef: Ref<string | null>
  setEditorTick: (update: (t: number) => number) => void
  railStore: RailStore
  focusBodyFromTitle: () => void
  /** 在场头像：同页其他人（awareness 里的 user，去掉自己、同名去重）；只在名单变化时调用 */
  setPeers: (peers: Identity[]) => void
}

/** 建立会话；返回卸载函数（React effect 的 cleanup） */
export function startEditorSession(deps: EditorSessionDeps): () => void {
  const { id, username, readOnly, onChanged, navigate, backFromRun, rootRef, titleRef, editorRef, editorPageIdRef } = deps
  const { titleViewRef, providerRef, blockProviderRef, pagesRef, onTitleLiveRef, lastPersistedTitleRef, setEditorTick, railStore, focusBodyFromTitle, setPeers } = deps
  let destroyed = false
  let started = false
  let editor: Editor | undefined

  const provider = new HocuspocusProvider({ url: collabUrl(), name: `page:${id}` })
  const me = cursorIdentity(username)
  provider.setAwarenessField('user', me)
  providerRef.current = provider

  // 在场名单：awareness 每次光标移动都会 change，名单（名字 + 颜色）没变就不推，顶栏不跟着重渲染
  let peersKey = ''
  const onAwareness = () => {
    const seen = new Map<string, Identity>()
    for (const [clientId, state] of provider.awareness?.getStates() ?? []) {
      const user: unknown = state.user
      if (clientId === provider.awareness?.clientID || !isIdentity(user) || user.name === me.name) continue
      if (!seen.has(user.name)) seen.set(user.name, user)
    }
    const peers = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    const key = peers.map((x) => `${x.name}\u0000${x.color}`).join('\u0001')
    if (key === peersKey) return
    peersKey = key
    setPeers(peers)
  }
  provider.awareness?.on('change', onAwareness)

  // 正文 IndexedDB 缓存：IDB 先灌本地已有内容进 doc，ws sync 只补缺失增量。
  // doc 每笔 update 由 y-indexeddb 直写 updates store，销毁不丢数据。
  // 创建顺序 provider → idb，销毁反序（见 cleanup 串行链最末）。idb 加载完本地数据（空库也发）
  // 会 emit 'synced'，与 ws 的 'synced' 先到先得触发编辑器创建（见下方 tryStart）。
  const idb = new IndexeddbPersistence(`ramet-page-${id}`, provider.document)

  // 仅「从未 synced 成功过」且 close 码是服务端拒绝码时清该页 IDB（非成员 / 被收权：
  // 4401 Unauthorized / 4403 Forbidden）。普通 destroy（1000/1005）与掉线 / 服务器重启重连（1006）
  // 不清，重连后 sync 照常补差，缓存仍有效。
  // close 载荷形态是 { event: { code, reason } }：ws 的 CloseEvent 被包进 event 字段后原样转发。
  let syncedOnce = false
  // 服务端拒绝（4401/4403，与 clearData 同一判定）时置位：阻止 tryStart 把本地缓存的
  // 无权限内容渲染出来（如被移出空间后重进同一页）
  let authRejected = false
  provider.on('close', (payload: { event?: { code?: number } }) => {
    const code = payload?.event?.code
    if (!syncedOnce && (code === 4403 || code === 4401)) {
      authRejected = true
      void idb.clearData().catch((err: unknown) => console.error('idb clearData failed:', err))
    }
  })

  // 标题会话（视图、单行规范、500ms 防抖写库、即时上树）见 title-session.ts，集合页共用
  const titleSession = startTitleSession({ id, provider, readOnly, onChanged, pagesRef, onTitleLiveRef, lastPersistedTitleRef })
  // 这页在哪个空间：文档模式的 `>> /记住 …` 草稿发送时要用（memory/remember.ts）
  const unbindSpace = bindPageSpace(id, () => pagesRef.current?.find((p) => p.id === id)?.space_id ?? undefined)

  // 正文里删掉 /page/ 链接后，防抖 2s 把该子页一并删掉。状态都收在 createLinkWatcher（link-watcher.ts）里，
  // 这里只喂依赖，卸载时 destroy()。
  const getMainView = (): EditorView | undefined => {
    let view: EditorView | undefined
    editor?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view
  }
  const linkWatcher = createLinkWatcher({ getPageId: () => id, isReadOnly: readOnly, onChanged, getView: getMainView, getPages: () => pagesRef.current })
  // 带队计划卡的「开工」要往这页追加一条用户消息（team/team-send.ts）：只读会话不登记
  const unbindView = readOnly ? () => {} : bindPageView(id, getMainView)

  // 旧数据转换 pass：整段恰为一个 /page/ 链接的段落 → page_ref 块，/api/files/ 与 ?block= 降级链接一并升回块（见 page-ref.ts），
  // 消息块的降级形态与旧模型遗留引用块升成 user_message / agent_reply。
  // 防抖 500ms，触发点 = 正文编辑器创建后 + ws synced 后各一次（IDB 先建的场景由 ws synced
  // 再补扫一次远端增量，防抖合并）。幂等：重跑零 diff；readOnly 无写权不转换。
  let migrateTimer: number | undefined
  const scheduleMigrate = () => {
    if (readOnly) return
    if (migrateTimer !== undefined) window.clearTimeout(migrateTimer)
    migrateTimer = window.setTimeout(() => {
      migrateTimer = undefined
      if (destroyed) return
      let view: EditorView | undefined
      editor?.action((ctx) => {
        view = ctx.get(editorViewCtx)
      })
      if (!view || view.isDestroyed) return
      const tr = view.state.tr
      // 降级链接升回块（page_ref/attachment/block_ref），消息块的降级形态 / 旧模型遗留
      // （AI 引用块、标记段引用块）升成 user_message / agent_reply（见 message-blocks.ts）。各自幂等
      const links = upgradeLinkBlocks(tr)
      const messages = upgradeMessageBlocks(tr)
      // @ 页面 / agent 的旧原文/降级链接 ↔ chip（同一边界收敛，幂等）
      const mentions = upgradeMentions(tr)
      if (links || messages || mentions) {
        // 真升出了块才 +1：升级用链接旧文本当 title，转完让改名跟随立刻按 pages 校正
        view.dispatch(tr)
        if (links) setEditorTick((t) => t + 1)
      }
    }, 500)
  }

  // 文档模式抬头行操作（doc-acts.ts）：动作走本会话的编辑器（建好之前 widget 也不存在）
  const headActs = docHeadActs(id, () => editor, !readOnly)
  // 外链新标签打开：正文点击（link-nav.ts）与链接悬浮栏共用
  const openExternal = (href: string): void => void window.open(href, '_blank', 'noopener,noreferrer')
  // 创建正文 + 标题编辑器：ws synced 与 idb synced 先到先得（IDB 本地加载远快于 ws 往返），
  // 有缓存换页立即出内容，空页面立即出空编辑器，增量随后由 ws 补上，不会黑屏。
  // 守卫顺序：先 authRejected（拒绝后连缓存也不渲染），再 destroyed / started / root 门闩
  const tryStart = () => {
    if (authRejected) return
    if (destroyed || started || !rootRef.current) return
    started = true
    const instance = Editor.make()
      .config((ctx) => ctx.set(rootCtx, rootRef.current!))
      .config((ctx) =>
        configSlash(ctx, {
          pageId: id,
          navigate,
          onChanged,
          getSpaceId: () => pagesRef.current?.find((p) => p.id === id)?.space_id ?? undefined,
          onChildLinked: linkWatcher.onChildLinked, // slash 建的子页登记进 watcher 的 linkedChildren
          getPages: () => pagesRef.current, // 「链接视图」列本空间的集合
        }),
      )
      .config((ctx) => configLinkNav(ctx, navigate, openExternal))
      .config(configDocMention)
      .config(configPaste)
      .config(configClipboardText)
      .config(configMarkdownOut)
      .config((ctx) => configSelectionMenu(ctx, id))
    if (readOnly) {
      // viewer 只锁输入（UX），服务端本就丢弃其增量
      instance.config((ctx) =>
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false })),
      )
    }
    blockProviderRef.current = configBlock(instance, () => id)
    // docChanged → 防抖扫描 linkedChildren；只读端工厂返回 undefined 不挂（viewer 无删页权限）
    if (linkWatcher.plugin) instance.use(linkWatcher.plugin)
    void instance
      .use(commonmarkPreset) // commonmark 去掉标题 slug 插件（标题 id 是块 id，见 block-id.ts）与 6 级标题入口
      .use(headingInputRule) // 行首 # 输入规则，标题最多 3 级（heading-level.ts）
      .use(gfm)
      .use(rametDialect) // markdown 方言识别（@ramet/shared/md-dialect；服务端 AI 落块 / 导入同一份）
      .use(underlineSchema) // 下划线 mark（PublicPage 同款注册，缺 mark 的视图解析 Yjs 会炸）
      .use(textColorSchema) // 文字颜色（两个宿主同表；未注册的 mark 会让对端解析失败）
      .use(highlightSchema) // 背景高亮
      .use(highlightInputRule) // 打字 ==文字== → 黄色高亮
      .use(underlineKeymap) // Mod-u 切下划线
      .use(selectionTooltip) // 文字框选菜单（configSelectionMenu 填充菜单 DOM）
      .use(linkHover({ navigate, openExternal })) // 行内链接悬浮栏：缩略地址 / 复制 / 编辑文字与地址（不加 schema，公开页不挂）
      .use(textFlash) // 文字定位链接的高亮（?block=&text=，PublicPage 同款挂）
      .use(blockIdSchemas) // 预设里可寻址块的 id attr（必须排在 commonmark / gfm 之后，同名原位替换）
      .use(linkNotInclusive) // 链接末尾继续打字 / 回车不续链接 mark（同名原位替换，排在 commonmark 之后）
      .use(blockSelectKeys) // 块选区键位 / 剪贴板 / 整段拖放（必须排在所有 keymap 之前：块选时 PM 只有个折叠 caret）
      .use(shortcutKeys) // 快捷键（链接、删除线、块类型；说明表同源，见 shortcuts.ts）
      .use(editingKeys) // 块首退格去样式、跨块删除、Tab 缩进、副本 / 移动、Mod-A 两段式（排在消息块 / 列表 keymap 前）
      .use(userMessageSchema) // 用户消息块节点：公开页/协同对端 schema 必须同名同 attrs
      .use(userMessageView) // 改 agent/cwd/opts 只改 data-*，不重建块 DOM（否则光标丢）
      .use(messageDeleteKeymap) // 消息块边界上的 Backspace/Delete：空块整块删 / 有内容立墙不穿透
      .use(messageEnterView) // 新插入的消息块挂 is-new（打开页已有的不播入场）
      .use(agentReplySchema) // AI 回复块节点：同上
      .use(runStepSchema) // 过程页的步骤块（正文里的真块，继承改 / 删 / 拖 / 引用）
      .use(runStepView(id, { editable: !readOnly, back: backFromRun })) // 一行外壳 + 展开详情 + 引用（块仍是真块）
      .use(runStepGuard(id)) // 步骤文字只有展开「高级」时能改
      .use(aiBlockView({ loadAgents: true })) // AI 回复块顶栏：装饰写 data-agent-logo/-mark/-name（CSS 画）
      .use(replyChipView(id, (node) => headActs('ai', node))) // 抬头右端：操作行 + 停靠的岛（块 stats / plan；点开右上角工作台）
      .use(liveReplyView(id, !readOnly)) // 正在跑的回复：实时 markdown + 状态条（块由 run.replyId 指名）
      .use(messageChipsView(id, (node) => headActs('user', node))) // 用户消息块上的调用配置 chip（来源/模型/思考/路径；写进节点 attrs）+ 操作行
      .use(docSendView({ pageId: id, enabled: !readOnly })) // 文档模式：>> 用户消息块末尾空行上回车（连续两次）= 写完 → continue
      .use(docModeKeys({ pageId: id, enabled: !readOnly })) // 文档模式：>> 草稿里 ⇧Tab = 权限模式转到下一档（排在 editingKeys 之后：列表 / 代码块的 Shift-Tab 先处理）
      .use(quickAi({ enabled: !readOnly })) // 随手 AI（⌘J）：选中改写 / 光标处起草 / 草稿写清楚；结果以修订装饰呈现，↵ 收下才改文档（viewer 不挂）
      .use(docRail((items) => railStore.push(items))) // 右轨：地标节点挂 data-rail 锚 + 清单推给右轨（两种视图都在跑）
      .use(ensureBlockIds) // 补 id 插件：补缺 + 去重（editable 守卫，幂等）
      .use(editMarksLocal(id, !readOnly)) // 「最近修改」：自己的编辑当场记、远端改动停下后重拉（排在补 id 之后：新块已有 id）
      .use(listEnterKeymap) // 顶层列表条目 Enter 拆独立块（排在合并 keymap 前，嵌套/空条目放行原链路）
      .use(tableTabKeymap) // 表格末格 Tab 自动加行（其余 Tab 放行 gfm 跳格）
      .use(findPlugin) // 页内查找高亮（Ctrl+F/H 的浮条是 React 的 FindBar，插件只管 decoration）
      .use(listNormalize) // 顶层多条目 list 拆分 + 有序续号兜底（undo/redo 守卫，幂等）
      .use(pageRefSchema) // 子页面块节点：公开页/协同对端 schema 必须同名同 attrs
      .use(collectionInlineSchema) // 「集合」块（块拥有数据）：PublicPage 也注册（未注册的节点会让对端整页解析失败）
      .use(collectionLinkSchema) // 「链接视图」块：同上
      .use(collectionBlockViews({ hostId: id, editable: !readOnly, navigate, onChanged })) // 块里挂 React 根画集合（公开页不挂：toDOM 占位）
      .use(collectionPaste) // 粘贴进来的「集合」块一律变「链接视图」（粘贴不产生新的所有者）
      .use(pageMentionSchema) // @ 页面引用 chip（行内原子）：PublicPage 也注册（对端文档可能含它）
      .use(agentMentionSchema) // @ agent 点名 chip（行内原子）：PublicPage 也注册（对端文档可能含它）
      .use(userMentionSchema) // @ 成员 chip（行内原子）：PublicPage 也注册（对端文档可能含它）
      .use(mentionUpgrade) // 协同正文晚于打开页定时器到达时，原文仍要升成 chip
      .use(codeBlockView) // 代码块外壳：语言下拉 / 复制 / mermaid 图（PublicPage 同款）
      .use(activeBlock) // 光标所在代码块 / 公式块 / 表格挂 is-active（外壳据此显示源码 / 按钮）
      .use(codeHighlight) // 代码高亮装饰（高亮库按需加载）
      .use(mathInlineSchema) // 行内公式（PublicPage 同款；未注册的节点会让对端整页解析失败）
      .use(mathBlockSchema) // 公式块
      .use(mathInlineView) // KaTeX 画 + 点开编辑弹层
      .use(mathBlockView) // 画出来的结果 + 光标进块显示源码
      .use(mathInlineInputRule) // $x$ → 行内公式
      .use(mathBlockInputRule) // 段首 $$ → 公式块
      .use(calloutSchema) // 提示框（以下五种块 PublicPage 同表注册，未注册的节点会让对端整页解析失败）
      .use(calloutView) // 图标换类型 / 标题输入 / 可折叠
      .use(toggleSchema) // 折叠块
      .use(toggleView) // 箭头（展开状态只在本机）
      .use(toggleKeys) // 收起时摘要末尾回车 = 在折叠块后面开新段
      .use(tocSchema) // 目录
      .use(tocView)
      .use(tocRefresh) // 文档变了目录跟着重算
      .use(columnsSchema) // 分栏（栏里的块各自可寻址，手柄按横坐标下钻）
      .use(columnSchema)
      .use(embedSchema) // 嵌入：网页 / 视频 / 音频（toDOM 直接画播放器）
      .use(tableView) // 表格外壳：「⋯」操作菜单 + 拖列宽（公开页不挂：toDOM 已按列宽画 colgroup）
      .use(imageDisplaySchema) // image schema 覆盖（同名单节点原位替换）：视图层把本站上传图片渲染成 webp display 版
      .use(attachmentSchema) // 附件块节点：公开页/协同对端 schema 必须同名同 attrs
      .use(blockRefSchema) // 块提及 chip（行内）：PublicPage 也注册（剪贴板往返/对端文档可能含它）
      .use(blockSyncSchema) // 同步块节点：PublicPage 也注册（toDOM 静态占位）
      .use(blockSyncView) // 同步块 nodeView（仅编辑器挂：自持 provider 实时拉源页）
      .use(blockLinkPaste) // 粘贴块链接 → 三选弹窗（editable 守卫，PublicPage 不挂）
      .use(uploadPlugin) // 粘贴/拖拽文件上传（readOnly 实例插件内部有 editable 守卫）
      .use(lightboxPlugin) // 点图片全屏看原图 + 附件卡片在编辑器内的下载点击接管
      .use(extraInputRules)
      .use(taskToggle) // 点待办复选框（::before 无 DOM）翻转 checked
      .use(
        docMention({
          pages: () => pagesRef.current,
          agents: agentList,
          pageId: id,
          enabled: !readOnly,
          // `[[新名字`：建当前页的子页（同空间），建好广播刷新侧栏
          createPage: async (title) => {
            const created = await api.createPage(id, pagesRef.current?.find((p) => p.id === id)?.space_id, { title })
            onChanged()
            return created
          },
        }),
      ) // 正文引用菜单：@ 大菜单（Agent / 页面 / Skill / 成员），[[ 提及或新建页面
      .use(slash)
      .use(slashSession) // 斜杠菜单的一次性触发会话（只有刚打出 / 才弹，见 trigger-session.ts）
      .use(blankClick) // 点正文下方空白处：末尾补空段落并落光标（只读不生效）
      .use(collab)
      .use(imageItemMark) // 纯图片列表条目不画符号
      .use(listDrag) // 嵌套列表条目拖拽：handleDrop 全接管 li slice + 三段落点指示线
      // 拖顶层块到 page_ref → 整块进目标页。PM someProp 按注册顺序咨询 handleDrop：listDrag
      // 对「块源落非列表/非条目」返回 false，本插件接住 page_ref 落点；li 源落 page_ref 被
      // listDrag 提前挡掉（no-op），条目粒度跨页不支持（见 page-drop.ts）
      .use(createPageDrop(() => id))
      .use(selectBlocks)
      .use(sourceWatch) // 源码模式（CodeMirror）：正文变了（别人 / agent 改的）通知源码会话回流
      .use(undoRedo)
      .create()
      .then((instance) => {
        if (destroyed) {
          void instance.destroy()
          return
        }
        editor = instance
        editorRef.current = instance
        editorPageIdRef.current = id // 改名跟随 effect 的「编辑器属于当前页」门阘（见该 effect 注释）
        setEditorTick((t) => t + 1) // 编辑器建好：改名跟随补跑一次（打开页面时 pages 可能早已不变）
        instance.action((ctx) => {
          const service = ctx.get(collabServiceCtx)
          service.bindDoc(provider.document)
          if (provider.awareness) service.setAwareness(provider.awareness)
          service.connect()
        })
        scheduleMigrate() // 转换 pass 触发点一：编辑器创建后（IDB 缓存的旧行内链接随即归一化）
        drainQuotes() // 别页排进来的「引用」：本页已同步过才放（与 ws synced 那一处互补，两个条件都满足才动）
      })
      .catch(console.error)

    // 标题协作编辑器：与正文同一 provider（复用连接与 awareness），绑独立 title fragment
    titleSession.normalize()
    const titleView = titleSession.mount(titleRef.current, focusBodyFromTitle)
    if (titleView) titleViewRef.current = titleView
  }

  // 别页「引用」排进来的块引用（过程页的步骤等，见 quote-queue.ts）：放进本页正在写的消息。同步完且编辑器建好才动：
  // 同步前放，新增的消息块会与随后到达的正文并发合并，位置错乱。两个触发点（编辑器建好 / ws synced）互补，条件都满足才排空。
  const drainQuotes = () => {
    if (readOnly || !syncedOnce || !editor || destroyed) return
    const quotes = takeQuotes(id)
    if (quotes.length === 0) return
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      for (const q of quotes) quoteIntoDraft(view, q)
    })
  }

  provider.on('synced', () => {
    // syncedOnce 只在 ws synced 置位：语义是「服务端确认过」（供 close 时 IDB 清缓存判定）。
    // idb 的 synced 只说明本地数据加载完，不代表服务端认可，不能置位
    syncedOnce = true
    tryStart()
    drainQuotes()
    titleSession.normalize() // ws 合并后才出现的多段标题在此收掉
    scheduleMigrate() // 转换 pass 触发点二：ws synced 后（远端广播的增量里可能还有旧行内链接）
    setEditorTick((t) => t + 1) // ?block= 直访定位的第二个尝试时机（老文档的块 id 随首笔同步补齐）
  })
  idb.on('synced', tryStart)

  return () => {
    destroyed = true
    setPageDropBridge(null) // 跨页搬块桥随本页编辑器失效（旧桥会把块搬出旧页面）
    unbindSpace()
    unbindView()
    // 摘标题观察；防抖中的标题写库立刻补写，不能丢（标题视图在下方异步销毁链里才拆，此刻还读得到）
    titleSession.stop()
    linkWatcher.destroy() // 置 destroyed 门闩并清防抖 timer
    // 与上面的 idb.on('synced', tryStart) 对称移除：卸载后迟到的 idb synced 不再触碰本 effect
    // 状态（库连接本身由串行链最末的 idb.destroy() 关闭，不受此处影响）
    idb.off('synced', tryStart)
    if (migrateTimer !== undefined) window.clearTimeout(migrateTimer) // 转换 pass：卸载清 timer（回调内另有 destroyed 门阘）
    editorPageIdRef.current = undefined // 同步清：改名跟随 effect 不再触碰异步销毁中的旧编辑器
    titleViewRef.current = null
    providerRef.current = undefined // 聊天模式取不到旧 doc（视图本身已在组件卸载/key 变更时先行销毁）
    provider.awareness?.off('change', onAwareness)
    setPeers([]) // 换页 / 卸载：旧页的人不留在顶栏
    // y-prosemirror 1.3.7 缺陷：yCursorPlugin 把 awareness 广播的 dispatch 用
    // timeout(0) 延迟（setMeta→updateMetas），而 updateMetas 的 binding.isDestroyed 守卫
    // 永不生效（binding.destroy() 从不置位该标志）→ 销毁期间的任何广播都会延迟打进已
    // 销毁视图：title 报 matchesNode TypeError、body 经 milkdown ctx 报 editorState not found。
    // 销毁一开始就静音该 awareness 的事件流：此时没有任何人需要 awareness。
    const aw = provider.awareness as { emit?: (event: string, ...args: unknown[]) => void } | undefined
    if (aw?.emit) aw.emit = () => {}
    // 销毁顺序不能反：milkdown 的 destroy 是异步的。若先拆标题/provider，它们销毁时的
    // awareness 广播（yCursorPlugin.destroy → setLocalStateField(null)）会打进正文
    // 还没拆完的 yCursorPlugin → view.dispatch → 而 editorState ctx 已被销毁清掉 →
    // MilkdownError: Context "editorState" not found。必须先等正文编辑器
    // 销毁完（监听全摘），再拆标题视图与 provider，全部串行后无人再往死 ctx 派发。
    void (async () => {
      if (editor) await editor.destroy()
      titleSession.destroyView()
      provider.destroy()
      // IDB 拆在链条最末（创建顺序 provider→idb，销毁反序）：只关库连接，与 awareness 广播
      // 无关，无需等待。拒绝清缓存走上面 close 监听里的 clearData（= destroy + deleteDB）
      void idb.destroy().catch((err: unknown) => console.error('idb destroy failed:', err))
    })().catch((err: unknown) => console.error('editor teardown failed:', err))
  }
}
