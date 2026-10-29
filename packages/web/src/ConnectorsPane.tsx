import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, type ConnectorSummary, type Space } from './api'
import { copyText } from './clipboard'
import { COPY } from './copy'
import { subscribeControl } from './control'
import { Card, ConfirmButton } from './form-kit'
import { Icon } from './icons'
import { relativeTime } from './UpdatesFeed'

/** 连接器（设置 → 连接器）：本地 agent 宿主机。
 *  接入是三步：装安装包，执行 start（命令不含密钥，终端打印一次性配对链接），在浏览器里选空间确认（ConnectMachine.tsx）。
 *  撤销即断连（connector 收到 4403 停重连）。空间所有者 / 成员都能接入（只读成员不能）：所有者接入的直接生效，成员接入的要所有者批准。
 *  谁能批准 / 拒绝由服务端判（只有该空间所有者，全局管理员不参与）；这里只据角色决定摆不摆按钮 */
export function ConnectorsPane({ space }: { space: Space }) {
  const C = COPY.connectors
  const role = space.my_role
  const canPair = role === 'owner' || role === 'member'
  const canApprove = role === 'owner'
  const [list, setList] = useState<ConnectorSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .listConnectors(space.id)
      .then(setList)
      .catch(() => setError(COPY.connectors.loadFailed))
  }, [space.id])

  useEffect(() => {
    refresh()
  }, [refresh])
  // 连接器上线/下线（'agents'）与重连补拉（'sync'）要立刻反映在线态，在浏览器里确认完就能看到它亮了，
  // 不用关掉设置再打开。批准 / 拒绝 / 成员被移出时服务端也广播 'agents'。'changed'（页面/空间写库）与在线态无关，不重拉
  useEffect(
    () =>
      subscribeControl((ev) => {
        if (ev === 'agents' || ev === 'sync') refresh()
      }),
    [refresh],
  )

  /** 批准 / 拒绝 / 撤销共用：失败给服务端的人话（409 已被处理等），成功或失败都重拉，界面以服务端为准 */
  async function act(action: () => Promise<unknown>, failed: string) {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? err.message : failed)
    }
    refresh()
  }

  const onCopyFailed = (): void => setError(C.copyFailed)
  // 生产：先装安装包（部署时打出的 /dl/ramet-connector.tgz，不含源码），再 start；dev 下没有安装包，用源码前台跑
  // （--cloud 给页面自己的地址：vite 把 /connector 代理到 server，终端打印的确认链接也就落在这个前端上）。
  // --allow-remote=all：npm 12 默认拒绝从网址装包（EALLOWREMOTE），旧版本 npm 不认识这个参数只会警告一句。
  // 两条命令分开复制，不用 && 连（Windows PowerShell 5.1 不认）
  const dev = import.meta.env.DEV
  const install = `npm i -g --allow-remote=all ${location.origin}/dl/ramet-connector.tgz`
  const start = dev ? `npm run connector -w packages/server -- --cloud ${location.origin}` : `ramet-connector start --cloud ${location.origin}`

  return (
    <>
      {error && <div className="modal-error">{error}</div>}
      <Card title={C.pairTitle}>
        {canPair ? (
          <>
            <ol className="connector-steps">
              {!dev && (
                <Step title={C.stepInstall} hint={C.stepInstallHint}>
                  <CommandLine command={install} onFailed={onCopyFailed} />
                </Step>
              )}
              <Step title={C.stepStart} hint={dev ? C.stepStartHintDev : C.stepStartHint}>
                <CommandLine command={start} onFailed={onCopyFailed} />
              </Step>
              <Step title={C.stepConfirm} hint={canApprove ? C.stepConfirmHint : `${C.stepConfirmHint}${C.stepConfirmMember}`} />
            </ol>
            {!dev && <p className="set-pad set-desc">{C.manageHint}</p>}
          </>
        ) : (
          <p className="set-empty">{C.viewerCannot}</p>
        )}
      </Card>

      <Card title={C.listTitle(list?.length ?? 0)}>
        {list === null && <p className="set-empty">{C.loading}</p>}
        {list?.length === 0 && <p className="set-empty">{canPair ? C.emptyCanPair : C.empty}</p>}
        {list?.map((connector) => (
          <ConnectorLine key={connector.id} connector={connector} canApprove={canApprove} act={act} />
        ))}
      </Card>
    </>
  )
}

/** 接入步骤的一步：圆圈序号 + 标题 + 命令 + 说明（序号由 CSS 计数器给，dev 少了安装这一步也连得上） */
function Step({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <li className="connector-step">
      <div className="connector-step-title">{title}</div>
      {children}
      <div className="set-desc">{hint}</div>
    </li>
  )
}

/** 一条可复制的命令：各管各的「已复制」 */
function CommandLine({ command, onFailed }: { command: string; onFailed: () => void }) {
  const C = COPY.connectors
  const [copied, setCopied] = useState(false)
  return (
    <div className="connector-cmd">
      <code>{command}</code>
      <button
        type="button"
        className="admin-btn"
        onClick={() =>
          void copyText(command).then((ok) => {
            if (ok) setCopied(true)
            else onFailed()
          })
        }
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? C.copied : C.copy}
      </button>
    </div>
  )
}

function ConnectorLine({
  connector,
  canApprove,
  act,
}: {
  connector: ConnectorSummary
  canApprove: boolean
  act: (action: () => Promise<unknown>, failed: string) => Promise<void>
}) {
  const C = COPY.connectors
  const pending = connector.status === 'pending'
  // 次行：待批准的先说在等什么（所有者看到的是「谁接入的、等你批准」，接入人看到的是「批准前谁都用不了」）
  const lead = pending
    ? canApprove
      ? C.pendingForOwner(connector.owner ?? '?')
      : connector.mine
        ? C.pendingForMine
        : C.pendingForOthers
    : connector.owner
      ? C.owner(connector.owner)
      : ''
  const presence = connector.online ? '' : connector.last_seen_at ? C.offlineSince(relativeTime(connector.last_seen_at)) : C.offline
  const agentsText = connector.agents.length
    ? connector.agents.map((a) => a.label).join('、')
    : connector.online
      ? C.noAgentOnline
      : C.noAgentOffline
  return (
    <div className="set-line">
      <span className={'connector-dot' + (connector.online ? ' on' : '')} title={connector.online ? C.online : C.offline} />
      <div className="set-line-main">
        <span className="set-line-name" title={connector.name}>
          {connector.name}
          {connector.mine && <span className="role-badge is-owner">{C.mine}</span>}
          {pending && <span className="role-badge">{C.pendingBadge}</span>}
        </span>
        <span className="set-line-sub">{[lead, presence, agentsText].filter(Boolean).join(' · ')}</span>
      </div>
      {pending && canApprove ? (
        <>
          <button
            type="button"
            className="admin-btn primary"
            title={C.approveTip}
            onClick={() => void act(() => api.approveConnector(connector.id), C.approveFailed)}
          >
            {C.approve}
          </button>
          <ConfirmButton
            confirmLabel={C.rejectConfirm}
            onConfirm={() => void act(() => api.rejectConnector(connector.id), C.rejectFailed)}
            title={C.rejectTip}
          >
            {C.reject}
          </ConfirmButton>
        </>
      ) : (
        (canApprove || connector.mine) && (
          <ConfirmButton
            confirmLabel={C.revokeConfirm}
            onConfirm={() => void act(() => api.revokeConnector(connector.id), C.revokeFailed)}
            title={C.revokeTip}
          >
            {pending ? C.cancelOwn : C.revoke}
          </ConfirmButton>
        )
      )}
    </div>
  )
}
