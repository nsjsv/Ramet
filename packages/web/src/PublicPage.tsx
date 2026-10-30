import { useEffect, useRef, useState } from 'react'
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom'
import * as Y from 'yjs'
import { Editor, rootCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/kit/core'
import { gfm } from '@milkdown/kit/preset/gfm'
import { ySyncPlugin } from 'y-prosemirror'
import { $prose } from '@milkdown/kit/utils'
import type { EditorView } from '@milkdown/kit/prose/view'
import { api, type PageIcon as PageIconValue, type PublicPageTree, type User } from './api'
import { COPY } from './copy'
import { RunFoot, RunHead, type RunDetail } from './editor/run-board'
import { PageIcon } from './PageIcon'
import { collectionInlineSchema, collectionLinkSchema } from './editor/collection-block'
import { pageRefSchema } from './editor/page-ref'
import { agentMentionSchema } from './editor/agent-mention'
import { userMentionSchema } from './editor/user-mention'
import { mentionUpgrade } from './editor/mention-upgrade'
import { pageMentionSchema } from './editor/page-mention'
import { blockIdSchemas, commonmarkPreset, focusBlockById } from './editor/block-id'
import { focusTextAnchor, textFlash, textParam } from './editor/text-anchor'
import { runStepSchema } from './editor/run-step'
import { runStepView } from './editor/run-step-view'
import { setRunInfo } from './editor/run-store'
import { aiBlockView } from './editor/ai-block'
import { agentReplySchema, messageDeleteKeymap, messageEnterView, userMessageSchema } from './editor/message-blocks'
import { attachmentSchema } from './editor/attachment'
import { blockRefSchema } from './editor/block-ref'
import { rametDialect } from './editor/md-dialect'
import { highlightSchema, textColorSchema } from './editor/color-marks'
import { codeBlockView } from './editor/code-view'
import { activeBlock } from './editor/active-block'
import { codeHighlight } from './editor/code-highlight'
import { mathBlockSchema, mathInlineSchema } from './editor/math'
import { calloutSchema, calloutView } from './editor/callout'
import { toggleSchema, toggleView } from './editor/toggle'
import { tocRefresh, tocSchema, tocView } from './editor/toc'
import { columnSchema, columnsSchema } from './editor/columns'
import { embedSchema } from './editor/embed'
import { mathBlockView, mathInlineView } from './editor/math-view'
import { underlineSchema } from './editor/underline'
import { blockSyncSchema } from './editor/block-sync'
import { imageDisplaySchema, imageView, lightboxPlugin } from './editor/media'

/* ---------- 公开预览页（/p/:id）----------
 * 游离在登录壳之外：匿名可看，无侧边栏、无编辑入口、无历史版本。
 * 数据是并行的 publicTree + publicDoc（404 / 网络错一律「页面不存在或未公开」）；
 * 正文是 base64 update 灌进本地 Y.Doc，再由 Milkdown 只读实例渲染（ySyncPlugin 绑本地 fragment，
 * 无 provider、无协同连接；不挂 slash/block/collab/undo 插件）。
 * 静态快照语义：刷新即最新，不做实时协同预览。 */

/** base64 → Uint8Array：公开文档快照走 base64 传输，Y.applyUpdate 只吃 bytes */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 标题文本：title fragment 逐 child toString，多段以空格连接（与服务端 extractTitle 同语义） */
function fragmentTitle(fragment: Y.XmlFragment): string {
  const paragraphs: string[] = []
  fragment.forEach((child) => {
    if (child instanceof Y.XmlElement) {
      const parts: string[] = []
      child.forEach((inner) => {
        if (inner instanceof Y.XmlText) parts.push(inner.toString())
      })
      paragraphs.push(parts.join(''))
    } else {
      paragraphs.push(child.toString())
    }
  })
  return paragraphs.join(' ')
}

type LoadStatus = 'loading' | 'missing' | 'ready'

export default function PublicPage() {
  // 本组件游离在 <Routes> 之外（登录壳之外），RouteContext 无 match：useParams 拿不到参数，
  // 只能用 matchPath 从 location 直接取 id
  const location = useLocation()
  const id = matchPath('/p/:id', location.pathname)?.params.id ?? null
  const navigate = useNavigate()
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [title, setTitle] = useState('')
  // 页面图标：树的根节点即本页（图标是页面元数据，正文快照里没有）
  const [icon, setIcon] = useState<PageIconValue | null>(null)
  // 全宽（页面属性）：换页加载期间沿用上一页的列宽，取到新页再按它（不先缩回窄栏再弹开）
  const [fullWidth, setFullWidth] = useState(false)
  const [run, setRun] = useState<RunDetail | null>(null)
  // 登录探测：undefined = 探测中，null = 匿名（401 即匿名，本组件外无 AuthProvider）
  const [me, setMe] = useState<User | null | undefined>(undefined)
  // 本页的判别：只有 doc 页能「克隆到我的空间」（复制只带 doc 页，过程页克隆必然落空）；取到之前 = null，不摆按钮
  const [kind, setKind] = useState<PublicPageTree['kind'] | null>(null)
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then((u) => {
        if (!cancelled) setMe(u)
      })
      .catch(() => {
        if (!cancelled) setMe(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 取数 + 建只读渲染实例：换页（id 变）销毁重建。?block= 变化也重建：公开页是静态快照，
  // 同页点块引用 chip 等于「重新打开并定位」，重建即新加载语义（快照渲染成本可接受）
  useEffect(() => {
    if (!id) {
      setStatus('missing')
      return
    }
    const params = new URLSearchParams(location.search)
    const blockParam = params.get('block')
    const textAnchor = textParam(params) // ?text=：块内那段字（文字定位链接）
    setStatus('loading')
    setTitle('')
    setIcon(null)
    setKind(null)
    const doc = new Y.Doc()
    let instance: Editor | undefined
    let cancelled = false

    setRun(null)
    Promise.all([api.publicTree(id), api.publicDoc(id)])
      .then(([tree, detail]) => {
        if (cancelled) return
        setStatus('ready')
        Y.applyUpdate(doc, base64ToBytes(detail.data))
        // 过程页：步骤是正文里的块（下面的只读编辑器画），头尾按 record 画
        if (detail.run) {
          const info = { record: detail.run, parent: detail.parent ?? null }
          setRunInfo(id, info) // 步骤块展开详情读这里
          setRun(info)
        }
        // 标题以 doc title fragment 为准（与编辑页所见一致）；fragment 空时回落接口静态标题
        setTitle(fragmentTitle(doc.getXmlFragment('title')) || detail.title || tree.title)
        setIcon(tree.icon)
        setKind(tree.kind)
        setFullWidth(detail.full_width === true)
        const host = hostRef.current
        if (!host) return
        const ySync = $prose(() => ySyncPlugin(doc.getXmlFragment('prosemirror')))
        return Editor.make()
          .config((ctx) => ctx.set(rootCtx, host))
          .config((ctx) =>
            ctx.update(editorViewOptionsCtx, (prev) => ({
              ...prev,
              editable: () => false,
              handleDOMEvents: {
                ...prev.handleDOMEvents,
                // 内链跳转：/page/:x → 公开预览 /p/:x（仅公开子树内的 id 打得开，其余 404）。
                // 外链：只读页普通点击就开（新开标签；contenteditable 里浏览器默认不导航）
                click: (_view, event) => {
                  const a = (event.target as Element | null)?.closest('a')
                  if (!a) return false
                  const href = a.getAttribute('href') ?? ''
                  if (!href) return false
                  if (!href.startsWith('/page/')) {
                    event.preventDefault()
                    window.open(href, '_blank', 'noopener,noreferrer')
                    return true
                  }
                  event.preventDefault()
                  navigate(href.replace(/^\/page\//, '/p/'))
                  return true
                },
              },
              // page_ref 块整行可点（handleClickOn 与上方 a 标签 click 拦截互不覆盖）：
              // 块是 div，closest('a') 拦不到，必须走 handleClickOn。
              // block_ref（提及 chip，行内）/ block_sync（同步块，公开页只渲染静态占位）：跳源页并定位到块
              // page_mention（@ 页面引用 chip，行内）：跳被提及的页面
              handleClickOn: (_view, _pos, node) => {
                const pageId = node.attrs.pageId
                if (typeof pageId !== 'string' || !pageId) return false
                if (node.type.name === 'page_ref' || node.type.name === 'page_mention') {
                  navigate(`/p/${pageId}`)
                  return true
                }
                if (node.type.name === 'block_ref' || node.type.name === 'block_sync') {
                  const blockId = node.attrs.blockId
                  if (typeof blockId !== 'string' || !blockId) return false
                  navigate(`/p/${pageId}?block=${blockId}`)
                  return true
                }
                return false
              },
            })),
          )
          .use(commonmarkPreset) // commonmark 去掉标题 slug 插件（标题 id 是块 id，见 block-id.ts）
          .use(gfm)
          .use(rametDialect) // markdown 方言识别（与 Editor 同表）
          .use(underlineSchema) // 下划线 mark：Y.Doc 里出现未注册 mark 的协同文档会解析失败
          .use(textColorSchema) // 文字颜色（两个宿主同表；未注册的 mark 会让对端解析失败）
          .use(highlightSchema) // 背景高亮
          .use(blockIdSchemas) // 可寻址块的 id attr：只读文档里已存的 id 原样可读（不挂补 id 插件）
          .use(userMessageSchema) // 用户消息块节点：Y.Doc 里出现未注册节点会直接解析失败
          .use(messageDeleteKeymap) // 与 Editor 同表；只读视图 editable=false 直接放行
          .use(messageEnterView) // 与 Editor 同表：新插入的消息块才入场，历史块不播
          .use(agentReplySchema) // AI 回复块节点：同上
          .use(runStepSchema) // 过程页的步骤块：公开的过程页正文就是它们，未注册会整页解析失败
          .use(runStepView(id, { editable: false, back: () => undefined })) // 只读：能展开详情，没有「引用」
          .use(aiBlockView({ loadAgents: false })) // AI 回复块顶栏装饰：匿名访客不拉 agent 目录（401 → 跳登录），icon/名字走回落值
          .use(pageRefSchema) // Y.Doc 里出现 page_ref 元素而 schema 未注册会直接解析失败
          .use(collectionInlineSchema) // 集合块 / 链接视图块：公开页只画 toDOM 静态占位（集合不公开）
          .use(collectionLinkSchema)
          .use(pageMentionSchema) // @ 页面引用 chip（行内原子）：同 page_ref，未注册会解析失败
          .use(agentMentionSchema) // @ agent 点名 chip（行内原子）：编辑端文档可能含它，未注册会解析失败
          .use(userMentionSchema) // @ 成员 chip（行内原子）：同上，未注册会解析失败
          .use(mentionUpgrade)
          .use(codeBlockView) // 代码块外壳（与 Editor 同表；只读：语言不可改，复制 / 图可用）
          .use(activeBlock)
          .use(codeHighlight)
          .use(calloutSchema) // 提示框 / 折叠块 / 目录 / 分栏 / 嵌入（与 Editor 同表）
          .use(calloutView)
          .use(toggleSchema)
          .use(toggleView)
          .use(tocSchema)
          .use(tocView)
          .use(tocRefresh)
          .use(columnsSchema)
          .use(columnSchema)
          .use(embedSchema)
          .use(mathInlineSchema) // 公式（与 Editor 同表）
          .use(mathBlockSchema)
          .use(mathInlineView)
          .use(mathBlockView)
          .use(imageDisplaySchema) // 同 Editor：公开页也走 webp display 版（匿名访客省流量），仅 toDOM 差异，节点类型/attrs 完全一致
          .use(attachmentSchema) // 附件卡片：下载链接 + 尺寸展示，Y.Doc 出现未注册节点会解析失败
          .use(blockRefSchema) // 块提及 chip（行内）：编辑端文档可能含它，点击跳 /p/ 定位
          .use(blockSyncSchema) // 同步块：公开页只渲染 toDOM 静态占位（不挂 nodeView/不连源页）
          .use(textFlash) // 文字定位链接的高亮（同 Editor）
          .use(imageView) // 图片加载占位（同 Editor）
          .use(lightboxPlugin) // 点图片全屏看原图（只读页无上传，不挂 uploadPlugin）
          .use(ySync)
          .create()
          .then((created) => {
            if (cancelled) {
              void created.destroy()
              return
            }
            instance = created
            // ?block= 直访定位：只读实例建好后滚到目标块并闪烁（文档里的块 id 是编辑端已持久化的，
            // 无补 id 插件；找不到静默放弃）
            if (!blockParam) return
            let view: EditorView | undefined
            created.action((ctx) => {
              view = ctx.get(editorViewCtx)
            })
            if (!view) return
            if (textAnchor) focusTextAnchor(view, blockParam, textAnchor)
            else focusBlockById(view, blockParam)
          })
      })
      .catch((err: unknown) => {
        // 404（未公开/不存在，服务端不区分）与网络错一律同一提示，不泄露存在性
        if (cancelled) return
        console.error(err)
        setStatus('missing')
      })

    return () => {
      cancelled = true
      void instance?.destroy()
      doc.destroy()
      // 容器是复用的 React 节点：清掉 PM 留下的内容再重建
      if (hostRef.current) hostRef.current.innerHTML = ''
    }
  }, [id, navigate, location.search])

  async function clone() {
    if (!id || !me) return
    setCloning(true)
    setCloneError(null)
    try {
      const { id: newId } = await api.clonePublicPage(id)
      navigate(`/page/${newId}`) // 跳进自己个人空间里的新副本
    } catch (err) {
      setCloneError(err instanceof Error && err.message ? err.message : COPY.top.cloneFailed)
    } finally {
      setCloning(false)
    }
  }

  const missing = status === 'missing'

  return (
    <div className="public-page">
      <header className="public-topbar">
        <span className="public-brand">Ramet</span>
        {!missing && kind === 'doc' && (
          <span className="public-clone-area">
            {cloneError && <span className="public-clone-error">{cloneError}</span>}
            {me === undefined ? null : me === null ? (
              <Link className="public-login-link" to="/login">
                {COPY.pub.loginToClone}
              </Link>
            ) : (
              <button className="admin-btn primary" disabled={cloning} onClick={() => void clone()}>
                {cloning ? COPY.cloning : COPY.pub.cloneToMine}
              </button>
            )}
          </span>
        )}
      </header>
      <main className={'public-main' + (fullWidth ? ' full-width' : '')}>
        {missing ? (
          <div className="public-missing">
            <p className="public-missing-text">{COPY.pub.missing}</p>
            <Link className="public-missing-link" to="/">
              {COPY.pub.home}
            </Link>
          </div>
        ) : (
          <>
            <h1 className="public-title">
              {/* 图标与标题同排起点：匿名访客同样能看到页面图标 */}
              <PageIcon icon={icon} size="lg" />
              <span className="public-title-text">{title || COPY.untitled}</span>
            </h1>
            {run && <RunHead detail={run} replyHref={(parentId, replyId) => `/p/${parentId}${replyId ? `?block=${replyId}` : ''}`} />}
            <div className="public-body" ref={hostRef} />
            {run && <RunFoot detail={run} />}
          </>
        )}
      </main>
    </div>
  )
}
