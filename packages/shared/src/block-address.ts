// ---------- 可寻址块：哪些块有块 id ----------
// 可寻址块 = 顶层块 + 任意深度的列表项 + agent_reply 与分栏里每一栏（column）的直接子块，
// 与编辑器手柄能指到的块是同一个集合（命中规则见 web/src/editor/block-handle.ts）。
// 每个可寻址块都有一页之内唯一的非空 id（复制链接、提及、同步块、提示词里的块引用都靠它）。
// 谁建块谁给 id：服务端 materialize 建块时写，web 端打字新建的块由补 id 插件补（block-id.ts）。
// 判定只在这里定义一份，web 与 server 都从这里读。

/** 可下钻寻址的嵌套块类型（不在顶层也有 id） */
const NESTED_ADDRESSABLE: ReadonlySet<string> = new Set(['list_item'])

/** 直接子块都可寻址的容器块（agent_reply 里的段落 / 标题 / 代码块各自是块，分栏的每一栏同理） */
const ADDRESSABLE_CONTAINERS: ReadonlySet<string> = new Set(['agent_reply', 'column'])

/** `name` 类型的块挂在 `parent` 类型的块下时是否可寻址；`parent` 为 null = 文档正文本身（顶层） */
export function isAddressable(name: string, parent: string | null): boolean {
  return parent === null || NESTED_ADDRESSABLE.has(name) || ADDRESSABLE_CONTAINERS.has(parent)
}
