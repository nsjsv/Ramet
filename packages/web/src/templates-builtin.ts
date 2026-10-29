/* ---------- 内置模板 ----------
 * 用的是普通 markdown（含本站方言：待办、提示框、目录、表格），新建时走导入端点建页（api.importMarkdown），
 * 与导入一份 .md 文件是同一条路，不另写建页逻辑。空间自己的模板是页面（is_template），见 TemplatePicker.tsx。 */

export type BuiltinTemplate = { id: string; title: string; desc: string; markdown: string }

const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function builtinTemplates(): BuiltinTemplate[] {
  return [
    {
      id: 'meeting',
      title: '会议记录',
      desc: '议程、讨论、决定与待办',
      markdown: `---
title: 会议记录 ${today()}
---

> [!note] 基本信息
> 时间：${today()}　地点：　主持：　记录：

## 参会

-

## 议程

1.

## 讨论

## 决定

-

## 待办

- [ ] 事项 · 负责人 · 截止日期
`,
    },
    {
      id: 'weekly',
      title: '周报',
      desc: '本周完成、问题与下周计划',
      markdown: `---
title: 周报 ${today()}
---

## 本周完成

- [x]

## 进行中

- [ ]

## 遇到的问题

> [!warning] 需要协助
>

## 下周计划

- [ ]
`,
    },
    {
      id: 'project',
      title: '项目计划',
      desc: '目标、范围、里程碑与风险',
      markdown: `---
title: 项目计划
---

[TOC]

## 背景

## 目标

> [!tip] 写成可以验收的结果
> 例：上线后一周内 80% 的用户完成首次配置。

## 范围

- 做：
- 不做：

## 里程碑

| 里程碑 | 日期 | 负责人 | 状态 |
| --- | --- | --- | --- |
|  |  |  | 未开始 |

## 风险

> [!caution] 风险与应对
>

## 待办

- [ ]
`,
    },
    {
      id: 'reading',
      title: '读书笔记',
      desc: '摘录、想法与行动',
      markdown: `---
title: 读书笔记
---

> [!note] 书目
> 书名：　作者：　读完日期：

## 一句话总结

## 摘录

>

## 我的想法

## 可以付诸行动的

- [ ]
`,
    },
  ]
}
