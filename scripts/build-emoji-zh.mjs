#!/usr/bin/env node
// 生成 emoji 选择器的中文搜索词表 packages/web/src/emoji-zh.json（一次性脚本，产物已提交，升级数据时才重跑）。
// 来源：emojibase-data 的 zh/compact.json（MIT，CLDR 中文注释）。@emoji-mart/data 自带的关键词全是英文，
// 选择器里搜中文靠这份词表在加载时并进 keywords（见 packages/web/src/emoji-search.ts）。
// 产物形状 { "<码点，小写、去 fe0f>": [中文名, ...标签] }，只留搜索要用的字段（原文件带肤色变体、分组等）。
// 用法：node scripts/build-emoji-zh.mjs
import { writeFileSync } from 'node:fs'

const VERSION = '17.0.0'
const URL = `https://cdn.jsdelivr.net/npm/emojibase-data@${VERSION}/zh/compact.json`
const OUT = 'packages/web/src/emoji-zh.json'

/** 与 emoji-search.ts 的 hexKey 同一规则：小写，去掉 fe0f（变体选择符） */
const key = (hexcode) =>
  hexcode
    .toLowerCase()
    .split('-')
    .filter((p) => p !== 'fe0f')
    .join('-')

const res = await fetch(URL)
if (!res.ok) throw new Error(`下载失败 ${res.status}：${URL}`)
const list = await res.json()

const out = {}
for (const item of list) {
  const terms = [item.label, ...(item.tags ?? [])].filter((t, i, all) => t && all.indexOf(t) === i)
  if (terms.length) out[key(item.hexcode)] = terms
}
writeFileSync(OUT, JSON.stringify(out) + '\n')
console.log(`${Object.keys(out).length} 条 → ${OUT}`)
