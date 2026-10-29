/* ---------- Markdown / Obsidian 导入：规划与改写（纯函数） ----------
 * 输入一包文件（zip 解开的条目 / 单个 .md），产出要建的页面树与每页改写后的 markdown；读写库在 routes/import.ts。
 *   - 目录 → 页面（标题 = 目录名）；目录里与目录同名的 .md、index.md、README.md 是这个目录页自己的正文（folder note）。
 *   - .md → 页面（标题 = front matter 的 title，没有就是文件名）。隐藏文件 / 目录（.obsidian、.trash……）跳过。
 *   - `[[名字]]` / `[[名字|别名]]` / `[[路径/名字#标题]]` → 页面提及（认不出的退成文字）；
 *     `![[图片]]` → 图片，`![[视频 / 音频]]` → 播放器，`![[别的文件]]` → 附件，`![[笔记]]` → 页面提及；
 *     相对路径的 markdown 链接 / 图片按所在目录解析（找不到再按文件名全库找，同 Obsidian）；指向 .md 的链接 → 页面提及。
 *   - front matter 去掉；Obsidian 注释 `%%…%%` 去掉；代码块 / 行内代码里的内容一律不动。
 * 附件此时还没上传：改写时写占位记号 `ramet-asset:<n>`，路由上传完再换成 `/api/files/<id>`（只上传被引用的文件）。
 * 解析成块后再收两处形状（finishBlocks）：`page:<id>` 链接 → page_mention 原子；单独成段的附件链接 → attachment 块。 */

import type { Block, Inline } from '@ramet/shared/markdown-blocks'

export type ImportFile = { path: string; data: Buffer }

export type PlannedPage = {
  key: string
  id: string
  parentKey: string | null
  /** 文件名 / 目录名推出的标题（front matter 的 title 改写时再覆盖） */
  title: string
  /** 正文来自哪个 .md（目录页没有 folder note 时为 null） */
  mdPath: string | null
}

export const MD_RE = /\.(md|markdown)$/i

export function isHidden(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')
}

const baseName = (path: string): string => path.split('/').pop() ?? path
const stem = (path: string): string => baseName(path).replace(/\.[^.]+$/, '')
const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/')

/** 是不是所在目录的 folder note（与目录同名 / index / README） */
function isFolderNote(path: string): boolean {
  const dir = dirOf(path)
  if (!dir) return false
  const name = stem(path).toLowerCase()
  return name === baseName(dir).toLowerCase() || name === 'index' || name === 'readme'
}

const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })

/** 规划页面树（按路径自然序；目录在它的内容之前） */
export function planPages(files: ImportFile[], newId: () => string): PlannedPage[] {
  const mds = files.filter((f) => MD_RE.test(f.path) && !isHidden(f.path)).map((f) => f.path)
  mds.sort((a, b) => collator.compare(a, b))
  const pages = new Map<string, PlannedPage>()
  const dirPage = (dir: string): string | null => {
    if (!dir) return null
    const key = `dir:${dir}`
    if (!pages.has(key)) {
      const parentKey = dirPage(dirOf(dir))
      pages.set(key, { key, id: newId(), parentKey, title: baseName(dir), mdPath: null })
    }
    return key
  }
  for (const path of mds) {
    const dir = dirOf(path)
    if (isFolderNote(path)) {
      const key = dirPage(dir)!
      const page = pages.get(key)!
      if (!page.mdPath) {
        page.mdPath = path
        continue
      }
    }
    const parentKey = dirPage(dir)
    pages.set(`md:${path}`, { key: `md:${path}`, id: newId(), parentKey, title: stem(path), mdPath: path })
  }
  return [...pages.values()]
}

/* ---------- 链接解析 ---------- */

export type AssetKind = 'image' | 'video' | 'audio' | 'file'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i

export function assetKind(path: string): AssetKind {
  return IMAGE_EXT.test(path) ? 'image' : VIDEO_EXT.test(path) ? 'video' : AUDIO_EXT.test(path) ? 'audio' : 'file'
}

