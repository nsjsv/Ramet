import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type AgentInfo } from './api'
import { COPY } from './copy'
import { Card, ConfirmButton, Row, Segmented } from './ui/form-kit'
import { Icon } from './icons'
import { ModelSpecHint } from './ModelSpecHint'
import { Select } from './ui/Select'
import { quickApi, type AiConnection, type AiSettings, type ModelInfo, type Protocol } from './quick-api'

/* ---------- 设置 → Genet ----------
 * Genet 与 ⌘J 用的模型供应商。站点不提供共用 key：每个人存自己的供应商（key 加密落库、只回后四位），
 * 可以存多个、选一个当「当前」。类型两种：Anthropic（不填地址 = 官方）/ OpenAI 兼容（地址必填）。
 * 模型不给手填：填好地址和 key 后从服务商的模型列表里选（手填的名字常常拼错，错了要到调用时才发现）；
 * 编辑已有的供应商时自动拉一次。
 * 地址校验（只允许 https、不能指向本机 / 内网）在服务端，保存、拉模型列表和「测试连接」都会跑，报错就地显示。
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
  model: '',
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

/** 列表行的第二行：类型 · 模型 · 地址主机 · key 后四位 */
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
  return [proto, c.model, host, `••••${c.keyLast4}`].filter(Boolean).join(' · ')
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
            <Select
              id="quick-local-agent"
              className="admin-field"
              label={C.localAgentLabel}
              value={settings.localAgent ?? ''}
              options={[
                { value: '', label: C.localAgentNone },
                ...(settings.localAgent && !agents.some((a) => a.id === settings.localAgent)
                  ? [{ value: settings.localAgent, label: C.localAgentGone(settings.localAgent.replace(/^c:[^:]+:/, '')) }]
                  : []),
                ...agents.map((a) => ({ value: a.id, label: a.label, disabled: Boolean(a.unavailable), tip: a.unavailable })),
              ]}
              onChange={(v) => void act(() => quickApi.setSettings({ localAgent: v || null }))}
            />
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
          key={form.id ?? 'new'}
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
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  /** 拉到的模型列表；null = 还没拉（或地址 / key 改过，旧列表作废） */
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  /** 地址 / key 改过后，之前发出的拉取回来也不认 */
  const listSeq = useRef(0)
  const editing = form.id !== null
  const nameRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const fetchRef = useRef<HTMLButtonElement>(null)
  const set = (patch: Partial<Form>) => {
    setTest(null)
    onChange({ ...form, ...patch })
  }

  /** 地址 / key 一改，旧的模型列表就不算数了；新建时连选好的模型一起清掉（编辑时留着已保存的） */
  function setEndpoint(patch: Partial<Form>) {
    listSeq.current++
    setModels(null)
    setListError(null)
    set({ ...patch, ...(editing ? {} : { model: '' }) })
  }

  function endpoint() {
    return {
      baseUrl: form.baseUrl.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    }
  }

  function body() {
    return { ...endpoint(), model: form.model.trim() }
  }

  async function fetchModels() {
    if (!editing && !form.apiKey.trim()) {
      setListError(C.keyFirst)
      keyRef.current?.focus()
      return
    }
    if (form.protocol === 'openai' && !form.baseUrl.trim()) {
      setListError(C.required(C.baseUrl))
      urlRef.current?.focus()
      return
    }
    const seq = ++listSeq.current
    setBusy('models')
    setListError(null)
    try {
      const res = await quickApi.listModels(editing ? { id: form.id!, ...endpoint() } : { protocol: form.protocol, ...endpoint() })
      if (seq !== listSeq.current) return
      if (res.ok) setModels(res.models)
      else setListError(res.message)
    } catch (err) {
      if (seq === listSeq.current) setListError(err instanceof Error ? err.message : COPY.failed)
    } finally {
      setBusy(null)
    }
  }

  // 编辑已有的供应商：key 在服务端，打开就能拉
  useEffect(() => {
    if (editing) void fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runTest() {
    setError(null)
    if (!editing && !form.apiKey.trim()) return setTest({ ok: false, text: C.keyFirst })
    if (!form.model) return setTest({ ok: false, text: C.modelRequired })
    setBusy('test')
    setTest(null)
    try {
      const res = await quickApi.testConnection(editing ? { id: form.id!, ...body() } : { protocol: form.protocol, ...body() })
      setTest(res.ok ? { ok: true, text: C.testOk(res.reply) } : { ok: false, text: res.message })
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : COPY.failed })
    } finally {
      setBusy(null)
    }
  }

  /** 第一个没填的必填项（不用 required：系统的校验气泡跟不了主题，位置也不在表单的错误条上） */
  function firstMissing(): { message: string; focus: HTMLElement | null } | null {
    const checks: Array<[boolean, string, HTMLElement | null]> = [
      [!form.name.trim(), C.required(C.name), nameRef.current],
      [form.protocol === 'openai' && !form.baseUrl.trim(), C.required(C.baseUrl), urlRef.current],
      [!editing && !form.apiKey.trim(), C.required(C.apiKey), keyRef.current],
      [!form.model, C.modelRequired, fetchRef.current],
    ]
    const hit = checks.find(([missing]) => missing)
    return hit ? { message: hit[1], focus: hit[2] } : null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const missing = firstMissing()
    if (missing) {
      setError(missing.message)
      missing.focus?.focus()
      return
    }
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

  // 已选的模型不在拉到的列表里（服务商下架了 / 列表还没拉）也照样显示，免得编辑时被悄悄换掉
  const modelOptions = [
    ...(form.model && !models?.some((m) => m.id === form.model) ? [{ value: form.model, label: models ? C.modelGone(form.model) : form.model }] : []),
    ...(models ?? []).map((m) => ({ value: m.id, label: m.name, tip: m.name === m.id ? undefined : m.id })),
  ]

  return (
    <Card title={editing ? C.formEdit : C.formNew}>
      <form className="quick-set-form" noValidate onSubmit={(e) => void submit(e)}>
        {!editing && (
          <Row label={C.protocol} desc={form.protocol === 'openai' ? C.protoOpenaiHint : undefined}>
            <Segmented
              label={C.protocol}
              value={form.protocol}
              options={[
                { value: 'anthropic', label: C.protoAnthropic },
                { value: 'openai', label: C.protoOpenai },
              ]}
              onChange={(protocol) => {
                listSeq.current++
                setModels(null)
                setListError(null)
                setTest(null)
                onChange({ ...blank(protocol), name: form.name, apiKey: form.apiKey })
              }}
            />
          </Row>
        )}
        <label className="quick-set-field">
          <span>{C.name}</span>
          <input ref={nameRef} className="admin-field" value={form.name} maxLength={40} placeholder={C.namePlaceholder} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="quick-set-field">
          <span>{form.protocol === 'openai' ? C.baseUrl : C.baseUrlOptional}</span>
          <input
            ref={urlRef}
            className="admin-field"
            value={form.baseUrl}
            maxLength={300}
            spellCheck={false}
            placeholder={form.protocol === 'openai' ? C.baseUrlOpenai : C.baseUrlAnthropic}
            onChange={(e) => setEndpoint({ baseUrl: e.target.value })}
          />
          <small>{C.baseUrlRule}</small>
        </label>
        <label className="quick-set-field">
          <span>{C.apiKey}</span>
          <input
            ref={keyRef}
            className="admin-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.apiKey}
            placeholder={editing ? C.apiKeyKeep(form.keyLast4) : C.apiKeyPlaceholder}
            onChange={(e) => setEndpoint({ apiKey: e.target.value })}
          />
        </label>
        <div className="quick-set-field">
          <span>{C.model}</span>
          <div className="quick-set-model">
            <Select
              className="admin-field"
              label={C.model}
              value={form.model || null}
              placeholder={models ? C.modelPick : C.modelEmpty}
              disabled={modelOptions.length === 0}
              options={modelOptions}
              onChange={(model) => set({ model })}
            />
            <button ref={fetchRef} type="button" className="admin-btn" disabled={busy !== null} onClick={() => void fetchModels()}>
              {busy === 'models' ? C.fetchingModels : C.fetchModels}
            </button>
          </div>
          {listError ? <small className="quick-set-test is-bad">{listError}</small> : !models && <small>{C.fetchModelsHint}</small>}
          <ModelSpecHint protocol={form.protocol} baseUrl={form.baseUrl} model={form.model} />
        </div>
        {error && (
          <div className="admin-form-error" role="alert">
            {error}
          </div>
        )}
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
