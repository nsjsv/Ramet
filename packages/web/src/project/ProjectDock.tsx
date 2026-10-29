import { lazy, Suspense, useEffect } from 'react'
import { useMatch } from 'react-router-dom'
import { inTerminal, isProjectToggleKey } from './project-keys'
import { toggleProject, useProjectShell, useProjectTarget } from './project-state'

/** 面板本体按需加载：第一次打开面板才下载（ProjectPanel.tsx，连同五个分页） */
const loadPanel = () => import('./ProjectPanel')
const ProjectPanel = lazy(loadPanel)
/** 空闲时预取面板本体（App 外壳调用），第一次打开面板不用等下载；失败不管，真打开时再拉 */
export const preloadProjectPanel = (): void => void loadPanel().catch(() => {})

/* ---------- 项目面板：挂在 App 外壳右侧的可开合面板（⌘E）----------
 * 浏览 agent 所在机器上的工作区：本轮、文件、改动、终端、预览。文件 / 改动只读（唯一的写是查看器里选中几行 ⌘J 随手 AI 改写，
 * 要页面可写）；机器在用户自己那里，中心只转发。
 * 出现条件：当前页面选中的 agent 是 connector 上的 agent，且我对这台机器有 machine 授权（接入人或被授权）。
 * 依据是 /api/agents 目录里服务端算好的标记，不为试探去请求项目接口。面板没开 / 没有可用的机器时什么都不渲染、不请求。
 * 分页不可见不请求、不轮询；刷新信号（点刷新 / 本页一轮结束）才让可见的分页重拉。 */
export default function ProjectDock({
  canWrite,
  runsOf,
}: {
  canWrite: (pageId: string) => boolean
  /** 本页最近几轮的过程页 id（旧 → 新）：终端分页的「agent 跑的命令」用 */
  runsOf: (pageId: string) => string[]
}) {
  const match = useMatch('/page/:id')
  const pageId = match?.params.id
  const target = useProjectTarget(pageId)
  const { open } = useProjectShell()
  const available = target !== null

  // ⌘E 开关面板：正文里按 ⌘E 仍是行内代码（编辑器先处理并 preventDefault，isProjectToggleKey 对已处理的键返回 false）
  useEffect(() => {
    if (!available) return
    const onKey = (e: KeyboardEvent): void => {
      if (inTerminal(e)) return
      if (!isProjectToggleKey(e)) return
      e.preventDefault()
      toggleProject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [available])

  if (!pageId || !target || !open) return null
  // key：换页 / 换 agent 就是另一份面板状态（树、查看的文件都不能带过去）
  return (
    <Suspense fallback={null}>
      <ProjectPanel
        key={`${pageId}|${target.agent}`}
        pageId={pageId}
        agent={target.agent}
        label={target.label}
        canWrite={canWrite(pageId)}
        runIds={runsOf(pageId)}
      />
    </Suspense>
  )
}
