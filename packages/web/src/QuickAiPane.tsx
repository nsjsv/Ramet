import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type AgentInfo } from './api'
import { COPY } from './copy'
import { Card, ConfirmButton, Row, Segmented } from './form-kit'
import { Icon } from './icons'
import {
  ANTHROPIC_MODELS,
  quickApi,
  type AiConnection,
  type AiSettings,
  type Protocol,
} from './quick-api'

/* ---------- 设置 → 随手 AI ----------
 * 选中文字按 ⌘J 用的模型连接。站点不提供共用 key：每个人存自己的连接（key 加密落库、只回后四位），
 * 可以存多套、选一套当「当前」。协议两种：Anthropic（不填地址 = 官方）/ OpenAI 兼容（地址必填）。
 * 地址校验（只允许 https、不能指向本机 / 内网）在服务端，保存和「测试连接」都会跑，报错就地显示。
 * 通道「本地」= 经 connector 让自己（或别人授权给自己）的机器上的 agent 做一次改写：不需要 key，在这里选用哪个 agent
 * （候选来自 /api/agents，只含 connector 上、现在在线且自己能用的）。 */

const C = COPY.quickSettings

/** 表单里的草稿；编辑时 key 留空 = 不改 */
interface Form {
  id: string | null
  protocol: Protocol
  name: string
  baseUrl: string
  model: string
  apiKey: string
  keyLast4: string
}

const blank = (protocol: Protocol): Form => ({
  id: null,
  protocol,
  name: '',
  baseUrl: '',
  model: protocol === 'anthropic' ? ANTHROPIC_MODELS[0] : '',
  apiKey: '',
  keyLast4: '',
})

const fromConnection = (c: AiConnection): Form => ({
  id: c.id,
  protocol: c.protocol,
  name: c.name,
  baseUrl: c.baseUrl ?? '',
  model: c.model,
  apiKey: '',
  keyLast4: c.keyLast4,
})

const isKnownModel = (m: string): boolean => (ANTHROPIC_MODELS as readonly string[]).includes(m)

/** 列表行的第二行：协议 · 模型 · 地址主机 · key 后四位 */
function describe(c: AiConnection): string {
  let host = ''
  if (c.baseUrl) {
    try {
      host = new URL(c.baseUrl).host
    } catch {
      host = c.baseUrl
    }
  }
  const proto = c.protocol === 'anthropic' ? C.protoAnthropic : C.protoOpenai
  return [proto, C.models[c.model] ?? c.model, host, `••••${c.keyLast4}`].filter(Boolean).join(' · ')
}

export function QuickAiPane() {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  /** 本地通道的候选：connector 上我现在能用的 agent（id 以 c: 开头；本机 agent 不在其中） */
  const [agents, setAgents] = useState<AgentInfo[]>([])

  useEffect(() => {
    api.listAgents().then((list) => setAgents(list.filter((a) => a.id.startsWith('c:')))).catch(() => setAgents([]))
  }, [])

  const reload = useCallback(() => {
    quickApi
      .settings()
      .then((s) => {
        setSettings(s)
        setError(null)
      })
      .catch(() => setError(C.loadFailed))
  }, [])

  useEffect(reload, [reload])

  async function act(run: () => Promise<unknown>) {
    setError(null)
    try {
      await run()
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.failed)
    }
  }

  if (!settings) return error ? <div className="modal-error">{error}</div> : <div className="set-empty">{COPY.loading}</div>

  return (
    <>
      {error && <div className="modal-error">{error}</div>}
      <Card title={C.channelTitle}>
        <Row label={C.channelLabel} desc={C.channelDesc}>
          <Segmented
            label={C.channelLabel}
            value={settings.channel}
            options={[
              { value: 'site', label: C.channelSite },
              { value: 'local', label: C.channelLocal },
            ]}
            onChange={(channel) => void act(() => quickApi.setSettings({ channel }))}
          />
        </Row>
        {settings.channel === 'local' && (
          <Row label={C.localAgentLabel} desc={agents.length === 0 ? C.localAgentEmpty : C.localAgentDesc} htmlFor="quick-local-agent">
            <select
              id="quick-local-agent"
              className="admin-field"
              value={settings.localAgent ?? ''}
              onChange={(e) => void act(() => quickApi.setSettings({ localAgent: e.target.value || null }))}
            >
              <option value="">{C.localAgentNone}</option>
              {settings.localAgent && !agents.some((a) => a.id === settings.localAgent) && (
                <option value={settings.localAgent}>{C.localAgentGone(settings.localAgent.replace(/^c:[^:]+:/, ''))}</option>
              )}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Row>
        )}
      </Card>

      <Card title={C.connectionsTitle}>
        <div className="set-pad set-desc">{C.connectionsDesc}</div>
        {!settings.secretConfigured && <div className="set-pad quick-set-warn">{C.secretMissing}</div>}
        {settings.connections.length === 0 && <div className="set-empty">{C.empty}</div>}
        {settings.connections.map((c) => {
          const active = c.id === settings.activeConnectionId
          return (
            <div className="set-line quick-set-line" key={c.id}>
              <div className="set-line-main">
                <span className="set-line-name">
                  {c.name}
                  {active && <span className="role-badge is-owner quick-set-cur">{C.current}</span>}
                </span>
                <span className="set-line-sub">{describe(c)}</span>
              </div>
              {!active && (
                <button className="admin-btn" onClick={() => void act(() => quickApi.setSettings({ activeConnectionId: c.id }))}>
                  {C.useThis}
                </button>
              )}
              <button className="admin-btn" onClick={() => setForm(fromConnection(c))}>
                {C.edit}
              </button>
              <ConfirmButton confirmLabel={C.delConfirm} onConfirm={() => void act(() => quickApi.deleteConnection(c.id))}>
                {C.del}
              </ConfirmButton>
            </div>
          )
        })}
        {!form && (
          <div className="set-pad">
            <button className="admin-btn primary" disabled={!settings.secretConfigured} onClick={() => setForm(blank('anthropic'))}>
              <Icon name="plus" size={14} /> {C.add}
            </button>
          </div>
        )}
      </Card>

      {form && (
        <ConnectionForm
          form={form}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            reload()
          }}
        />
      )}
    </>
  )
}

