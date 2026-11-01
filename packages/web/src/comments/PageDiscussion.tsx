/* ---------- 整页讨论（正文下方、反向链接之上）----------
 * 列出整页讨论串，底部输入框开新串；已解决的折叠到「已解决 N 条」。串滚进视口就算读过（收件箱里那条随之消失）。
 * readOnly（公开页）不画输入框；没有串时公开页整块不画。 */

import { useEffect, useRef, useState } from 'react'
import { COPY } from '../copy'
import CommentComposer from './CommentComposer'
import CommentThread, { type CommentCtx } from './CommentThread'
import type { Thread } from './comments-api'
import { createThread, markThreadRead, useComments } from './comments-store'

const C = COPY.comments

/** 串露出一半以上才算看到了 */
function SeenThread({ thread, ctx }: { thread: Thread; ctx: CommentCtx }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = thread.id
  useEffect(() => {
    const el = ref.current
    if (!el || ctx.readOnly || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) markThreadRead(id)
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [id, ctx.readOnly, thread.comments.length])
  return (
    <div ref={ref}>
      <CommentThread thread={thread} ctx={ctx} />
    </div>
  )
}

export default function PageDiscussion({ pageId, ctx }: { pageId: string; ctx: CommentCtx }) {
  const { threads, pageId: loadedFor } = useComments()
  const [showResolved, setShowResolved] = useState(false)
  // store 还是上一页的（换页那一帧）就先不画
  const page = loadedFor === pageId ? threads.filter((t) => t.kind === 'page') : []
  const open = page.filter((t) => !t.resolvedAt)
  const done = page.filter((t) => t.resolvedAt)
  if (ctx.readOnly && open.length === 0) return null
  return (
    <section className="cm-discussion" aria-label={C.discussion}>
      <h2 className="cm-discussion-title">{C.discussion}</h2>
      {open.map((t) => (
        <SeenThread key={t.id} thread={t} ctx={ctx} />
      ))}
      {done.length > 0 && (
        <>
          <button type="button" className="cm-fold" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
            {C.resolvedFold(done.length)}
          </button>
          {showResolved && done.map((t) => <SeenThread key={t.id} thread={t} ctx={ctx} />)}
        </>
      )}
      {!ctx.readOnly && (
        <CommentComposer
          getSchema={ctx.getSchema}
          tick={ctx.tick}
          spaceId={ctx.spaceId}
          placeholder={C.pagePlaceholder}
          onSubmit={async (text) => {
            await createThread('page', text)
          }}
        />
      )}
    </section>
  )
}
