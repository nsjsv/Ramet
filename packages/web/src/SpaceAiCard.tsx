import { useEffect, useState } from 'react'
import { api, ApiError, type Space, type SpaceAiConfig } from './api'
import { normalizeSpaceAiName, SPACE_AI_DEFAULT_NAME, SPACE_AI_NAME_MAX } from './assistant/space-ai'
import { COPY } from './copy'
import { quickApi, type AiConnection } from './quick-api'
import { openSettings } from './settings-bus'
import { Card, Row } from './ui/form-kit'
import { Select } from './ui/Select'
import { SpaceAiUsageCard } from './usage/UsageView'

const C = COPY.spaceAi

/** 空间设置里的「空间 AI」卡：只在团队空间出现（个人空间没有空间 AI，就用 Genet）。
 * - owner：从自己在「设置 → Genet」里添加的模型连接里选一个启用（或不启用）、改名字。空间 AI 花的是 owner 自己的额度，
 *   别人的连接选不了（服务端也拦）。保存后用返回值刷新；服务端随即广播，在线成员的 @ 菜单与回复抬头跟着变。
 * - 成员 / 只读成员：只看开没开、叫什么（空间列表里就有，不另发请求）。 */
export default function SpaceAiCard({ space, onChanged }: { space: Space; onChanged: () => void }) {
  if (space.is_personal) return null
  if (space.my_role !== 'owner') return <MemberCard space={space} />
  // 用量只给 owner：成员叫空间 AI 花的是他的模型连接
  return (
    <>
      <OwnerCard space={space} onChanged={onChanged} />
      <SpaceAiUsageCard spaceId={space.id} />
    </>
  )
}

function MemberCard({ space }: { space: Space }) {
  const ai = space.ai
  return (
    <Card title={C.card}>
      <Row label={C.status} desc={C.memberHint}>
        <span className={'role-badge' + (ai?.enabled ? ' is-owner' : '')}>{ai?.enabled ? C.enabled(ai.name) : C.disabled}</span>
      </Row>
    </Card>
  )
}

interface Draft {
  /** '' = 不启用 */
  connectionId: string
  name: string
}

const draftOf = (cfg: SpaceAiConfig): Draft => ({ connectionId: cfg.connectionId ?? '', name: cfg.name })

function OwnerCard({ space, onChanged }: { space: Space; onChanged: () => void }) {
  const [config, setConfig] = useState<SpaceAiConfig | null>(null)
  const [connections, setConnections] = useState<AiConnection[] | null>(null)
  const [draft, setDraft] = useState<Draft>({ connectionId: '', name: SPACE_AI_DEFAULT_NAME })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // 空间列表里的开关 / 名字变了（别的设备改的、删了连接被停用）就重读，界面不停在旧值上
  const enabled = space.ai?.enabled
  const listedName = space.ai?.name
  useEffect(() => {
    let alive = true
    Promise.all([api.getSpaceAi(space.id), quickApi.settings()])
      .then(([cfg, settings]) => {
        if (!alive) return
        setConfig(cfg)
        setDraft(draftOf(cfg))
        setConnections(settings.connections)
      })
      .catch((err: unknown) => {
        console.error(err)
        if (alive) setError(C.loadFailed)
      })
    return () => {
      alive = false
    }
  }, [space.id, enabled, listedName])

  if (!config || !connections) {
    return (
      <Card title={C.card}>
        <p className="set-empty">{error ?? C.loading}</p>
      </Card>
    )
  }

  const dirty = draft.connectionId !== (config.connectionId ?? '') || draft.name !== config.name

  async function save() {
    if (saving || !dirty) return
    const name = normalizeSpaceAiName(draft.name)
    if (!name) return setError(C.nameInvalid(SPACE_AI_NAME_MAX))
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.setSpaceAi(space.id, { connectionId: draft.connectionId || null, name })
      setConfig(next)
      setDraft(draftOf(next))
      setSaved(true)
      onChanged()
    } catch (err) {
      console.error(err)
      // 403 / 400 的 message 是服务端给的人话（只有所有者能设置、只能选自己的连接、名字长度）
      setError(err instanceof ApiError && err.status < 500 ? err.message : C.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const options = [{ value: '', label: C.off }, ...connections.map((c) => ({ value: c.id, label: c.name, tip: c.model }))]
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setSaved(false)
    setError(null)
  }

  // 卡片里的行之间有分隔线（直接子元素），所以不包 <form>：名字框回车与「保存」走同一个 save
  return (
    <Card title={C.card}>
      <Row label={C.connection} desc={connections.length === 0 ? C.noConnections : C.connectionDesc}>
        {connections.length === 0 ? (
          <button className="admin-btn" type="button" onClick={() => openSettings('quick')}>
            {C.addConnection}
          </button>
        ) : (
          <Select className="admin-field" label={C.connection} value={draft.connectionId} options={options} onChange={(v) => edit({ connectionId: v })} />
        )}
      </Row>
      <Row label={C.name} desc={C.nameDesc}>
        <input
          className="admin-field"
          value={draft.name}
          autoComplete="off"
          aria-label={C.name}
          onChange={(e) => edit({ name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
          }}
        />
      </Row>
      <div className="set-form-foot set-pad">
        {error && <span className="set-form-msg is-error">{error}</span>}
        {saved && <span className="set-form-msg is-ok">{C.saved}</span>}
        <button className="admin-btn primary" type="button" disabled={saving || !dirty} onClick={() => void save()}>
          {C.save}
        </button>
      </div>
    </Card>
  )
}