function ConnectionForm({
  form,
  onChange,
  onCancel,
  onSaved,
}: {
  form: Form
  onChange: (f: Form) => void
  onCancel: () => void
  onSaved: () => void
}) {
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const editing = form.id !== null
  const official = form.protocol === 'anthropic' && !form.baseUrl.trim()
  const set = (patch: Partial<Form>) => {
    setTest(null)
    onChange({ ...form, ...patch })
  }

  /** 地址清空 / 填上时，模型框的形态跟着换（官方 = 三选一；其它 = 自由填） */
  function setBaseUrl(baseUrl: string) {
    const nowOfficial = form.protocol === 'anthropic' && !baseUrl.trim()
    set({ baseUrl, ...(nowOfficial && !isKnownModel(form.model) ? { model: ANTHROPIC_MODELS[0] } : {}) })
  }

  function body() {
    return {
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    }
  }

  async function runTest() {
    setBusy('test')
    setError(null)
    setTest(null)
    try {
      if (!editing && !form.apiKey.trim()) throw new Error('先填 API key')
      const res = await quickApi.testConnection(editing ? { id: form.id!, ...body() } : { protocol: form.protocol, ...body() })
      setTest(res.ok ? { ok: true, text: C.testOk(res.reply) } : { ok: false, text: res.message })
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : COPY.failed })
    } finally {
      setBusy(null)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy('save')
    setError(null)
    try {
      if (editing) await quickApi.updateConnection(form.id!, { name: form.name, ...body() })
      else await quickApi.createConnection({ protocol: form.protocol, name: form.name, ...body(), apiKey: form.apiKey.trim() })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.failed)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card title={editing ? C.formEdit : C.formNew}>
      <form className="quick-set-form" onSubmit={(e) => void submit(e)}>
        {!editing && (
          <Row label={C.protocol} desc={form.protocol === 'openai' ? C.protoOpenaiHint : C.protoAnthropicHint}>
            <Segmented
              label={C.protocol}
              value={form.protocol}
              options={[
                { value: 'anthropic', label: C.protoAnthropic },
                { value: 'openai', label: C.protoOpenai },
              ]}
              onChange={(protocol) => {
                setTest(null)
                onChange({ ...blank(protocol), name: form.name, apiKey: form.apiKey })
              }}
            />
          </Row>
        )}
        <label className="quick-set-field">
          <span>{C.name}</span>
          <input className="admin-field" value={form.name} maxLength={40} placeholder={C.namePlaceholder} onChange={(e) => set({ name: e.target.value })} required />
        </label>
        <label className="quick-set-field">
          <span>{form.protocol === 'openai' ? C.baseUrl : C.baseUrlOptional}</span>
          <input
            className="admin-field"
            value={form.baseUrl}
            maxLength={300}
            spellCheck={false}
            placeholder={form.protocol === 'openai' ? C.baseUrlOpenai : C.baseUrlAnthropic}
            onChange={(e) => setBaseUrl(e.target.value)}
            required={form.protocol === 'openai'}
          />
          <small>{C.baseUrlRule}</small>
        </label>
        <label className="quick-set-field">
          <span>{C.model}</span>
          {official ? (
            <select className="admin-field" value={form.model} onChange={(e) => set({ model: e.target.value })}>
              {ANTHROPIC_MODELS.map((m) => (
                <option key={m} value={m}>
                  {C.models[m] ?? m}
                </option>
              ))}
            </select>
          ) : (
            <input className="admin-field" value={form.model} maxLength={100} spellCheck={false} placeholder={C.modelPlaceholder} onChange={(e) => set({ model: e.target.value })} required />
          )}
          {official && <small>{C.modelHint}</small>}
        </label>
        <label className="quick-set-field">
          <span>{C.apiKey}</span>
          <input
            className="admin-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.apiKey}
            placeholder={editing ? C.apiKeyKeep(form.keyLast4) : C.apiKeyPlaceholder}
            onChange={(e) => set({ apiKey: e.target.value })}
            required={!editing}
          />
        </label>
        {error && <div className="admin-form-error">{error}</div>}
        {test && <div className={'quick-set-test' + (test.ok ? ' is-ok' : ' is-bad')}>{test.text}</div>}
        <div className="quick-set-acts">
          <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void runTest()}>
            {busy === 'test' ? C.testing : C.test}
          </button>
          <span className="quick-set-grow" />
          <button type="button" className="admin-btn" disabled={busy !== null} onClick={onCancel}>
            {C.cancel}
          </button>
          <button type="submit" className="admin-btn primary" disabled={busy !== null}>
            {busy === 'save' ? C.saving : C.save}
          </button>
        </div>
      </form>
    </Card>
  )
}
