// ---------- 跨树拖拽：目录树的页面条目拖进页面树 ----------
// 目录树自己的拖拽单例在 FolderTree.tsx；页面树只需要知道「正拖着目录树里的哪个页面条目」，放在这里，
// 免得 PageTree 反过来 import FolderTree（FolderTree 已经读 PageTree 的拖拽源）。dragstart 置位、dragend 清
export type DirPageDrag = { itemId: string; pageId: string }

let dirPageDrag: DirPageDrag | null = null

export function startDirPageDrag(d: DirPageDrag): void {
  dirPageDrag = d
  document.addEventListener('dragend', () => { dirPageDrag = null }, { capture: true, once: true })
}

export function peekDirPageDrag(): DirPageDrag | null {
  return dirPageDrag
}

export function takeDirPageDrag(): DirPageDrag | null {
  const d = dirPageDrag
  dirPageDrag = null
  return d
}
