import { describe, expect, test } from 'vitest'
import { parseBlocks, type Block, type Inline } from '@ramet/shared/markdown-blocks'
import { parseMarkdown, transformDialect, transformInline, type Md } from '@ramet/shared/md-dialect'

/* 不变量（@ramet/shared/md-dialect 与 markdown-blocks.ts 文件头）：服务端解析（AI 落块 / edit_page / 导入）与编辑器同一套
 * GFM 参数和方言识别；方言识别是纯函数、幂等，不成对的标签原样留下。 */

/** 行内内容的紧凑写法：文字[mark,mark]，换行写 ⏎ */
function inl(inlines: Inline[] | undefined): string {
  return (inlines ?? [])
    .map((x) => ('br' in x ? '⏎' : 'atom' in x ? `<${x.atom}>` : x.marks.length ? `${x.text}[${x.marks.map((m) => m.name).join(',')}]` : x.text))
    .join('')
}

function first(md: string): Block {
  const { blocks } = parseBlocks(md)
  return blocks[0]!
}

describe('parseBlocks：GFM 全量', () => {
  test('删除线落成 strike_through', () => {
    expect(inl(first('a ~~b~~ c').inlines)).toBe('a b[strike_through] c')
  })

  test('待办落成 list_item.checked，普通条目不带 checked', () => {
    const { blocks } = parseBlocks('- [ ] 未做\n- [x] 已做\n- 普通')
    const items = blocks.map((b) => b.blocks![0]!.attrs.checked)
    expect(items).toEqual([false, true, undefined])
  })

  test('裸网址落成链接', () => {
    const block = first('看 https://example.com 这里')
    expect(block.inlines?.some((x) => 'text' in x && x.marks.some((m) => m.name === 'link' && m.attrs.href === 'https://example.com'))).toBe(true)
  })

  test('表格照旧', () => {
    expect(first('| a | b |\n| - | - |\n| 1 | 2 |').name).toBe('table')
  })

  test('脚注退成文字', () => {
    const { blocks } = parseBlocks('正文[^1]\n\n[^1]: 注释')
    expect(inl(blocks[0]!.inlines)).toBe('正文[^1]')
    expect(inl(blocks[1]!.inlines)).toBe('[^1]: 注释')
  })
})

describe('方言：行内成对标签', () => {
  test('<u>…</u> 落成 underline，可以套在加粗里', () => {
    expect(inl(first('a <u>b **c**</u> d').inlines)).toBe('a b [underline]c[underline,strong] d')
  })

  test('不成对的 <u> 原样当文字', () => {
    expect(inl(first('a <u>b').inlines)).toBe('a <u>b')
  })

  test('同名嵌套按层配对', () => {
    const html = (value: string): Md => ({ type: 'html', value })
    const text = (value: string): Md => ({ type: 'text', value })
    const out = transformInline([html('<u>'), text('a'), html('<u>'), text('b'), html('</u>'), html('</u>'), text('c')])
    expect(out.map((n) => n.type)).toEqual(['rametMark', 'text'])
    expect(out[0]!.children!.map((n) => n.type)).toEqual(['text', 'rametMark'])
  })

  test('识别幂等：已是方言节点的树再跑一遍不变', () => {
    const root = parseMarkdown('x <u>y</u>')
    const once = JSON.stringify(root)
    transformDialect(root)
    expect(JSON.stringify(root)).toBe(once)
  })
})

describe('方言：数学公式', () => {
  test('行内 $…$ 与块 $$…$$ 落成公式节点', () => {
    const { blocks } = parseBlocks('质能 $E=mc^2$ 方程\n\n$$\n\\int_0^1 x\\,dx\n$$')
    expect(blocks[0]!.inlines?.some((x) => 'atom' in x && x.atom === 'math_inline' && x.attrs.latex === 'E=mc^2')).toBe(true)
    expect(blocks[1]).toMatchObject({ name: 'math_block', text: '\\int_0^1 x\\,dx' })
  })

  test('价格不是公式：「$5 和 $10」、收尾后紧跟数字', () => {
    expect(inl(first('花了 $5 和 $10 块').inlines)).toBe('花了 $5 和 $10 块')
    expect(inl(first('$x$5').inlines)).toBe('$x$5')
  })
})

