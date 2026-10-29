import { describe, expect, test } from 'vitest'
import { diffStat, parseDiff } from './diff-parse'

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function main() {
 const a = 1
-const b = 2
+const b = 3
 const c = 4
 const d = 5
@@ -20,2 +20,3 @@
 tail
+added
 end
`

describe('parseDiff', () => {
  test('改动：旧新行号各自递增，hunk 头只留上下文文字，文件头不画', () => {
    const lines = parseDiff(MODIFIED)
    expect(lines[0]).toEqual({ kind: 'hunk', text: 'function main() {' })
    expect(lines.slice(1, 6)).toEqual([
      { kind: 'ctx', text: 'const a = 1', old: 1, new: 1 },
      { kind: 'del', text: 'const b = 2', old: 2 },
      { kind: 'add', text: 'const b = 3', new: 2 },
      { kind: 'ctx', text: 'const c = 4', old: 3, new: 3 },
      { kind: 'ctx', text: 'const d = 5', old: 4, new: 4 },
    ])
    // 第二个 hunk 重置行号
    expect(lines[6]).toEqual({ kind: 'hunk', text: '' })
    expect(lines[7]).toEqual({ kind: 'ctx', text: 'tail', old: 20, new: 20 })
    expect(lines[8]).toEqual({ kind: 'add', text: 'added', new: 21 })
    expect(lines[9]).toEqual({ kind: 'ctx', text: 'end', old: 21, new: 22 })
    expect(lines).toHaveLength(10)
    expect(diffStat(lines)).toEqual({ add: 2, del: 1 })
  })

  test('新文件 / 删除 / 二进制 / 没有末尾换行：文件级说明变成 note', () => {
    const created = parseDiff('diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n')
    expect(created).toEqual([
      { kind: 'note', text: '新文件' },
      { kind: 'hunk', text: '' },
      { kind: 'add', text: 'one', new: 1 },
      { kind: 'add', text: 'two', new: 2 },
      { kind: 'note', text: '文件末尾没有换行' },
    ])
    expect(parseDiff('diff --git a/x b/x\ndeleted file mode 100644\n')).toEqual([{ kind: 'note', text: '已删除的文件' }])
    expect(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n')).toEqual([
      { kind: 'note', text: '二进制文件有改动，不显示内容' },
    ])
  })

  test('内容里恰好以 +++ / --- 开头的行是正文，不是文件头', () => {
    const lines = parseDiff('@@ -1,1 +1,1 @@\n---- removed\n++++ added\n')
    expect(lines.slice(1)).toEqual([
      { kind: 'del', text: '--- removed', old: 1 },
      { kind: 'add', text: '+++ added', new: 1 },
    ])
  })

  test('空输入 = 没有行；多个文件拼在一起各自重置状态', () => {
    expect(parseDiff('')).toEqual([])
    const two = parseDiff(`${MODIFIED}diff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+x\n`)
    expect(two.at(-3)).toEqual({ kind: 'note', text: '新文件' })
    expect(two.at(-1)).toEqual({ kind: 'add', text: 'x', new: 1 })
  })
})
