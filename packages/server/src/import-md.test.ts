import { expect, test } from 'vitest'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { ASSET_TOKEN, finishBlocks, LinkIndex, planPages, rewriteMarkdown, type ImportFile } from './import-md.js'

/* 不变量（import-md.ts 文件头）：目录 → 页面、folder note 当目录页正文；双链 / 嵌入 / 相对链接换成站内形态；
 * 代码里的内容不动；认不出的链接退成文字。 */

const file = (path: string, text = ''): ImportFile => ({ path, data: Buffer.from(text) })

function ids(): () => string {
  let n = 0
  return () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`
}

const vault = [
  file('Vault/首页.md'),
  file('Vault/项目/项目.md', '目录页正文'),
  file('Vault/项目/计划.md'),
  file('Vault/项目/图/架构.png'),
  file('Vault/附件/会议.pdf'),
  file('Vault/.obsidian/app.json'),
]

test('目录成页、folder note 当目录页正文、隐藏目录跳过', () => {
  const pages = planPages(vault, ids())
  const byTitle = new Map(pages.map((p) => [p.title, p]))
  expect([...byTitle.keys()].sort()).toEqual(['Vault', '计划', '项目', '首页'].sort())
  expect(byTitle.get('项目')!.mdPath).toBe('Vault/项目/项目.md')
  expect(byTitle.get('计划')!.parentKey).toBe(byTitle.get('项目')!.key)
  expect(byTitle.get('首页')!.parentKey).toBe(byTitle.get('Vault')!.key)
})

test('双链 / 别名 / 嵌入 / 相对链接', () => {
  const pages = planPages(vault, ids())
  const index = new LinkIndex(pages, vault)
  const plan = pages.find((p) => p.title === '计划')!
  const md = [
    '见 [[首页]] 和 [[项目/计划#目标|计划书]]，[[不存在]]。',
    '![[架构.png]]',
    '![图](图/架构.png) 与 [会议](../附件/会议.pdf) 与 [首页](../首页.md)',
    '`[[首页]]` 不动',
    '```',
    '[[首页]]',
    '```',
  ].join('\n')
  const out = rewriteMarkdown(md, 'Vault/项目', index)
  const home = pages.find((p) => p.title === '首页')!
  expect(out.text).toContain(`[@首页](page:${home.id})`)
  expect(out.text).toContain(`[@计划](page:${plan.id})`)
  expect(out.text).toContain('，不存在。')
  expect(out.text).toContain(`![架构.png](${ASSET_TOKEN}0)`)
  expect(out.text).toContain(`![图](${ASSET_TOKEN}0)`)
  expect(out.text).toContain(`[会议](${ASSET_TOKEN}1)`)
  expect(out.text).toContain('`[[首页]]` 不动')
  expect(out.text).toContain('```\n[[首页]]\n```')
  expect(out.assets).toEqual(['Vault/项目/图/架构.png', 'Vault/附件/会议.pdf'])
})

test('front matter 的标题、%% 注释 %%', () => {
  const index = new LinkIndex([], [])
  const out = rewriteMarkdown('---\ntitle: "真标题"\ntags: [a]\n---\n正文 %%私下的%% 尾\n%%\n多行\n%%', '', index)
  expect(out.title).toBe('真标题')
  expect(out.text.trim()).toBe('正文  尾')
})

test('finishBlocks：page: 链接 → 页面提及，单独成段的附件链接 → 附件块', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const fileId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const { blocks } = parseBlocks(`看 [@首页](page:${id})\n\n[会议.pdf](/api/files/${fileId})`)
  const done = finishBlocks(blocks, new Map([[`/api/files/${fileId}`, { name: '会议.pdf', size: 42 }]]))
  expect(done[0]!.inlines!.some((x) => 'atom' in x && x.atom === 'page_mention' && x.attrs.pageId === id && x.attrs.title === '首页')).toBe(true)
  expect(done[1]).toEqual({ name: 'attachment', attrs: { src: `/api/files/${fileId}`, name: '会议.pdf', size: 42 } })
})