/** 规整一个相对路径（解掉 . 与 ..；越出根目录 = null） */
function joinPath(dir: string, rel: string): string | null {
  const out = dir ? dir.split('/') : []
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

export class LinkIndex {
  private pagesByPath = new Map<string, PlannedPage>()
  private pagesByName = new Map<string, PlannedPage>()
  private assetsByPath = new Map<string, string>()
  private assetsByName = new Map<string, string>()

  constructor(pages: PlannedPage[], files: ImportFile[]) {
    for (const page of pages) {
      const path = page.mdPath ?? page.key.slice(4)
      const noExt = page.mdPath ? page.mdPath.replace(MD_RE, '') : path
      if (page.key.startsWith('dir:')) this.addPage(page.key.slice(4), page)
      this.addPage(noExt, page)
    }
    for (const file of files) {
      if (MD_RE.test(file.path) || isHidden(file.path)) continue
      this.assetsByPath.set(file.path.toLowerCase(), file.path)
      const name = baseName(file.path).toLowerCase()
      if (!this.assetsByName.has(name)) this.assetsByName.set(name, file.path)
    }
  }

  private addPage(path: string, page: PlannedPage): void {
    const lower = path.toLowerCase()
    if (!this.pagesByPath.has(lower)) this.pagesByPath.set(lower, page)
    const name = baseName(lower)
    if (!this.pagesByName.has(name)) this.pagesByName.set(name, page)
  }

  /** `[[目标]]` / 相对链接 → 页面；先按所在目录的相对路径，再按库内路径，最后按名字 */
  page(target: string, fromDir: string): PlannedPage | null {
    const clean = target.replace(MD_RE, '').toLowerCase()
    if (!clean) return null
    const rel = joinPath(fromDir.toLowerCase(), clean)
    return (rel !== null ? this.pagesByPath.get(rel) : undefined) ?? this.pagesByPath.get(clean) ?? this.pagesByName.get(baseName(clean)) ?? null
  }

  asset(target: string, fromDir: string): string | null {
    const lower = target.toLowerCase()
    const rel = joinPath(fromDir.toLowerCase(), lower)
    return (rel !== null ? this.assetsByPath.get(rel) : undefined) ?? this.assetsByPath.get(lower) ?? this.assetsByName.get(baseName(lower)) ?? null
  }
}

/* ---------- markdown 改写 ---------- */

export const ASSET_TOKEN = 'ramet-asset:'

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

function frontMatterTitle(yaml: string): string | null {
  const m = /^title:[ \t]*(.+)$/m.exec(yaml)
  return m ? m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2').trim() || null : null
}

function decode(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** 行内代码之外的片段过一遍 fn（反引号串按长度配对，同 CommonMark） */
function outsideInlineCode(line: string, fn: (text: string) => string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const tick = line.indexOf('`', i)
    if (tick < 0) break
    let run = 1
    while (line[tick + run] === '`') run += 1
    const fence = '`'.repeat(run)
    const close = line.indexOf(fence, tick + run)
    if (close < 0) break
    out += fn(line.slice(i, tick)) + line.slice(tick, close + run)
    i = close + run
  }
  return out + fn(line.slice(i))
}

export type RewriteResult = { text: string; title: string | null; assets: string[] }

/** 一页 markdown 改写：去 front matter / 注释，双链与相对链接换成站内形态。assets = 引用到的附件路径（占位记号的序号） */
export function rewriteMarkdown(markdown: string, fromDir: string, index: LinkIndex): RewriteResult {
  let text = markdown.replace(/^﻿/, '')
  let title: string | null = null
  const fm = FRONT_MATTER_RE.exec(text)
  if (fm) {
    title = frontMatterTitle(fm[1] ?? '')
    text = text.slice(fm[0].length)
  }
  const assets: string[] = []
  const assetRef = (path: string): string => {
    let n = assets.indexOf(path)
    if (n < 0) n = assets.push(path) - 1
    return `${ASSET_TOKEN}${n}`
  }
  const mention = (target: string, label?: string): string => {
    const page = index.page(target.split('#')[0]!.trim(), fromDir)
    return page ? `[@${(page.title || label || target).replace(/[[\]]/g, '')}](page:${page.id})` : (label ?? target)
  }
  const embedAsset = (path: string, label: string): string => {
    const ref = assetRef(path)
    const kind = assetKind(path)
    if (kind === 'image') return `![${label}](${ref})`
    if (kind === 'video' || kind === 'audio') return `\n\n<${kind} src="${ref}" controls preload="none"></${kind}>\n\n`
    return `[${label}](${ref})`
  }

  const rewriteSpan = (span: string): string =>
    span
      .replace(/%%[^%]*%%/g, '')
      .replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (whole, target: string) => {
        const clean = target.trim()
        const asset = index.asset(clean, fromDir)
        if (asset) return embedAsset(asset, baseName(asset))
        return index.page(clean.split('#')[0]!, fromDir) ? mention(clean) : whole
      })
      .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_whole, target: string, alias?: string) => mention(target.trim(), alias?.trim() || undefined))
      .replace(/(!?)\[([^\]]*)\]\(<?([^)\s>]+)>?(\s+"[^"]*")?\)/g, (whole, bang: string, label: string, rawTarget: string) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith('/') || rawTarget.startsWith('#')) return whole
        const target = decode(rawTarget.split('#')[0]!)
        if (MD_RE.test(target) || (!bang && index.page(target, fromDir) && !index.asset(target, fromDir))) {
          return index.page(target, fromDir) ? mention(target, label) : label || whole
        }
        const asset = index.asset(target, fromDir)
        if (!asset) return whole
        return bang ? embedAsset(asset, label || baseName(asset)) : `[${label || baseName(asset)}](${assetRef(asset)})`
      })

  let fence: string | null = null
  const lines = text.split('\n').map((line) => {
    const open = FENCE_RE.exec(line)
    if (fence) {
      if (open && open[1]!.startsWith(fence[0]!) && open[1]!.length >= fence.length) fence = null
      return line
    }
    if (open) {
      fence = open[1]!
      return line
    }
    return outsideInlineCode(line, rewriteSpan)
  })
  // 跨行的 %% 注释 %%（代码块外）
  text = lines.join('\n').replace(/%%[\s\S]*?%%/g, '')
  return { text, title, assets }
}

