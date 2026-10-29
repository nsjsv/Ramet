import { useRef, useState, type DragEvent } from 'react'
import { api, type Page } from './api'
import { buildZip, type ZipFile } from './export/zip-write'
import { Icon } from './icons'
import Modal from './Modal'

/* ---------- 导入 Markdown / Obsidian ----------
 * 选文件（.md / .markdown / .zip，可多选）、选文件夹、或拖进来；落在空间顶层或当前页下面。
 * 单个 .md / .zip 直接上传；多个文件 / 文件夹先在浏览器里打成 zip（export/zip-write.ts，带相对路径），
 * 服务端只认一个包（server routes/import.ts）：目录变页面树、[[双链]] / 图片 / 附件一起进来。
 *
 * 入口暂时隐藏：侧栏「导入」「从模板新建」与顶栏 ⋮「设为模板」都已撤掉，
 * 本组件、服务端接口（routes/import.ts）与 api 函数保留，重新上线时只需把入口接回 Sidebar / TopBar。 */

const MAX_TOTAL = 60 * 1024 * 1024

type Picked = { files: File[]; label: string }

/** 文件在包里的路径：选文件夹 / 拖文件夹时带相对路径，单选文件只有名字 */
function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return rel || file.name
}

const hidden = (path: string): boolean => path.split('/').some((part) => part.startsWith('.'))

/** 拖进来的条目（可能含文件夹）展开成带路径的文件 */
async function filesFromDrop(items: DataTransferItemList): Promise<File[]> {
  const out: File[] = []
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push(new File([file], file.name, { type: file.type, lastModified: file.lastModified }))
      Object.defineProperty(out[out.length - 1], 'webkitRelativePath', { value: prefix + file.name })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`)
    }
  }
  for (const item of [...items]) {
    const entry = item.webkitGetAsEntry?.()
    if (entry) await walk(entry, '')
  }
  return out
}

export default function ImportDialog({
  spaceId,
  currentPage,
  onClose,
  onDone,
}: {
  spaceId: string
  /** 当前打开的页（可选「放在这一页下面」）；null = 没开页 */
  currentPage: Page | null
  onClose: () => void
  /** 导入成功：通知刷新页面树并跳到第一个新页 */
  onDone: (firstPageId: string | null) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [underCurrent, setUnderCurrent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const pick = (files: File[], label: string): void => {
    const visible = files.filter((f) => !hidden(relPath(f)))
    setError(null)
    setPicked(visible.length ? { files: visible, label } : null)
    if (!visible.length) setError('没有可导入的文件')
  }

  const mdCount = picked?.files.filter((f) => /\.(md|markdown)$/i.test(f.name)).length ?? 0
  const zipCount = picked?.files.filter((f) => /\.zip$/i.test(f.name)).length ?? 0
  const total = picked?.files.reduce((n, f) => n + f.size, 0) ?? 0

  async function run(): Promise<void> {
    if (!picked || busy) return
    setError(null)
    try {
      let blob: Blob
      let name: string
      const single = picked.files.length === 1 ? picked.files[0]! : null
      if (single && /\.(md|markdown|zip)$/i.test(single.name)) {
        blob = single
        name = single.name
      } else {
        if (zipCount > 0) throw new Error('.zip 请单独导入（不要和别的文件混在一起）')
        if (total > MAX_TOTAL) throw new Error('文件太多太大（上限 60MB），请分几次导入')
        setBusy('正在打包…')
        const entries: ZipFile[] = []
        for (const file of picked.files) {
          const md = /\.(md|markdown)$/i.test(file.name)
          entries.push({ path: relPath(file), data: md ? await file.text() : new Uint8Array(await file.arrayBuffer()), store: !md })
        }
        blob = await buildZip(entries)
        name = 'import.zip'
      }
      if (blob.size > MAX_TOTAL) throw new Error('文件太大（上限 60MB），请分几次导入')
      setBusy('正在导入…')
      const result = await api.importMarkdown(spaceId, blob, name, underCurrent && currentPage ? currentPage.id : null)
      onDone(result.roots[0] ?? null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    void filesFromDrop(e.dataTransfer.items).then((files) => pick(files, files.length === 1 ? files[0]!.name : `${files.length} 个文件`))
  }

  return (
    <Modal onClose={onClose} className="create-modal" label="导入">
      <header className="create-head">
        <span className="create-head-ic">
          <Icon name="file" size={18} />
        </span>
        <div className="create-head-text">
          <h2 className="modal-title">导入 Markdown</h2>
          <p className="create-sub">.md 文件、整个文件夹（含 Obsidian 库）或 .zip</p>
        </div>
        <button className="modal-close" onClick={onClose} title="关闭">
          <Icon name="x" size={16} />
        </button>
      </header>

      <div
        className={'import-drop' + (dragging ? ' is-over' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {picked ? (
          <div className="import-picked">
            <b>{picked.label}</b>
            <span>
              {zipCount ? `${zipCount} 个 zip` : `${mdCount} 个 Markdown`}
              {picked.files.length - mdCount - zipCount > 0 && `，${picked.files.length - mdCount - zipCount} 个其它文件（被引用的图片 / 附件会一起导入）`}
            </span>
          </div>
        ) : (
          <span className="import-hint">把文件或文件夹拖到这里</span>
        )}
        <div className="import-actions">
          <button className="admin-btn" onClick={() => fileInput.current?.click()}>
            选择文件
          </button>
          <button className="admin-btn" onClick={() => dirInput.current?.click()}>
            选择文件夹
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".md,.markdown,.zip,text/markdown,application/zip"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            pick(files, files.length === 1 ? files[0]!.name : `${files.length} 个文件`)
            e.target.value = ''
          }}
        />
        <input
          ref={dirInput}
          type="file"
          hidden
          {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            const root = files[0] ? relPath(files[0]).split('/')[0] : ''
            pick(files, root ? `文件夹「${root}」` : '文件夹')
            e.target.value = ''
          }}
        />
      </div>

      <ul className="import-notes">
        <li>目录变成页面树，与目录同名的 .md / index.md 是目录页的正文</li>
        <li>[[双链]]、![[图片]]、相对路径的图片与附件都会接好；front matter 的 title 用作标题</li>
        <li>提示框、高亮、公式、表格、待办照原样识别</li>
      </ul>

      {currentPage && (
        <label className="create-where">
          <input type="checkbox" checked={underCurrent} onChange={(e) => setUnderCurrent(e.target.checked)} />
          放在「{currentPage.title || '无标题'}」下面（不勾 = 空间顶层）
        </label>
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="create-foot">
        <button className="admin-btn" onClick={onClose}>
          取消
        </button>
        <button className="admin-btn primary" disabled={!picked || busy !== null} onClick={() => void run()}>
          {busy ?? '导入'}
        </button>
      </div>
    </Modal>
  )
}
