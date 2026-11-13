/* ---------- 空间 AI 页（/spaces/:id/ai）：对话 / 记忆 / Skill 三个分页 ----------
 * 侧栏页面树上方那一行进来。「对话」是我和这个空间的空间 AI 的直接对话（只有我看得到，assistant/SpaceAiChat.tsx），
 * 「记忆」「Skill」是这个空间的公共记忆与 skill 库（原来放在 /ai 里跟着侧栏当前空间切，现在归到各自的空间）。
 * 只认我是成员的空间：不在空间列表里（不存在、不是成员、作为访客进得去的空间）一律「找不到」。 */
import { lazy, Suspense } from 'react'
import { Navigate, NavLink, Route, Routes, useMatch, useParams } from 'react-router-dom'
import type { Page, Space } from '../api'
import { COPY } from '../copy'
import SpaceAiChat from '../assistant/SpaceAiChat'
import { useSpaceAiOfSpace } from '../assistant/space-ai'
import { spaceAiPath } from './space-ai-path'

const SkillLibrary = lazy(() => import('../SkillLibrary'))
const SpaceMemory = lazy(() => import('../memory/MemoryPanel').then((m) => ({ default: m.SpaceMemory })))

const C = COPY.spaceAi.hub

export default function SpaceAiHub({
  spaces,
  pages,
  username,
  onChanged,
}: {
  spaces: Space[] | null
  pages: Page[] | null
  username: string
  onChanged: () => void
}) {
  const { id = '' } = useParams<{ id: string }>()
  const space = spaces?.find((s) => s.id === id) ?? null
  const ai = useSpaceAiOfSpace(space?.id)
  const onChat = useMatch('/spaces/:id/ai') !== null
  if (spaces === null) return <div className="loading">{COPY.loading}</div>
  if (!space) return <div className="page-gone">{C.notFound}</div>
  const name = ai?.name ?? ''
  const tabs = [
    { to: spaceAiPath(space.id), label: C.tabs.chat, end: true },
    { to: spaceAiPath(space.id, 'memory'), label: C.tabs.memory, end: false },
    { to: spaceAiPath(space.id, 'skills'), label: C.tabs.skills, end: false },
  ]
  return (
    <div className={'ai-hub' + (onChat ? ' is-chat' : '')}>
      <nav className="ai-tabs" aria-label={C.tabsLabel(name, space.name)}>
        <div className="ai-tabs-row" data-flip>
          <span className="ai-tabs-title" data-tip={space.name}>
            {name}
          </span>
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => 'ai-tab' + (isActive ? ' active' : '')}>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <Routes>
        <Route index element={<SpaceAiChat key={space.id} space={space} aiName={name} pages={pages} username={username} onChanged={onChanged} />} />
        <Route
          path="memory"
          element={
            <Suspense fallback={null}>
              <SpaceMemory space={space} />
            </Suspense>
          }
        />
        <Route
          path="skills"
          element={
            <Suspense fallback={null}>
              <SkillLibrary space={space} pages={pages} onChanged={onChanged} />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to={spaceAiPath(space.id)} replace />} />
      </Routes>
    </div>
  )
}
