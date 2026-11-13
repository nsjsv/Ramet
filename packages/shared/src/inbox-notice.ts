// ---------- 收件箱条目 → 一条系统通知（标题 / 正文 / 点开去哪 / 去重身份）----------
// 服务端组 Web Push 的内容、前端组桌面通知的内容都调这里：两条通道对同一件事说同一句话、跳同一个地方，
// 也用同一个身份判断「这件事通知过没有」。
// 输入只列用到的字段（结构类型），服务端与前端各自的 InboxItem 直接传进来；哪边改了形状，tsc 会在调用处报出来。

type Page = { pageId: string; pageTitle: string }

export type NoticeItem =
  | ({ type: 'approval'; key: string; at: null; agentName: string; title: string; detail: { command?: string; path?: string; description?: string } } & Page)
  | ({ type: 'question'; key: string; at: null; agentName: string; text: string } & Page)
  | ({ type: 'plan'; key: string; at: string; title: string } & Page)
  | ({ type: 'done'; key: string; at: string; agentName: string; outcome: string } & Page)
  | { type: 'running'; key: string; at: string }
  | { type: 'connector_pending'; key: string; at: string; machine: string; owner: string | null; spaceName: string }
  | { type: 'access_request'; key: string; at: string; machine: string; username: string; spaceName: string }
  | { type: 'first_use'; key: string; at: string; machine: string; username: string }
  | ({
      type: 'comment'
      key: string
      at: string
      threadId: string
      author: { name: string } | null
      excerpt: string
      reason: 'reply' | 'mention' | 'new_thread'
    } & Page)
  | { type: 'timer_failed'; key: string; at: string; timerName: string; source?: string; reason: string }
  | { type: 'automation'; key: string; at: string; ruleName: string; text: string; pageId: string | null; pageTitle: string }
  | ({ type: 'doc_mention'; key: string; at: string; blockId: string; actor: { name: string }; excerpt: string } & Page)
  | ({ type: 'share'; key: string; at: string; level: 'edit' | 'view'; actor: { name: string } | null } & Page)

export type Notice = {
  title: string
  body: string
  /** 站内路径，点通知后跳过去 */
  url: string
  /** 同一个条目的通知互相替换（浏览器按 tag 只留一条） */
  tag: string
  /** 需要你处理的事（推送的 Urgency 用 high） */
  urgent: boolean
}

const BODY_MAX = 160

/** 「这件事通知过没有」的身份：同一个 key 换了时间（串里来了新回复、同一页又被 @、又跑完一轮）算新的一件。
 *  审批 / 提问没有时间，只看 key */
export function noticeIdent(item: { key: string; at: string | null }): string {
  return `${item.key}@${item.at ?? ''}`
}

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return chars.length > BODY_MAX ? `${chars.slice(0, BODY_MAX - 1).join('')}…` : one
}

const titled = (title: string): string => `《${title.trim() || '无标题'}》`
const pageUrl = (pageId: string): string => `/page/${encodeURIComponent(pageId)}`
const join = (...parts: (string | undefined)[]): string => parts.filter((p) => p && p.trim()).join(' · ')

/** 收件箱里「在跑」不通知（刚发出去的那一轮，人就在跟前）；其余每种都给一条。返回 null = 不通知 */
export function noticeOf(item: NoticeItem): Notice | null {
  const base = { tag: item.key, urgent: false }
  switch (item.type) {
    case 'running':
      return null
    case 'approval': {
      const what = item.detail.command ?? item.detail.path ?? item.detail.description ?? item.title
      return { ...base, urgent: true, title: `${item.agentName} 等你批准`, body: clip(join(what, titled(item.pageTitle))), url: pageUrl(item.pageId) }
    }
    case 'question':
      return { ...base, urgent: true, title: `${item.agentName} 在问你`, body: clip(join(item.text, titled(item.pageTitle))), url: pageUrl(item.pageId) }
    case 'plan':
      return { ...base, urgent: true, title: '计划等你确认', body: clip(join(item.title, titled(item.pageTitle))), url: pageUrl(item.pageId) }
    case 'done': {
      const verb = item.outcome === 'error' ? '出错了' : item.outcome === 'cancelled' ? '已停止' : '做完了'
      return { ...base, title: `${item.agentName} ${verb}`, body: clip(titled(item.pageTitle)), url: pageUrl(item.pageId) }
    }
    case 'connector_pending':
      return {
        ...base,
        urgent: true,
        title: '有机器等你批准接入',
        body: clip(join(`${item.owner ?? '有成员'} 想接入「${item.machine}」`, `空间「${item.spaceName}」`)),
        url: '/inbox',
      }
    case 'access_request':
      return {
        ...base,
        urgent: true,
        title: `${item.username} 申请使用你的机器`,
        body: clip(join(`「${item.machine}」`, `空间「${item.spaceName}」`)),
        url: '/inbox',
      }
    case 'first_use':
      return { ...base, title: `${item.username} 开始使用你的机器`, body: clip(`「${item.machine}」`), url: '/inbox' }
    case 'comment': {
      const verb = item.reason === 'mention' ? '@了你' : item.reason === 'reply' ? '回复了你' : '发了新评论'
      return {
        ...base,
        title: `${item.author?.name ?? '已注销用户'} ${verb}`,
        body: clip(join(item.excerpt, titled(item.pageTitle))),
        url: `${pageUrl(item.pageId)}?comment=${encodeURIComponent(item.threadId)}`,
      }
    }
    case 'doc_mention':
      return {
        ...base,
        title: `${item.actor.name} 在${titled(item.pageTitle)}里 @了你`,
        body: clip(item.excerpt),
        url: item.blockId ? `${pageUrl(item.pageId)}?block=${encodeURIComponent(item.blockId)}` : pageUrl(item.pageId),
      }
    case 'share':
      return {
        ...base,
        title: `${item.actor?.name ?? '有人'} 把${titled(item.pageTitle)}分享给了你`,
        body: item.level === 'edit' ? '可编辑' : '只读',
        url: pageUrl(item.pageId),
      }
    case 'timer_failed': {
      const kind = !item.source || item.source === 'timer' ? '定时' : '规则'
      return { ...base, title: `${kind}「${item.timerName}」没能触发`, body: clip(item.reason), url: '/ai/automations' }
    }
    case 'automation':
      return {
        ...base,
        title: `规则「${item.ruleName}」`,
        body: clip(join(item.text, item.pageId ? titled(item.pageTitle) : undefined)),
        url: item.pageId ? pageUrl(item.pageId) : '/inbox',
      }
  }
}

/** 一次攒了太多条时合成的那一条（合盖醒来补拉 / 服务端一次发现很多件） */
export function moreNotice(count: number): Notice {
  return { title: `还有 ${count} 件事`, body: '打开收件箱查看', url: '/inbox', tag: 'ramet:more', urgent: false }
}
