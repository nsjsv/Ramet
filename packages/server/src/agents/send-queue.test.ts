// 排队区那一行的摘要（send-queue.ts 的 summarize）：输入框交来的记号要写成读得懂的字
import { expect, test } from 'vitest'
import { summarize } from './send-queue.js'

test('图片记号拿掉算进张数，其余记号写成 @标签（标签里带 `]` 也按收口锚切）', () => {
  const id = '0b6f4a52-9f9e-4c1d-8f3a-1c2d3e4f5a6b'
  const raw = `对比 @[图片](image:${id}) 和 @[图片](image:${id})\n看 @[[开源]什么？](page:p1) 里 @[a b.ts](file:src/a%20b.ts)，@[Codex](agent:c:1:codex) 审`
  expect(summarize(raw)).toEqual({ text: '对比 和 看 @[开源]什么？ 里 @a b.ts，@Codex 审', images: 2 })
})