/* ---------- 块收尾 ---------- */

const PAGE_HREF_RE = /^page:([0-9a-f-]{36})$/i
const FILE_HREF_RE = /^\/api\/files\/([0-9a-f-]{36})$/i

function linkHref(inline: Inline): string | null {
  if (!('text' in inline)) return null
  const link = inline.marks.find((m) => m.name === 'link')
  return link && typeof link.attrs.href === 'string' ? link.attrs.href : null
}

function finishInlines(inlines: Inline[]): Inline[] {
  return inlines.map((inline) => {
    const m = PAGE_HREF_RE.exec(linkHref(inline) ?? '')
    if (!m || !('text' in inline)) return inline
    return { atom: 'page_mention', attrs: { pageId: m[1]!.toLowerCase(), title: inline.text.replace(/^@/, '') } }
  })
}

/** page: 链接 → 页面提及；单独成段的站内附件链接 → 附件块（files = 上传结果，url → 文件名 / 大小） */
export function finishBlocks(blocks: Block[], files: Map<string, { name: string; size: number }>): Block[] {
  return blocks.map((block) => {
    if (block.name === 'paragraph' && block.inlines?.length === 1) {
      const href = linkHref(block.inlines[0]!)
      const file = href && FILE_HREF_RE.test(href) ? files.get(href) : undefined
      if (href && file) return { name: 'attachment', attrs: { src: href, name: file.name, size: file.size } }
    }
    return {
      ...block,
      ...(block.inlines ? { inlines: finishInlines(block.inlines) } : {}),
      ...(block.blocks ? { blocks: finishBlocks(block.blocks, files) } : {}),
    }
  })
}