/** 块树的紧凑写法：名字(子块…)，带关键 attrs */
function tree(blocks: Block[]): string {
  return blocks
    .map((b) => {
      const tag = ['kind', 'fold', 'title', 'src'].filter((k) => b.attrs[k]).map((k) => `${k}=${String(b.attrs[k])}`)
      const head = tag.length ? `${b.name}[${tag.join(',')}]` : b.name
      if (b.blocks) return `${head}(${tree(b.blocks)})`
      if (b.inlines) return `${head}"${inl(b.inlines)}"`
      return head
    })
    .join(' ')
}

describe('方言：块级', () => {
  test('提示框：GitHub 写法（标记独占一行）与 Obsidian 写法（标题 + 折叠）', () => {
    expect(tree(parseBlocks('> [!NOTE]\n> 正文').blocks)).toBe('callout[kind=note](paragraph"正文")')
    expect(tree(parseBlocks('> [!tip]- 小技巧\n> 一\n>\n> 二').blocks)).toBe('callout[kind=tip,fold=-,title=小技巧](paragraph"一" paragraph"二")')
  })

  test('消息块标记不是提示框', () => {
    expect(parseBlocks('> [!user]\n> 问').blocks[0]!.name).toBe('blockquote')
  })

  test('折叠块：拆开的 html 与一整块 html 都认，摘要是首段', () => {
    const split = parseBlocks('<details>\n<summary>点开</summary>\n\n内容\n\n</details>')
    expect(tree(split.blocks)).toBe('toggle(paragraph"点开" paragraph"内容")')
    const whole = parseBlocks('<details><summary>标题</summary>\n**粗**\n</details>')
    expect(tree(whole.blocks)).toBe('toggle(paragraph"标题" paragraph"粗[strong]")')
  })

  test('分栏：按注释切栏，栏里照常识别', () => {
    const md = '<!-- columns -->\n\n左边\n\n<!-- column -->\n\n> [!warning]\n> 右边\n\n<!-- /columns -->'
    expect(tree(parseBlocks(md).blocks)).toBe('columns(column(paragraph"左边") column(callout[kind=warning](paragraph"右边")))')
  })

  test('目录与嵌入', () => {
    expect(tree(parseBlocks('[TOC]').blocks)).toBe('toc')
    const embed = parseBlocks('<iframe src="https://www.youtube-nocookie.com/embed/abc" height="360"></iframe>').blocks[0]!
    expect(embed).toMatchObject({ name: 'embed', attrs: { kind: 'iframe', height: '360' } })
    expect(parseBlocks('<iframe src="javascript:alert(1)"></iframe>').blocks[0]!.name).toBe('paragraph')
  })
})

describe('方言：颜色与高亮', () => {
  test('<span data-color> / <mark> / ==…==', () => {
    const marks = (md: string) =>
      first(md).inlines!.flatMap((x) => ('text' in x ? x.marks.map((m) => `${x.text}:${m.name}:${String(m.attrs.color)}`) : []))
    expect(marks('a <span data-color="red" style="color:#d44c47">红</span>')).toEqual(['红:text_color:red'])
    expect(marks('<mark data-color="blue">蓝</mark> <mark>黄</mark>')).toEqual(['蓝:highlight:blue', '黄:highlight:yellow'])
    expect(marks('==重点 **加粗**== 尾')).toEqual(['重点 :highlight:yellow', '加粗:highlight:yellow', '加粗:strong:undefined'])
  })

  test('== 前后是空白的不算（比较运算符）', () => {
    expect(inl(first('a == b 而 c == d').inlines)).toBe('a == b 而 c == d')
  })

  test('没有 data-color 的 span 不当颜色', () => {
    expect(inl(first('<span class="x">字</span>').inlines)).toBe('<span class="x">字</span>')
  })
})
