/* ---------- 顶栏「分享」弹层 ----------
 * 三段（同 Notion 的分享菜单）：邀请（输入用户名 + 可编辑 / 只读；成员在输入框的候选里，空间外的人成为访客）、
 * 有权限的人（私人页的主人或「空间成员」，再列这页和祖先上给的分享：直接给的能改档位 / 移除，继承来的只说从哪一页来，访客带标）、
 * 发布到网上（原来的公开开关）。
 * 空间成员里能编辑这页的人才有前两段的写入口（canShare，访客没有）；发布段只给 canPublish（公共页空间 owner、私人页主人）。
 * 判定全在服务端（routes/page-shares.ts：邀请访客的开关也在那里），这里每次操作后用接口返回的现状重画。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { selfId, spaceMembers, subscribePeople, type Person } from '../people'
import { Checkbox } from '../ui/Checkbox'
import { Select } from '../ui/Select'
import { shareApi, type PageShares, type ShareLevel } from './share-api'

const C = COPY.sharing
const LEVELS = [
  { value: 'edit' as const, label: C.level.edit },
  { value: 'view' as const, label: C.level.view },
]

type Props = {
  pageId: string
  spaceId: string | null
  /** 空间成员且能编辑这页：能邀请、改档位、移除 */
  canShare: boolean
  canPublish: boolean
  published: boolean
  includeRuns: boolean
  onChanged: () => void
}

export default function SharePanel(p: Props) {
  return (
    <div className="share-pop">
      <AccessSection pageId={p.pageId} spaceId={p.spaceId} canShare={p.canShare} />
      {p.canPublish && (
        <section className="share-section">
          <h4 className="share-title">{C.web}</h4>
          <PublishSection pageId={p.pageId} published={p.published} includeRuns={p.includeRuns} onChanged={p.onChanged} />
        </section>
      )}
    </div>
  )
}

