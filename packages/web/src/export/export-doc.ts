/* ---------- 导出：把页面文档换成「标准 markdown 能表达」的形态 ----------
 * 导出的 markdown 由编辑器自己的序列化产出（不在别处另写一套）。但编辑器里有一批自定义节点，它们的 toMarkdown 是给源码模式
 * 往返设计的降级链接（`[name](/api/files/…)`、`[标题](/page/<id>)`、`>> 消息`），直接拿去给博客引擎没法用。
 * 所以序列化之前先过一遍这里：把自定义节点换成标准节点（段落 / 引用 / 链接 / 图片），再交给编辑器的序列化器。
 *
 * 形态约定：
 *   图片 / 附件        → 页面目录里的文件，相对路径
 *   子页面块 / @ 页面  → 导出集合里有 → 相对链接 `../<目录>/`，没有 → 纯文字标题
 *   用户消息           → 引用块，首行加粗「你」
 *   AI 回复            → 首行加粗 agent 名字，后面是回复内容原样
 *   过程页步骤         → 一行普通段落（动词 + 文字）
 *   块提及 / agent 点名 → 纯文字（引用时的快照 / `@名字`）；同步块 →「（同步块）」
 * 纯函数：不碰网络、不碰编辑器视图；资源（图片 / 附件）只登记不下载，由 export-pages.ts 打包时取。 */

import { Fragment, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { stepVerb } from '@ramet/shared/run-model'

const FILE_URL = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/display)?$/i

export type AssetKind = 'image' | 'attachment'

export interface ExportContext {
  schema: Schema
  /** 页面 id 对应的打包后目录名；不在这次导出里返回 undefined */
  dirOf(pageId: string): string | undefined
  /** agent catalog id → 展示名 */
  agentLabel(agentId: string): string
  /** 本页用到的文件（key = 文件 id） */
  assets: Map<string, { kind: AssetKind; name: string }>
}

/** 序列化出来的 markdown 里占位的资源地址（打包时下载完再换成文件名）。只含 URL 安全字符，序列化器不会转义 */
export const assetToken = (fileId: string): string => `ramet-asset-${fileId}`

function fileUrl(src: string, kind: AssetKind, name: string, ctx: ExportContext): string {
  const id = FILE_URL.exec(src)?.[1]
  if (!id) return src // 外链原样
  if (!ctx.assets.has(id)) ctx.assets.set(id, { kind, name })
  return assetToken(id)
}

/** 页面链接：导出集合里的相对链接，不在集合里没有链接（null） */
function pageHref(pageId: string, ctx: ExportContext): string | null {
  const dir = ctx.dirOf(pageId)
  return dir ? `../${dir}/` : null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 带可选链接的行内文字（空文字给个兜底，PM 不允许空文本节点） */
function inlineText(ctx: ExportContext, text: string, href: string | null, fallback: string): PMNode {
  const label = text.trim() || fallback
  const link = href ? ctx.schema.marks.link?.create({ href }) : undefined
  return ctx.schema.text(label, link ? [link] : [])
}

const paragraph = (ctx: ExportContext, ...inline: PMNode[]): PMNode => ctx.schema.nodes.paragraph!.create(null, inline)

function boldLine(ctx: ExportContext, label: string): PMNode | null {
  const strong = ctx.schema.marks.strong
  return label && strong ? paragraph(ctx, ctx.schema.text(label, [strong.create()])) : null
}

function mapChildren(node: PMNode, ctx: ExportContext): PMNode[] {
  const out: PMNode[] = []
  node.forEach((child) => out.push(...mapNode(child, ctx)))
  return out
}

function mapNode(node: PMNode, ctx: ExportContext): PMNode[] {
  switch (node.type.name) {
    case 'image':
      return [node.type.create({ ...node.attrs, src: fileUrl(str(node.attrs.src), 'image', str(node.attrs.alt), ctx) }, null, node.marks)]
    case 'embed': {
      // 上传的音视频（站内文件）：打包进 zip；外链原样
      const src = str(node.attrs.src)
      const kind = str(node.attrs.kind)
      return [node.type.create({ ...node.attrs, src: fileUrl(src, 'attachment', kind === 'audio' ? 'audio' : 'video', ctx) })]
    }
    case 'attachment': {
      const name = str(node.attrs.name)
      return [paragraph(ctx, inlineText(ctx, name, fileUrl(str(node.attrs.src), 'attachment', name, ctx), '附件'))]
    }
    case 'page_ref': {
      const pageId = str(node.attrs.pageId)
      return [paragraph(ctx, inlineText(ctx, str(node.attrs.title), pageHref(pageId, ctx), '新页面'))]
    }
    case 'page_mention':
      return [inlineText(ctx, str(node.attrs.title), pageHref(str(node.attrs.pageId), ctx), '新页面')]
    case 'block_ref':
      return [inlineText(ctx, str(node.attrs.text), null, '块引用')]
    case 'block_sync':
      return [paragraph(ctx, ctx.schema.text('（同步块）'))]
    case 'collection_inline':
    case 'collection_link':
      // 集合与行不导出：留一行集合名，不带 collection: 降级链接
      return [paragraph(ctx, ctx.schema.text(`（集合：${str(node.attrs.title).trim() || '无标题'}）`))]
    case 'agent_mention':
      return [ctx.schema.text(`@${str(node.attrs.label) || ctx.agentLabel(str(node.attrs.agentId))}`)]
    case 'user_mention':
      return [ctx.schema.text(`@${str(node.attrs.name) || '成员'}`)]
    case 'user_message': {
      const label = boldLine(ctx, '你')
      return [ctx.schema.nodes.blockquote!.create(null, [...(label ? [label] : []), ...mapChildren(node, ctx)])]
    }
    case 'agent_reply': {
      const label = boldLine(ctx, ctx.agentLabel(str(node.attrs.agent)))
      return [...(label ? [label] : []), ...mapChildren(node, ctx)]
    }
    case 'run_step': {
      const verb = stepVerb(str(node.attrs.k), str(node.attrs.kind))
      const text = node.textContent.trim()
      return [paragraph(ctx, ctx.schema.text(`${verb} ${text}`.trim() || '步骤'))]
    }
    default:
      if (node.isLeaf) return [node]
      return [node.copy(Fragment.fromArray(mapChildren(node, ctx)))]
  }
}

/** 把页面文档（schema 的 doc 根节点）换成只含标准节点的 doc */
export function exportDoc(doc: PMNode, ctx: ExportContext): PMNode {
  return doc.copy(Fragment.fromArray(mapChildren(doc, ctx)))
}
