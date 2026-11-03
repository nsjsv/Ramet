// ---------- 文件与媒体编辑弹层：列表（拖动调顺序、移除）+ 上传（按钮多选 / 把文件拖进弹层） ----------
// 上传复用正文的 uploadFile（10MB 上限、进度）；几个文件同时传，但按选择的顺序接到列表后面：先传完的要等排在它前面的
// （传完或失败）才一起提交，否则小文件先到、顺序就乱了。提交接在「最新的列表」后面：列表记在 ref 里，就地更新，不等重画。
// 弹层关了还没传完的照样传完、照样写进这一格（用户已经选了这个文件）。
import { useRef, useState } from 'react'
import { fileList, FILE_NAME_MAX, FILES_MAX, type FileRef, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { formatSize } from '../../editor/attachment'
import { uploadFile, type FileMeta } from '../../editor/media'
import { Icon } from '../../icons'
import { moveTo } from '../prop-meta'
import { useReorder } from '../reorder'
import { downloadUrl, FileItem, isImage } from './file-item'

const C = COPY.collection.cell.files

type Upload = { key: number; name: string; ratio: number }

/** 上传结果 → 格子里存的一项（文件名去掉控制字符、截到上限，过得了 validateValue） */
function refOf(meta: FileMeta): FileRef {
  const name = [...meta.name.replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, FILE_NAME_MAX).join('')
  return { id: meta.id, name: name || C.unnamed, mime: meta.mime, size: meta.size }
}

export function FilesEditor({ value, onCommit }: { value: PropValue | undefined; onCommit: (value: PropValue | null) => void }) {
  const files = fileList(value) ?? []
  const latest = useRef(files)
  latest.current = files
  const inflight = useRef(0)
  const seq = useRef(0)
  /** 按选择顺序排队的上传：done = 传完的那一项，null = 失败（跳过），undefined = 还在传 */
  const queue = useRef<{ key: number; done?: FileRef | null }[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [over, setOver] = useState(false)

  const commit = (next: FileRef[]): void => {
    latest.current = next
    onCommit(next.length ? next : null)
  }
  const drag = useReorder(
    files.map((f) => f.id),
    (id, index) => {
      const order = moveTo(latest.current.map((f) => f.id), id, index)
      const byId = new Map(latest.current.map((f) => [f.id, f]))
      commit(order.flatMap((x) => byId.get(x) ?? []))
    },
  )

  /** 队首起连续传完的一段按顺序提交 */
  const flush = (): void => {
    const ready: FileRef[] = []
    while (queue.current[0] && queue.current[0].done !== undefined) {
      const slot = queue.current.shift()
      if (slot?.done) ready.push(slot.done)
    }
    if (ready.length) commit([...latest.current, ...ready])
  }
  const settle = (key: number, done: FileRef | null): void => {
    const slot = queue.current.find((x) => x.key === key)
    if (slot) slot.done = done
    flush()
  }

  const add = (list: readonly File[]): void => {
    const room = Math.max(0, FILES_MAX - latest.current.length - inflight.current)
    setErrors(list.length > room ? [C.tooMany(FILES_MAX)] : [])
    for (const file of list.slice(0, room)) {
      const key = ++seq.current
      inflight.current++
      queue.current.push({ key })
      setUploads((u) => [...u, { key, name: file.name, ratio: 0 }])
      uploadFile(file, (ratio) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ratio } : x))))
        .then(
          (meta) => settle(key, refOf(meta)),
          (err: unknown) => {
            setErrors((e) => [...e, C.failed(file.name, err instanceof Error ? err.message : String(err))])
            settle(key, null)
          },
        )
        .finally(() => {
          inflight.current--
          setUploads((u) => u.filter((x) => x.key !== key))
        })
    }
  }

  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  return (
    <div
      className={'cl-files-editor' + (over ? ' is-over' : '')}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(false)
        add([...e.dataTransfer.files])
      }}
    >
      {files.length > 0 && (
        <div className="cl-files-list">
          {files.map((file) => (
            <div key={file.id} className="cl-files-row" {...drag(file.id)}>
              <span className="cl-grip" aria-hidden="true">
                <Icon name="handle" size={10} />
              </span>
              {isImage(file) ? <FileItem file={file} interactive={false} /> : <Icon name="paperclip" size={14} className="cl-files-icon" />}
              <a className="cl-files-name" href={downloadUrl(file)} download={file.name} title={file.name} draggable={false}>
                {file.name}
              </a>
              <span className="cl-files-size">{formatSize(file.size)}</span>
              <button type="button" className="icon-btn" title={C.remove} aria-label={C.remove} onClick={() => commit(latest.current.filter((f) => f.id !== file.id))}>
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {uploads.map((u) => (
        <div key={u.key} className="cl-files-up">
          <span className="cl-files-name">{u.name}</span>
          <span className="cl-files-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${u.ratio})` }} />
          </span>
        </div>
      ))}
      {errors.map((text, i) => (
        <div key={i} className="cl-files-error" role="alert">
          {text}
        </div>
      ))}
      <div className="cl-files-foot">
        <button type="button" className="cl-bar-btn" onClick={() => picker.current?.click()}>
          <Icon name="plus" size={14} />
          {C.upload}
        </button>
        <span className="cl-files-hint">{C.hint}</span>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
    </div>
  )
}
