/* ---------- skill 页顶部的头 ----------
 * skill 的 name / description / 附件不在正文里（正文就是 SKILL.md 的 markdown 部分，在下面的编辑器里写），
 * 在这里改：失焦保存，服务端按 Agent Skills 规则校验（名字格式 / 同空间唯一 / 描述长度），错误原样显示。
 * 权限同页面：只读成员只看。附件放 scripts / references / assets（或根目录），agent 加载 skill 时同步到它所在机器。 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { fmtSize, invalidateSkills, skillApi, type SkillDetail } from '../skill-api'

const C = COPY.skillHead
const DIRS = ['scripts', 'references', 'assets', ''] as const

export default function SkillHead({ pageId, readOnly, pages }: { pageId: string; readOnly: boolean; pages: Page[] | null }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dir, setDir] = useState<(typeof DIRS)[number]>('scripts')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setDetail(await skillApi.get(pageId))
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.skills.loadFailed)
    }
  }, [pageId])

  // 换页重拉；页面列表变了（重新导入 / 别人改了）也跟着刷新，请求只是一个小 JSON
  useEffect(() => {
    setDetail(null)
  }, [pageId])
  useEffect(() => {
    void reload()
  }, [reload, pages])
  // 服务端值变了才覆盖输入框：自己正在打的字不被无关的刷新冲掉
  useEffect(() => {
    if (detail) setName(detail.name)
  }, [detail?.name])
  useEffect(() => {
    if (detail) setDescription(detail.description)
  }, [detail?.description])

  async function save(patch: { name?: string; description?: string }) {
    if (!detail) return
    setError(null)
    try {
      await skillApi.update(pageId, patch)
      invalidateSkills(detail.spaceId)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : C.saveFailed)
      // 校验没过：输入框回到服务端的值，别留一个不存在的状态
      setName(detail.name)
      setDescription(detail.description)
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      for (const f of files) await skillApi.putFile(pageId, dir ? `${dir}/${f.name}` : f.name, f)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : C.uploadFailed)
    } finally {
      setBusy(false)
    }
  }

  async function removeFile(path: string) {
    if (!window.confirm(C.confirmDeleteFile(path))) return
    try {
      await skillApi.deleteFile(pageId, path)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : C.uploadFailed)
    }
  }

  const source = detail?.source
  return (
    <section className="skill-head">
      <div className="skill-head-top">
        <button type="button" onClick={() => navigate('/skills')}>
          <Icon name="skill" size={13} /> {C.library}
        </button>
        {source && (
          <span title={source.url ?? ''}>
            {C.source}：{source.type === 'github' ? COPY.skills.fromGithub : source.type === 'folder' ? COPY.skills.fromFolder : COPY.skills.fromZip}
            {source.url ? ` · ${source.url}` : ''}
          </span>
        )}
      </div>
      <label className="skill-field">
        <span>{C.name}</span>
        <input
          className="skill-name-input"
          value={name}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => detail && name.trim() !== detail.name && void save({ name: name.trim() })}
        />
      </label>
      <label className="skill-field">
        <span>{C.descriptionHint}</span>
        <textarea
          value={description}
          readOnly={readOnly}
          rows={2}
          aria-label={C.description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => detail && description.trim() !== detail.description && void save({ description: description.trim() })}
        />
      </label>
      {error && <div className="skill-head-error" role="alert">{error}</div>}
      <div className="skill-files-head">
        <span>
          {C.files}
          {detail ? ` (${detail.files.length})` : ''}
        </span>
        {!readOnly && (
          <>
            <select value={dir} onChange={(e) => setDir(e.target.value as (typeof DIRS)[number])} aria-label={C.addFile}>
              {DIRS.map((d) => (
                <option key={d} value={d}>
                  {d ? `${d}/` : C.dirRoot}
                </option>
              ))}
            </select>
            <label className="skill-file-add">
              <Icon name="plus" size={12} /> {C.addFile}
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void upload(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </>
        )}
      </div>
      {detail && detail.files.length === 0 && <div className="skill-hint">{C.noFiles}</div>}
      {detail && detail.files.length > 0 && (
        <ul className="skill-files">
          {detail.files.map((f) => (
            <li key={f.path} className="skill-file">
              <span className="skill-file-path">{f.path}</span>
              <span className="skill-file-size">{fmtSize(f.size)}</span>
              <a href={skillApi.fileUrl(pageId, f.path)} download>
                {C.download}
              </a>
              {!readOnly && (
                <button type="button" onClick={() => void removeFile(f.path)}>
                  {C.deleteFile}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
