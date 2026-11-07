import { describe, expect, test } from 'vitest'
import {
  commentConfigOf,
  commentDraftOf,
  defaultCommentDraft,
  defaultMentionDraft,
  mentionConfigOf,
  mentionDraftOf,
  collectionConfigOf,
  collectionDraftOf,
  quietChoices,
  toggleProp,
  toggleReason,
  watchConfigOf,
  watchDraftOf,
  toggleSpace,
} from './event-config'
import { isFail, triggerSpec } from './triggers'

const NOW = new Date(2026, 10, 6, 14, 3)

describe('评论找我', () => {
  test('缺省三种原因全选、全部空间；往返不变', () => {
    expect(defaultCommentDraft()).toEqual({ reasons: ['mention', 'reply', 'new_thread'], spaces: [] })
    const spec = triggerSpec('comment')!
    for (const config of [
      { reasons: ['mention', 'reply', 'new_thread'], spaces: [] },
      { reasons: ['reply'], spaces: ['s1', 's2'] },
    ]) {
      expect(spec.configOf(spec.draftOf(config, NOW))).toEqual(config)
    }
  })

  test('原因按固定顺序发；一个都没选 = 原因', () => {
    expect(commentConfigOf({ reasons: ['new_thread', 'mention'], spaces: [] }, 'no')).toEqual({ reasons: ['mention', 'new_thread'], spaces: [] })
    expect(isFail(commentConfigOf({ reasons: [], spaces: [] }, 'no'))).toBe(true)
  })

  test('认不出的配置回落缺省（同服务端读库），空间去重去空白', () => {
    expect(commentDraftOf(null)).toEqual(defaultCommentDraft())
    expect(commentDraftOf({ reasons: ['nope'], spaces: 'x' })).toEqual(defaultCommentDraft())
    expect(commentDraftOf({ reasons: ['reply', 'nope'], spaces: [' s1 ', 's1', '', 3] })).toEqual({ reasons: ['reply'], spaces: ['s1'] })
  })

  test('切换原因保持固定顺序', () => {
    expect(toggleReason(['mention', 'new_thread'], 'reply')).toEqual(['mention', 'reply', 'new_thread'])
    expect(toggleReason(['mention', 'reply'], 'mention')).toEqual(['reply'])
  })
})

describe('正文 @我', () => {
  test('缺省全部空间；往返不变', () => {
    expect(defaultMentionDraft()).toEqual({ spaces: [] })
    expect(mentionConfigOf(mentionDraftOf({ spaces: ['s1'] }))).toEqual({ spaces: ['s1'] })
    expect(mentionDraftOf({ spaces: 'nope' })).toEqual({ spaces: [] })
    const spec = triggerSpec('mention')!
    expect(spec.configOf(spec.initial(NOW))).toEqual({ spaces: [] })
  })
})

describe('盯页面', () => {
  test('缺省含子页、10 分钟、没选页 = 原因；往返不变；认不出的回落缺省', () => {
    const spec = triggerSpec('page_watch')!
    expect(spec.initial(NOW)).toEqual({ page: '', subtree: true, quiet: 10 })
    expect(isFail(spec.configOf(spec.initial(NOW)))).toBe(true)
    for (const config of [
      { page: 'p1', subtree: true, quiet: 10 },
      { page: 'p2', subtree: false, quiet: 45 },
    ]) {
      expect(spec.configOf(spec.draftOf(config, NOW))).toEqual(config)
    }
    expect(watchDraftOf({ page: 3, subtree: 'x', quiet: -1 })).toEqual({ page: '', subtree: true, quiet: 10 })
    expect(watchConfigOf({ page: '', subtree: true, quiet: 5 }, 'no')).toEqual({ error: 'no' })
  })

  test('停手时长的档：库里的值不在档里时补上、按大小排', () => {
    expect(quietChoices(10)).toEqual([5, 10, 30, 60])
    expect(quietChoices(45)).toEqual([5, 10, 30, 45, 60])
  })
})

describe('合集里有变化', () => {
  test('往返不变；没选合集 = 原因；「新增了一行」不带属性与条件；坏配置回落缺省', () => {
    const spec = triggerSpec('collection')!
    expect(spec.initial(NOW)).toEqual({ collection: '', on: 'added', props: [], conds: [] })
    expect(isFail(spec.configOf(spec.initial(NOW)))).toBe(true)
    const edited = { collection: 'c1', on: 'edited', props: ['p1'], filter: { all: [{ prop: 'p1', op: 'is', value: 'o1' }] } }
    expect(spec.configOf(spec.draftOf(edited, NOW))).toEqual(edited)
    expect(collectionConfigOf({ collection: 'c1', on: 'added', props: ['p1'], conds: [{ prop: 'p1', op: 'empty' }] }, 'no')).toEqual({
      collection: 'c1',
      on: 'added',
      props: [],
      filter: { all: [] },
    })
    expect(collectionDraftOf({ on: 'x', props: 'p', filter: 3 })).toEqual({ collection: '', on: 'added', props: [], conds: [] })
    expect(toggleProp(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleProp(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('空间多选', () => {
  test('「全部空间」= 清空；点一个空间加进去 / 再点去掉，去到一个不剩就是全部', () => {
    expect(toggleSpace(['a', 'b'], null)).toEqual([])
    expect(toggleSpace([], 'a')).toEqual(['a'])
    expect(toggleSpace(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleSpace(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleSpace(['a'], 'a')).toEqual([])
  })
})
