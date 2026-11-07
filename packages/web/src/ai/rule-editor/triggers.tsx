/* ---------- 规则编辑器的触发来源注册表：来源 → 表单 ----------
 * 加一种能在 AI 页上配的触发 = 写一个表单组件 + 在 TRIGGERS 里登记一项（草稿怎么来、怎么变回服务端要的 config）。
 * 没登记的来源（以后在页面、合集里各自配的那些）照样能在列表里看、开关、删除、改名字与动作，
 * 编辑器的触发一节只显示服务端给的 triggerText，保存时不发 config。
 * builtinOnly 的来源（评论找我 / 正文 @我）只有每人一条的内置规则：能改配置，但「新建规则」里不出现。 */
import type { ComponentType } from 'react'
import type { Page, Space } from '../../api'
import { COPY } from '../../copy'
import type { AutomationView, RuleSource } from '../automation-api'
import { buttonDraftOf, ButtonTrigger, type ButtonDraft } from './ButtonTrigger'
import { CollectionTrigger } from './CollectionTrigger'
import {
  collectionConfigOf,
  collectionDraftOf,
  commentConfigOf,
  commentDraftOf,
  defaultCollectionDraft,
  defaultCommentDraft,
  defaultMentionDraft,
  defaultWatchDraft,
  mentionConfigOf,
  mentionDraftOf,
  watchConfigOf,
  watchDraftOf,
  type CollectionDraft,
  type CommentDraft,
  type MentionDraft,
  type WatchDraft,
} from './event-config'
import { CommentTrigger, MentionTrigger, WatchTrigger } from './EventTriggers'
import { defaultScheduleDraft, scheduleDraftOf, scheduleOf, type Fail, type ScheduleDraft } from './rule-model'
import { TimerTrigger } from './TimerTrigger'
import { defaultWebhookDraft, webhookDraftOf, WebhookTrigger, type WebhookDraft } from './WebhookTrigger'

export type TriggerFormProps<D> = {
  draft: D
  onChange: (d: D) => void
  timeZone: string
  /** 我的全部空间（只看哪些空间的选项） */
  spaces: readonly Space[]
  /** 我看得到的页（盯哪一页的选项） */
  pages: readonly Page[]
  /** 从哪一页打开的编辑器（合集的闪电按钮）：合集的触发固定是这个合集 */
  scopePage: { id: string; title: string } | null
  /** 已有规则的 id（新建 = null）：收到外部请求的「换一个地址」要用 */
  ruleId: string | null
  /** 服务端给了只显示一次的地址（换地址之后）：编辑器切到显示地址的面板 */
  onReveal: (hookPath: string, rule: AutomationView) => void
}

export type TriggerSpec<D> = {
  /** 新建规则时的初始草稿 */
  initial(now: Date): D
  /** 已有规则的 config → 草稿 */
  draftOf(config: unknown, now: Date): D
  /** 草稿 → 发给服务端的 config；不完整 = 原因（显示在表单上） */
  configOf(d: D): unknown
  Form: ComponentType<TriggerFormProps<D>>
  /** 只有内置规则：不能在「新建规则」里选 */
  builtinOnly?: true
  /** 只能从别处建（按钮：在按钮上设置），「新建规则」里不出现 */
  hidden?: true
}

/** 登记时的类型擦除：编辑器只把草稿从 initial / draftOf 拿到、原样交回 configOf / Form，不看里面 */
function define<D>(spec: TriggerSpec<D>): TriggerSpec<unknown> {
  return spec as unknown as TriggerSpec<unknown>
}

const T = COPY.ai.rule.timer

export const TRIGGERS: Partial<Record<RuleSource, TriggerSpec<unknown>>> = {
  timer: define<ScheduleDraft>({
    initial: defaultScheduleDraft,
    draftOf: scheduleDraftOf,
    configOf: (d) => scheduleOf(d, T),
    Form: TimerTrigger,
  }),
  comment: define<CommentDraft>({
    initial: defaultCommentDraft,
    draftOf: commentDraftOf,
    configOf: (d) => commentConfigOf(d, COPY.ai.rule.comment.noReason),
    Form: CommentTrigger,
    builtinOnly: true,
  }),
  mention: define<MentionDraft>({
    initial: defaultMentionDraft,
    draftOf: mentionDraftOf,
    configOf: mentionConfigOf,
    Form: MentionTrigger,
    builtinOnly: true,
  }),
  page_watch: define<WatchDraft>({
    initial: defaultWatchDraft,
    draftOf: watchDraftOf,
    configOf: (d) => watchConfigOf(d, COPY.ai.rule.watch.noPage),
    Form: WatchTrigger,
  }),
  collection: define<CollectionDraft>({
    initial: defaultCollectionDraft,
    draftOf: collectionDraftOf,
    configOf: (d) => collectionConfigOf(d, COPY.ai.rule.collection.noCollection),
    Form: CollectionTrigger,
  }),
  button: define<ButtonDraft>({
    initial: () => ({ label: '' }),
    draftOf: buttonDraftOf,
    configOf: (d) => (d.label.trim() ? { label: d.label.trim() } : { error: COPY.ai.rule.button.noLabel }),
    Form: ButtonTrigger,
    hidden: true,
  }),
  // 配置由服务端写（地址末 4 位），这里永远发空对象
  webhook: define<WebhookDraft>({
    initial: defaultWebhookDraft,
    draftOf: webhookDraftOf,
    configOf: () => ({}),
    Form: WebhookTrigger,
  }),
}

export function triggerSpec(source: string): TriggerSpec<unknown> | null {
  return (TRIGGERS as Record<string, TriggerSpec<unknown> | undefined>)[source] ?? null
}

/** 「新建规则」能选的来源（登记了表单、又不是只有内置规则 / 只能从别处建的） */
export const CREATABLE: RuleSource[] = (Object.keys(TRIGGERS) as RuleSource[]).filter((s) => TRIGGERS[s] && !TRIGGERS[s]?.builtinOnly && !TRIGGERS[s]?.hidden)

export function isFail(v: unknown): v is Fail {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string'
}

/** 触发的一句话：服务端给的说明；它还不认识这种来源时只回来源名，换成人话 */
export function triggerLabel(r: Pick<AutomationView, 'source' | 'triggerText'>): string {
  return r.triggerText && r.triggerText !== r.source ? r.triggerText : (COPY.ai.automations.sources[r.source] ?? r.source)
}
