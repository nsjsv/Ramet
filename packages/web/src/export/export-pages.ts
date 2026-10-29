/* ---------- 导出编排：打包 zip ----------
 * 序列化一律用活编辑器的 serializerCtx 与 schema（见 export-doc.ts 的说明）：别的页面的正文从服务端拿 Yjs 状态，
 * 在浏览器里用同一个 schema 解成 PM 文档再序列化，与历史版本预览解快照是同一招。
 *
 * zip 的布局（每页一个「页面包」，扁平，Hugo / VitePress 可直接放进内容目录）：
 *   <页面名>/index.md          front matter（title / date / parent）+ 正文
 *   <页面名>/<图片或附件>       这页用到的文件，markdown 里用同目录相对路径引用
 * 页面之间的链接是 `../<另一页的目录>/`。子页不嵌套成目录（Hugo 里 index.md 与子目录并存会把子目录吞成资源），
 * 层级写在 front matter 的 parent 里。 */

import { editorViewCtx, schemaCtx, serializerCtx, type Editor } from '@milkdown/kit/core'
import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'
import { api, type ExportPage } from '../api'
import { assetToken, exportDoc, type AssetKind, type ExportContext } from './export-doc'
import { buildZip, type ZipFile } from './zip-write'

/** 页面名转文件夹名：去掉路径非法字符，空白换连字符，限长；空则 untitled */
export function slugOf(title: string): string {
  const slug = title
    .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return slug || 'untitled'
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

/** created_at 是 now()::text（形如 `2026-10-12 00:41:47.123+00`），Safari 不认，规整成 ISO */
function isoOf(raw: string): string | null {
  const d = new Date(raw.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function frontMatter(page: ExportPage, slugs: Map<string, string>): string {
  const lines = ['---', `title: ${JSON.stringify(page.title || '无标题')}`]
  const date = isoOf(page.createdAt)
  if (date) lines.push(`date: ${date}`)
  const parent = page.parentId ? slugs.get(page.parentId) : undefined
  if (parent) lines.push(`parent: ${JSON.stringify(parent)}`)
  lines.push('---', '')
  return lines.join('\n')
}

const decodeBase64 = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))

/** 从活编辑器取序列化器 / schema / 当前文档；编辑器销毁中返回 null */
function grab(editor: Editor): { serialize: (doc: PMNode) => string; schema: Schema; doc: PMNode } | null {
  let out: { serialize: (doc: PMNode) => string; schema: Schema; doc: PMNode } | null = null
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      if (!view.isDestroyed) out = { serialize: ctx.get(serializerCtx), schema: ctx.get(schemaCtx), doc: view.state.doc }
    })
  } catch {
    return null
  }
  return out
}

async function fetchAsset(id: string, kind: AssetKind, name: string): Promise<{ file: string; data: Uint8Array } | null> {
  try {
    // 固定走源站：图片可能 302 到图床，跟过去就成了跨域请求
    const res = await fetch(`/api/files/${id}?direct=1`)
    if (!res.ok) return null
    const data = new Uint8Array(await res.arrayBuffer())
    if (kind === 'image') {
      const ext = EXT_BY_TYPE[(res.headers.get('content-type') ?? '').split(';')[0]!.trim()] ?? 'bin'
      return { file: `${id}.${ext}`, data }
    }
    return { file: `${id.slice(0, 8)}-${slugOf(name || '附件')}`, data }
  } catch {
    return null
  }
}

/** 并发 limit 个地取完全部（顺序无关） */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await work(items[i]!)
      }
    }),
  )
  return out
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 打包这一页和它的子页，返回没能下载的文件个数（链接保留成在线地址）。取不到页面或编辑器没了就抛错 */
export async function exportZip(editor: Editor, pageId: string, agentLabel: (id: string) => string): Promise<{ warnings: number; truncated: boolean }> {
  const live = grab(editor)
  if (!live) throw new Error('编辑器未就绪')
  const { pages, truncated } = await api.exportPage(pageId)

  const slugs = new Map<string, string>()
  const taken = new Set<string>()
  for (const page of pages) {
    const base = slugOf(page.title)
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
    taken.add(slug)
    slugs.set(page.id, slug)
  }

  let warnings = 0
  const rendered: Array<{ page: ExportPage; slug: string; markdown: string; assets: ExportContext['assets'] }> = []
  for (const page of pages) {
    const assets: ExportContext['assets'] = new Map()
    try {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, decodeBase64(page.state))
      const pm = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('prosemirror'), live.schema)
      const ctx: ExportContext = { schema: live.schema, dirOf: (id) => slugs.get(id), agentLabel, assets }
      rendered.push({ page, slug: slugs.get(page.id)!, markdown: live.serialize(exportDoc(pm, ctx)).trim(), assets })
    } catch (err) {
      console.error(`导出页面失败(${page.id})`, err)
      warnings++
    }
  }

  // 文件：同一个文件只下一次（各页面包各放一份）
  const wanted = new Map<string, { kind: AssetKind; name: string }>()
  for (const r of rendered) for (const [id, a] of r.assets) if (!wanted.has(id)) wanted.set(id, a)
  const entries = [...wanted]
  const fetched = await pool(entries, 4, ([id, a]) => fetchAsset(id, a.kind, a.name))
  const got = new Map(entries.map(([id], i) => [id, fetched[i] ?? null]))

  const docs: ZipFile[] = []
  const assetFiles: ZipFile[] = []
  for (const r of rendered) {
    let md = r.markdown
    for (const id of r.assets.keys()) {
      const asset = got.get(id)
      if (asset) {
        md = md.replaceAll(assetToken(id), asset.file)
        assetFiles.push({ path: `${r.slug}/${asset.file}`, data: asset.data, store: true })
      } else {
        // 没下下来：保留成在线地址，导出照常完成（调用方提示有几个文件没打进去）
        md = md.replaceAll(assetToken(id), `${location.origin}/api/files/${id}`)
        warnings++
      }
    }
    docs.push({ path: `${r.slug}/index.md`, data: `${frontMatter(r.page, slugs)}\n${md}\n` })
  }

  const root = slugs.get(pageId) ?? 'export'
  download(await buildZip([...docs, ...assetFiles]), `${root}.zip`)
  return { warnings, truncated }
}
