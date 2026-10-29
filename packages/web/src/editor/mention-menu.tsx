/* ---------- 引用提示列表（输入卡上方） ----------
 * 只渲染：键盘导航状态（activeIndex / 进入的分类 / 键位）与一次性触发会话在 ChatView，选中只有一条路径
 * onAct(activate(candidate))，鼠标点击与 Enter / Tab 走同一条。候选与触发规则在 mention-query.ts，分组与每行显示在
 * mention-rows.ts，图标在 mention-icon.ts，键位语义在 mention-nav.ts（文档模式的 doc-mention.ts 用同一份）。
 * 没有候选时 ChatView 直接结束会话，这里不画空态。
 * 样式 .pop-card / .pop-row 见 styles/menus.css，定位 .chat-mention 与 .mention-list / .mention-foot 见 styles/chat.css */

import type { Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { candidateKey, type Candidate, type MentionCategory, type MentionTrigger } from './mention-query'
import { chevronEl, rowIconEl } from './mention-icon'
import { activate, type MentionKeyAction } from './mention-nav'
import { mentionRows } from './mention-rows'

interface Props {
  matches: Candidate[]
  pages: readonly Page[] | null
  trigger: MentionTrigger
  category: MentionCategory | null
  activeIndex: number
  onActive: (index: number) => void
  onAct: (action: MentionKeyAction) => void
}

export default function MentionMenu({ matches, pages, trigger, category, activeIndex, onActive, onAct }: Props) {
  return (
    <div className="pop-card chat-mention">
      <div className="mention-list">
        {mentionRows(matches, pages, category).map((row) =>
          row.kind === 'section' ? (
            <div key={`s:${row.title}`} className="pop-section">
              {row.title}
            </div>
          ) : row.kind === 'back' ? (
            <button
              key="back"
              type="button"
              className="mention-back"
              title={COPY.mention.back}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAct({ type: 'back' })}
            >
              <Icon name="chevron" size={12} />
              {row.title}
            </button>
          ) : (
            <button
              key={candidateKey(row.cand)}
              type="button"
              className={row.index === activeIndex ? 'pop-row is-active' : 'pop-row'}
              ref={(el) => {
                if (el && row.index === activeIndex) el.scrollIntoView({ block: 'nearest' })
              }}
              // 别把输入框焦点抢走：blur 会先关掉菜单，click 就到不了了
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (row.index !== activeIndex) onActive(row.index)
              }}
              onClick={() => onAct(activate(row.cand))}
            >
              <span className="pop-ic-slot" ref={(el) => el?.replaceChildren(rowIconEl(row.icon))} />
              <span className="pop-t">{row.title}</span>
              {row.aside && <span className="pop-aside">{row.aside}</span>}
              {row.enter && <span className="pop-ic-slot" ref={(el) => el?.replaceChildren(chevronEl())} />}
            </button>
          ),
        )}
      </div>
      {trigger === '@' && <div className="mention-foot">{COPY.mention.hint}</div>}
    </div>
  )
}
