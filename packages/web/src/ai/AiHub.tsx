/* ---------- AI 页（/ai）：Genet / 任务 / 自动 / Skill / 记忆 五个分页 ----------
 * 侧栏的「AI」进来。分页栏就是这一页的标题，每个分页有自己的地址（刷新停在原分页，旧地址 /skills、/memory、/ai/timers 重定向过来）。
 * Genet 分页嵌的是和右下角浮窗同一套对话（AssistantChat）。同一页不能同时开两个对话（输入框桥按页面存），
 * 所以在这个分页上浮窗收起、入口不显示（AssistantDock 认 /ai），收起时没发出去的字带过来。 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useMatch } from 'react-router-dom'
import type { Page, Space } from '../api'
import { COPY } from '../copy'
import AssistantChat from '../assistant/AssistantChat'
import { GenetStatus, useGenetPage, type GenetPage } from './genet-page'
import AutomationList from './AutomationList'
import TaskList from './TaskList'

const SkillLibrary = lazy(() => import('../SkillLibrary'))
const MemoryPanel = lazy(() => import('../memory/MemoryPanel'))

const C = COPY.ai

const TABS = [
  { to: '/ai', label: C.tabs.genet, end: true },
  { to: '/ai/tasks', label: C.tabs.tasks, end: false },
  { to: '/ai/automations', label: C.tabs.automations, end: false },
  { to: '/ai/skills', label: C.tabs.skills, end: false },
  { to: '/ai/memory', label: C.tabs.memory, end: false },
] as const

function GenetTab({
  genet,
  retry,
  pages,
  username,
  onChanged,
}: {
  genet: GenetPage
  retry: () => void
  pages: Page[] | null
  username: string
  onChanged: () => void
}) {
  // 晚一拍挂：浮窗开着时走进来，它要到这一拍提交时（AssistantDock 的 layout effect）才收起、把没发出去的字带过来。
  // 同一拍就挂的话同一页会有两个对话并存：输入框桥、对话单元、审批宿主都按页面登记，还白起一个编辑器会话和连接
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const pageId = genet?.pageId ?? null
  return (
    <div className="ai-chat">
      {!pageId ? (
        <GenetStatus genet={genet} retry={retry} />
      ) : (
        ready && <AssistantChat key={pageId} pageId={pageId} pages={pages} username={username} onPagesChanged={onChanged} />
      )}
    </div>
  )
}

export default function AiHub({
  space,
  spaces,
  pages,
  username,
  onChanged,
}: {
  space: Space | null
  /** 我的全部空间（规则编辑器：发通知能选哪个空间的成员） */
  spaces: Space[] | null
  pages: Page[] | null
  username: string
  onChanged: () => void
}) {
  const onGenet = useMatch('/ai') !== null
  const onTasks = useMatch('/ai/tasks') !== null
  const { genet, retry } = useGenetPage(onGenet || onTasks)
  return (
    <div className={'ai-hub' + (onGenet ? ' is-chat' : '')}>
      <nav className="ai-tabs" aria-label={C.tabsLabel}>
        <div className="ai-tabs-row" data-flip>
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => 'ai-tab' + (isActive ? ' active' : '')}>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <Routes>
        <Route index element={<GenetTab genet={genet} retry={retry} pages={pages} username={username} onChanged={onChanged} />} />
        <Route path="tasks" element={<TaskList genet={genet} retry={retry} pages={pages} />} />
        <Route path="automations" element={<AutomationList pages={pages} spaces={spaces} />} />
        {/* 「定时」分页改成了「自动」：收件箱里的旧链接、书签照样能进来 */}
        <Route path="timers" element={<Navigate to="/ai/automations" replace />} />
        <Route
          path="skills"
          element={
            <Suspense fallback={null}>
              <SkillLibrary space={space} pages={pages} onChanged={onChanged} />
            </Suspense>
          }
        />
        <Route
          path="memory"
          element={
            <Suspense fallback={null}>
              <MemoryPanel space={space} />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/ai" replace />} />
      </Routes>
    </div>
  )
}
