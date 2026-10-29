import { useState } from 'react'
import type { Page, Space, User } from './api'
import { COPY } from './copy'
import { Icon, type IconName } from './icons'
import { MachinesPane } from './MachinesPane'
import Modal from './Modal'
import { QuickAiPane } from './QuickAiPane'
import SpaceSettings from './SpaceSettings'
import { ConnectorsPane } from './ConnectorsPane'
import { AccountPane, AgentPane, EditorPane, ShortcutsPane } from './settings-panes'

/* ---------- 主设置弹窗 ----------
 * 入口：侧栏底部「空间切换」右边的 ⚙（常驻）。左侧分组导航（带图标），右侧标题 + 说明 + 卡片式设置行：
 *   个人   账户（头像 / 修改密码 / 登出）· 编辑器（编辑方式 / 新页面默认打开方式）· 默认 Agent · 随手 AI（⌘J 用的模型连接）
 *   空间   成员与空间（成员 / 邀请 / 改名 / 退出 / 删除）· 连接器（本地 connector 配对 / 列表 / 撤销）
 *          · 机器（谁能用接入的机器：授权 / 申请 / 使用记录）
 * 空间组：无选中空间时不出现；连接器是写入口，只读成员不出现（成员能接入自己的机器，批准要空间所有者）；
 * 机器分页只读成员也看得到列表（只是不能申请）。
 * 权限只在分页可见性上表达；各分页内容自己管自己的动作权限。外壳是 Modal（portal 到 body，见 Modal.tsx）。
 * 卡片 / 行 / 开关等原语在 form-kit.tsx，各分页在 settings-panes.tsx 与 SpaceSettings.tsx。 */

type TabId = 'account' | 'editor' | 'keys' | 'agent' | 'quick' | 'space' | 'connectors' | 'machines'

const TABS: Record<TabId, { label: string; icon: IconName; desc: string }> = {
  account: { label: '账户', icon: 'user', desc: '头像、密码与登录' },
  editor: { label: '编辑器', icon: 'edit', desc: '编辑体验与新页面的默认打开方式' },
  keys: { label: '快捷键', icon: 'keyboard', desc: '键盘快捷键与 Markdown 输入写法' },
  agent: { label: '默认 Agent', icon: 'bot', desc: '聊天输入框与 /命令 默认使用的 agent' },
  quick: { label: COPY.quickSettings.tab, icon: 'sparkle', desc: COPY.quickSettings.desc },
  space: { label: '成员与空间', icon: 'users', desc: '成员、邀请链接与空间管理' },
  connectors: { label: '连接器', icon: 'plug', desc: '让 agent 跑在你自己的机器上，经出站连接接到这里' },
  machines: { label: COPY.machines.tab, icon: 'terminal', desc: COPY.machines.desc },
}

export default function SettingsModal({
  user,
  space,
  onClose,
  onChanged,
  onSpaceGone,
  onLogout,
  onAvatarChange,
  pages,
  initialTab,
}: {
  user: User
  /** 当前选中空间；null（还没空间）时空间组不出现 */
  space: Space | null
  onClose: () => void
  onChanged: () => void
  onSpaceGone: (spaceId: string) => void
  onLogout: () => void
  /** 头像换了（Shell 更新登录态） */
  onAvatarChange: (avatar: string | null) => void
  /** 侧栏的页面列表（机器使用记录里把页面 id 显示成标题）；可缺 */
  pages?: readonly Page[] | null
  /** 打开时直接落在这一页（编辑器里随手 AI 的「去设置」） */
  initialTab?: TabId
}) {
  // 空间组：成员（含只读成员）都能看成员列表；无选中空间不出现
  const canSpace = space !== null
  // 连接器是写入口（配对 / 撤销）：只读成员 / 无空间都不出现
  const canConnectors = canSpace && space.my_role !== 'viewer'
  const personal: TabId[] = ['account', 'editor', 'keys', 'agent', 'quick']
  const spaceTabs: TabId[] = canSpace ? ['space', ...(canConnectors ? (['connectors'] as const) : []), 'machines'] : []
  const [tab, setTab] = useState<TabId>(initialTab ?? 'account')
  // 分页可能中途变得不可见（空间被退）；回落到账户，不留空白
  const active: TabId = [...personal, ...spaceTabs].includes(tab) ? tab : 'account'
  const meta = TABS[active]

  const navItem = (id: TabId) => (
    <button
      key={id}
      type="button"
      className={'set-nav-item' + (id === active ? ' is-on' : '')}
      aria-current={id === active ? 'page' : undefined}
      onClick={() => setTab(id)}
    >
      <Icon name={TABS[id].icon} size={16} />
      <span>{TABS[id].label}</span>
    </button>
  )

  return (
    <Modal onClose={onClose} className="settings-modal" label="设置">
      <nav className="set-nav" aria-label="设置分类">
        <div className="set-nav-title">设置</div>
        <div className="set-nav-group">个人</div>
        {personal.map(navItem)}
        {spaceTabs.length > 0 && space && (
          <>
            <div className="set-nav-group" title={space.name}>
              空间 · {space.name}
            </div>
            {spaceTabs.map(navItem)}
          </>
        )}
      </nav>
      <section className="set-main">
        <header className="set-main-head">
          <div className="set-main-titles">
            <h2 className="set-main-title">{meta.label}</h2>
            <p className="set-main-desc">{active === 'space' && space ? `「${space.name}」的${meta.desc}` : meta.desc}</p>
          </div>
          <button className="modal-close" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="set-main-body">
          {active === 'account' && <AccountPane user={user} onLogout={onLogout} onAvatarChange={onAvatarChange} />}
          {active === 'editor' && <EditorPane />}
          {active === 'keys' && <ShortcutsPane />}
          {active === 'agent' && <AgentPane />}
          {active === 'quick' && <QuickAiPane />}
          {active === 'space' && space && (
            <SpaceSettings space={space} user={user} onClose={onClose} onChanged={onChanged} onSpaceGone={onSpaceGone} />
          )}
          {active === 'connectors' && space && <ConnectorsPane space={space} />}
          {active === 'machines' && space && <MachinesPane space={space} user={user} pages={pages ?? null} onNavigate={onClose} />}
        </div>
      </section>
    </Modal>
  )
}
