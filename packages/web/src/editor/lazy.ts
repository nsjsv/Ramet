// 大库按需加载：高亮（lowlight + highlight.js common 语言）、mermaid、KaTeX 都很大，主包不带，
// 文档里出现对应的块才 import()，打成独立 chunk。同一个库只加载一次（Promise 缓存）；加载完成后通知订阅者
// （PM 插件据此派空事务重画装饰 / nodeView），已加载的库同步可取（ready）。加载失败不缓存，下次调用重新发起。

type Entry<T> = { promise: Promise<T>; value?: T }

const entries = new Map<string, Entry<unknown>>()
const listeners = new Set<(key: string) => void>()

function lazy<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key) as Entry<T> | undefined
  if (hit) return hit.promise
  const entry: Entry<T> = {
    promise: load().then(
      (value) => {
        entry.value = value
        for (const fn of listeners) fn(key)
        return value
      },
      (err: unknown) => {
        entries.delete(key)
        throw err
      },
    ),
  }
  entries.set(key, entry as Entry<unknown>)
  return entry.promise
}

/** 已加载完的库（同步）；没加载 / 加载中 = undefined */
function ready<T>(key: string): T | undefined {
  return (entries.get(key) as Entry<T> | undefined)?.value
}

/** 任一库加载完成时回调；返回取消订阅 */
export function onLazyLoaded(fn: (key: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export type Lowlight = ReturnType<typeof import('lowlight').createLowlight>

export function loadLowlight(): Promise<Lowlight> {
  return lazy('lowlight', async () => {
    const { createLowlight, common } = await import('lowlight')
    return createLowlight(common)
  })
}

export function lowlightReady(): Lowlight | undefined {
  return ready<Lowlight>('lowlight')
}

export type Mermaid = (typeof import('mermaid'))['default']

export function loadMermaid(): Promise<Mermaid> {
  return lazy('mermaid', async () => (await import('mermaid')).default)
}

export type Katex = (typeof import('katex'))['default']

/** KaTeX 连同它的样式表一起按需加载（字体由样式表按用到的字形再拉） */
export function loadKatex(): Promise<Katex> {
  return lazy('katex', async () => {
    const [mod] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    return mod.default
  })
}

export function katexReady(): Katex | undefined {
  return ready<Katex>('katex')
}