function AccessSection({ pageId, spaceId, canShare }: { pageId: string; spaceId: string | null; canShare: boolean }) {
  const [data, setData] = useState<PageShares | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [level, setLevel] = useState<ShareLevel>('edit')
  const me = useSyncExternalStore(subscribePeople, selfId)
  // 空间成员（people.ts 按空间取一次、到了通知）；每次读都是新数组，不能直接当 useSyncExternalStore 的快照
  const [members, setMembers] = useState<Person[] | null>(null)
  useEffect(() => {
    if (!spaceId) return
    const read = (): void => setMembers(spaceMembers(spaceId))
    read()
    return subscribePeople(read)
  }, [spaceId])

  useEffect(() => {
    let live = true
    setData(null)
    shareApi.list(pageId).then(
      (r) => live && setData(r),
      (err: unknown) => live && setError(err instanceof Error ? err.message : C.failed),
    )
    return () => {
      live = false
    }
  }, [pageId])

  const run = useCallback(async (op: () => Promise<PageShares>) => {
    setBusy(true)
    setError(null)
    try {
      setData(await op())
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : C.failed)
    } finally {
      setBusy(false)
    }
  }, [])

  const direct = new Set((data?.shares ?? []).filter((s) => s.from === null).map((s) => s.userId))
  // 输入框的候选：空间里我认识的人，去掉自己、私人页的主人、已经直接给过的（别的用户名照样能输）
  const candidates = (members ?? []).filter((m) => m.id !== me && m.id !== data?.owner?.id && !direct.has(m.id))
  const listId = `share-people-${pageId}`
  const invite = (): void => {
    const who = name.trim()
    if (!who) return
    void run(() => shareApi.invite(pageId, who, level)).then(() => setName(''))
  }

  return (
    <>
      {canShare && (
        <section className="share-section">
          <h4 className="share-title">{C.invite}</h4>
          <form
            className="share-invite"
            onSubmit={(e) => {
              e.preventDefault()
              invite()
            }}
          >
            <input
              className="share-invite-who"
              aria-label={C.inviteName}
              placeholder={C.invitePlaceholder}
              list={listId}
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id={listId}>
              {candidates.map((m) => (
                <option key={m.id} value={m.username} />
              ))}
            </datalist>
            <Select size="sm" label={C.levelLabel} value={level} options={LEVELS} onChange={setLevel} />
            <button type="submit" className="admin-btn primary" disabled={busy || !name.trim()}>
              {C.inviteBtn}
            </button>
          </form>
          <p className="share-hint">{C.inviteHint}</p>
        </section>
      )}
      <section className="share-section">
        <h4 className="share-title">{C.people}</h4>
        {data === null ? (
          !error && <p className="share-hint">{C.loading}</p>
        ) : (
          <ul className="share-people">
            <li className="share-person">
              <span className="share-person-name">{data.owner ? C.owner(data.owner.username) : C.everyone}</span>
            </li>
            {data.shares.map((s) => (
              <li key={`${s.userId}:${s.from?.id ?? ''}`} className="share-person">
                <span className="share-person-name">
                  <span className="share-person-who">
                    {s.username}
                    {s.guest && <span className="share-person-tag">{C.guest}</span>}
                  </span>
                  {s.from && <span className="share-person-from">{C.inherited(s.from.title)}</span>}
                </span>
                {s.from === null && canShare ? (
                  <Select
                    size="sm"
                    label={C.levelLabel}
                    value={s.level}
                    options={LEVELS}
                    disabled={busy}
                    onChange={(v) => v !== s.level && void run(() => shareApi.set(pageId, s.userId, v))}
                  />
                ) : (
                  <span className="share-person-level">{C.level[s.level]}</span>
                )}
                {s.from === null && (canShare || s.userId === me) && (
                  <button type="button" className="admin-btn" disabled={busy} onClick={() => void run(() => shareApi.remove(pageId, s.userId))}>
                    {s.userId === me ? C.leave : C.remove}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="share-error">{error}</p>}
    </>
  )
}

/** 发布到网上：读当前页 published 决定形态；操作后 onChanged() 刷 pages，状态随之更新。
 *  includeRuns（是否连 agent 过程页一起公开）是这个页面自己的属性，不是过程页上的开关：
 *  发布语义是「祖先公开即子树公开」，子页上的 published 表达不了「我不要公开」 */
function PublishSection({ pageId, published, includeRuns, onChanged }: { pageId: string; published: boolean; includeRuns: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = `${location.origin}/p/${pageId}`

  /** 发布态与「连过程一起公开」同一条写路径；未发布时也允许先设好过程开关 */
  async function save(nextPublished: boolean, nextRuns?: boolean) {
    setBusy(true)
    setError(null)
    try {
      await api.setPublished(pageId, nextPublished, nextRuns)
      onChanged() // pages 刷新 → 页面重渲染，本段按新 published 换形态
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : COPY.retry)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (await copyText(link)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
    // 失败：不阻断，链接框可手动选中复制
  }

  const runsToggle = (
    <Checkbox className="share-option" label={COPY.share.includeRuns} checked={includeRuns} disabled={busy} onChange={(on) => void save(published, on)} />
  )

  return (
    <>
      {published ? (
        <>
          <div className="share-link-row">
            <input className="share-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="admin-btn" onClick={() => void copy()}>
              {copied ? COPY.share.copied : COPY.share.copy}
            </button>
          </div>
          {runsToggle}
          <div className="share-actions">
            <span className="share-state is-on">{COPY.share.on}</span>
            <button className="admin-btn danger" disabled={busy} onClick={() => void save(false)}>
              {COPY.share.unpublish}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="share-hint">{COPY.share.hint}</p>
          {runsToggle}
          <div className="share-actions">
            <span className="share-state">{COPY.share.off}</span>
            <button className="admin-btn primary" disabled={busy} onClick={() => void save(true)}>
              {COPY.share.publish}
            </button>
          </div>
        </>
      )}
      {error && <p className="share-error">{error}</p>}
    </>
  )
}
