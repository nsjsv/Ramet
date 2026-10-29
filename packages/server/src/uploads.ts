// ---------- 上传文件落盘目录 ----------
// UPLOAD_DIR ?? ./uploads（相对 server 工作目录）。惰性解析：测试进程里环境变量在模块加载之后才就位，模块级常量会焊死默认路径。
// 单独成模块：page-read.ts（AI 取图）和 routes/files.ts 都要用，而 routes/files.ts 连着 sharp，
// connector 所在机器只跑 agent 中继，不该被拖去装 sharp。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function uploadDir(): string {
  const dir = process.env.UPLOAD_DIR ?? './uploads'
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 文件在盘上的三种形态：orig 原文件、display（图片的 1600 webp）、icon（160 方图，惰性生成） */
export type FileVariant = 'orig' | 'display' | 'icon'

export function variantPath(id: string, variant: FileVariant): string {
  return join(uploadDir(), variant === 'orig' ? id : variant === 'display' ? `${id}.webp` : `${id}.icon.webp`)
}
