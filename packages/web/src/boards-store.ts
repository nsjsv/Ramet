// ---------- 目录树列表的进程内快照 ----------
// 目录树数据只由侧栏 Boards 取（它负责广播重拉）；顶栏面包屑也要目录结构，订阅这份快照，不另发一次 GET /api/boards
import { useSyncExternalStore } from 'react'
import type { BoardsPayload } from './api'

let current: BoardsPayload | null = null
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function publishBoards(data: BoardsPayload | null): void {
  if (data === current) return
  current = data
  for (const fn of listeners) fn()
}

export function useBoardsSnapshot(): BoardsPayload | null {
  return useSyncExternalStore(subscribe, () => current)
}
