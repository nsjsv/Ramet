/* ---------- Skill 库（/skills）----------
 * 当前空间里的 skill 列表 + 新建 + 导入（zip / 文件夹 / GitHub）。skill 本身就是页面：点一行进 /page/:id，
 * 正文在编辑器里写，名称 / 描述 / 附件在页面顶部的 SkillHead（editor/skill-head.tsx）。
 * 权限同页面：只读成员能看列表，新建 / 导入 / 删除按钮不出现。 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Page, type Space } from './api'
import { useCachedLoad } from './cached-load'
import { COPY } from './copy'
import { Icon } from './icons'
import { fmtSize, invalidateSkills, skillApi, type ImportResult, type SkillSummary } from './skill-api'

const C = COPY.skills
/** 导入请求体上限（与服务端 / nginx 一致）；文件夹里的 .git、node_modules 不上传 */
const IMPORT_MAX = 10 * 1024 * 1024
const SKIP_DIR = /(^|\/)(\.git|node_modules)(\/|$)/

const sourceText = (s: SkillSummary['source']): string =>
  s === null ? C.manual : s.type === 'github' ? C.fromGithub : s.type === 'folder' ? C.fromFolder : C.fromZip

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export default function SkillLibrary({ space, pages, onChanged }: { space: Space | null; pages: Page[] | null; onChanged: () => void }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'create' | 'import' | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [github, setGithub] = useState('')
  const zipRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const canWrite = space !== null && space.my_role !== 'viewer'
  const spaceId = space?.id ?? null

  // 上次的列表先画（cached-load.ts）；换空间重拉，页面列表变了（别人导入 / 回收站恢复 / 本机操作的广播）也跟着刷新，反正只是个小 JSON
  const loaded = useCachedLoad<SkillSummary[]>(spaceId ? `skills:${spaceId}` : null, () => skillApi.list(spaceId!), [pages])
  const { data: list, reload } = loaded
  useEffect(() => setError(loaded.error ? message(loaded.error, C.loadFailed) : null), [loaded.error])
  useEffect(() => {
    setResults(null)
    setPanel(null)
  }, [spaceId])

  const afterWrite = (): void => {
    if (spaceId) invalidateSkills(spaceId)
    onChanged()
    void reload()
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    if (!spaceId || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await skillApi.create(spaceId, name.trim(), description.trim())
      invalidateSkills(spaceId)
      onChanged()
      navigate(`/page/${created.pageId}`) // 直接进去写正文
    } catch (err) {
      setError(message(err, C.createFailed))
    } finally {
      setBusy(false)
    }
  }

  async function runImport(task: () => Promise<{ results: ImportResult[] }>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setResults(null)
    try {
      setResults((await task()).results)
      afterWrite()
    } catch (err) {
      setError(message(err, C.importFailed))
    } finally {
      setBusy(false)
    }
  }

  function onPickFolder(files: FileList | null) {
    if (!spaceId || !files || files.length === 0) return
    const picked = [...files].filter((f) => !SKIP_DIR.test(f.webkitRelativePath || f.name))
    if (picked.reduce((n, f) => n + f.size, 0) > IMPORT_MAX) {
      setError(`${C.importFailed}：文件夹超过 ${fmtSize(IMPORT_MAX)}`)
      return
    }
    void runImport(() => skillApi.importFolder(spaceId, picked))
  }

  async function remove(skill: SkillSummary) {
    if (!window.confirm(C.confirmRemove(skill.name))) return
    try {
      await api.trashPage(skill.id)
      afterWrite()
    } catch (err) {
      setError(message(err, C.removeFailed))
    }
  }

  return (
    <div className="skill-page" data-flip>
      <div className="skill-title-row">
        <h1 className="skill-title">{C.title}</h1>
        {canWrite && (
          <div className="skill-actions">
            <button className={'skill-btn' + (panel === 'create' ? ' is-on' : '')} onClick={() => setPanel(panel === 'create' ? null : 'create')}>
              <Icon name="plus" size={14} /> {C.create}
            </button>
            <button className={'skill-btn' + (panel === 'import' ? ' is-on' : '')} onClick={() => setPanel(panel === 'import' ? null : 'import')}>
              {C.import}
            </button>
          </div>
        )}
      </div>
      <p className="skill-sub">{space ? C.sub(space.name) : COPY.loading}</p>
      {!canWrite && space && <p className="skill-sub">{C.noPermission}</p>}

      {error && (
        <div className="skill-error" role="alert">
          <span>{error}</span>
          <button className="skill-error-close" title={COPY.failed} onClick={() => setError(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {panel === 'create' && canWrite && (
        <form className="skill-panel" onSubmit={(e) => void submitCreate(e)}>
          <label className="skill-field">
            <span>{C.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={C.namePlaceholder} spellCheck={false} autoFocus />
          </label>
          <label className="skill-field">
            <span>{C.description}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={C.descriptionPlaceholder} rows={2} />
          </label>
          <div className="skill-panel-foot">
            <button className="skill-btn is-primary" type="submit" disabled={busy || !name.trim() || !description.trim()}>
              {busy ? C.creating : C.createSubmit}
            </button>
          </div>
        </form>
      )}

      {panel === 'import' && canWrite && (
        <div className="skill-panel">
          <div className="skill-import-row">
            <button className="skill-btn" disabled={busy} onClick={() => zipRef.current?.click()}>
              {C.importZip}
            </button>
            <button className="skill-btn" disabled={busy} onClick={() => folderRef.current?.click()}>
              {C.importFolder}
            </button>
            <input
              ref={zipRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file && spaceId) void runImport(() => skillApi.importZip(spaceId, file))
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              hidden
              {...{ webkitdirectory: '' }}
              onChange={(e) => {
                onPickFolder(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
          <form
            className="skill-import-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (spaceId && github.trim()) void runImport(() => skillApi.importGithub(spaceId, github.trim()))
            }}
          >
            <input className="skill-grow" value={github} onChange={(e) => setGithub(e.target.value)} placeholder={C.githubPlaceholder} spellCheck={false} />
            <button className="skill-btn" type="submit" disabled={busy || !github.trim()}>
              {C.githubSubmit}
            </button>
          </form>
          <p className="skill-hint">{busy ? C.importing : C.importHint}</p>
          {results && (
            <ul className="skill-results">
              {results.map((r, i) => (
                <li key={i} className={r.status === 'error' ? 'is-error' : 'is-ok'}>
                  <b>{r.name ?? r.root}</b>
                  <span>{r.status === 'created' ? C.created : r.status === 'updated' ? C.updated : `${C.failedItem}：${r.error ?? ''}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {list !== null && list.length === 0 && (
        <div className="skill-empty">
          <b>{C.empty}</b>
          <span>{C.emptyHint}</span>
        </div>
      )}
      <ul className="skill-list">
        {list?.map((skill) => (
          <li key={skill.id} className="skill-row">
            <button className="skill-row-main" onClick={() => navigate(`/page/${skill.id}`)} title={C.open}>
              <span className="skill-row-name">{skill.name}</span>
              <span className="skill-row-desc">{skill.description}</span>
              <span className="skill-row-meta">
                {C.files(skill.files)}
                {skill.files > 0 ? ` · ${fmtSize(skill.bytes)}` : ''} · {sourceText(skill.source)} · {C.updatedAt(new Date(skill.updatedAt).toLocaleDateString())}
              </span>
            </button>
            {canWrite && (
              <button className="skill-row-del" title={C.remove} aria-label={C.remove} onClick={() => void remove(skill)}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
