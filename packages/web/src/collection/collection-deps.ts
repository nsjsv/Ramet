// ---------- 集合依赖的别的集合：对方的行进出 / 改名服务端不推，页面列表一变就比一比 ----------
// 关联 / 汇总的值由服务端算（关联去掉不在对方集合的行，汇总里可能有对方行的名称）。对方集合的行进出回收站、挪走、改名，
// 对方集合本身进回收站或挪到别的空间，服务端都不发增量（同本集合「行的进出不推」的契约）。所以每次拿到新页面列表时，
// 对每个打开着、有关联的集合，比较它关联到的集合（对方集合在不在、在哪个空间，以及它的子页）；变了就重取这个集合。
// 依赖哪些集合按本集合的定义算（关联的 cfg.target），不按服务端给的 refs：失效的关联在 refs 里没有目标，
// 而对方集合挪回本空间正要靠这里发现。汇总挂在关联上，对方集合就是那个关联的另一端。
// 对方行的标题只在有汇总读「名称」、或有公式引用这个关联（公式里关联的值就是对方行的标题列表，ref_titles 随窗口来）时才比：
// 关联格的标题直接从页面列表取，不用重取；打字改标题时每次落库都会重拉页面列表，
// 无条件比标题的话，看着关联集合（尤其自关联：本集合改名本来只本地改那一行）的人会跟着一遍遍重取窗口。
import { compileFormulas, TITLE_PROP_ID, type CollectionSchema } from '@ramet/shared/collection-model'
import type { Page } from '../api'

/** 依赖的快照：键是对方集合与它的行的 id，值是决定计算结果的那几样（对方集合：种类 + 空间；行：父页，要比标题时 + 标题） */
export type DepsSnapshot = ReadonlyMap<string, string>

/** 本集合的关联指向的集合（正向 = 目标集合，反向 = 源集合；自关联就是自己）→ 要不要比对方行的标题 */
export function depTargets(schema: CollectionSchema): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const prop of schema.props) if (prop.type === 'relation' && prop.cfg.target && !out.has(prop.cfg.target)) out.set(prop.cfg.target, false)
  const titled = (relationId: string | undefined): void => {
    const target = schema.props.find((p) => p.id === relationId && p.type === 'relation')?.cfg.target
    if (target && out.has(target)) out.set(target, true)
  }
  for (const prop of schema.props) if (prop.type === 'rollup' && prop.cfg.prop === TITLE_PROP_ID) titled(prop.cfg.relation)
  for (const c of compileFormulas(schema).values()) for (const dep of c.deps) titled(dep)
  return out
}

/** 没有关联、定义或列表还没到 = null（不比） */
export function depsSnapshot(schema: CollectionSchema | null, pages: readonly Page[] | null): DepsSnapshot | null {
  if (!schema || !pages) return null
  const targets = depTargets(schema)
  if (targets.size === 0) return null
  const out = new Map<string, string>()
  for (const p of pages) {
    if (targets.has(p.id)) out.set(p.id, `${p.kind}\u0000${p.space_id ?? ''}`)
    else if (p.kind === 'doc' && p.parent_id !== null && targets.has(p.parent_id)) {
      out.set(p.id, targets.get(p.parent_id) ? `${p.parent_id}\u0000${p.title}` : p.parent_id)
    }
  }
  return out
}

/** 依赖有没有变。一边是 null（刚有关联 / 列表刚到）不算：那时窗口要么正按新定义重取，要么刚取过 */
export function depsChanged(before: DepsSnapshot | null, after: DepsSnapshot | null): boolean {
  if (!before || !after) return false
  if (before.size !== after.size) return true
  for (const [key, value] of after) if (before.get(key) !== value) return true
  return false
}
