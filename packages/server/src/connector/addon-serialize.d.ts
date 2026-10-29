// @xterm/addon-serialize 的类型（只声明 connector/pty-screen.ts 用到的那一点）。pty-screen.ts 刻意直接导入包里的 JS 文件
// `@xterm/addon-serialize/lib/addon-serialize.js`：那个路径旁边没有官方类型声明，TypeScript 就用这里的环境模块声明。
// 为什么不用官方声明：它 import 了 @xterm/xterm，而 @xterm/xterm 的声明带着 `/// <reference lib="dom"/>`，一旦进了 server 的编译，
// DOM 的全局类型会盖掉 Node 的 Headers 等（endpoint-guard.ts 当场编译不过）。
// 为什么不用 tsconfig 的 paths 把类型指过来：tsx 运行时也读 paths，会把这份 .d.ts 当模块执行
// （开发 / 测试里 `node --import tsx connector/cli.ts` 一启动就 `serialize is not defined`）。
// 包是 CommonJS（没有 exports 字段，深路径可以直接导入），ESM 里默认导入拿到的是 module.exports。
declare module '@xterm/addon-serialize/lib/addon-serialize.js' {
  const serialize: {
    SerializeAddon: new () => {
      activate(terminal: unknown): void
      dispose(): void
      serialize(options?: { scrollback?: number; excludeModes?: boolean; excludeAltBuffer?: boolean }): string
    }
  }
  export default serialize
}
