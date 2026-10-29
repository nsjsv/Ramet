/* ---------- 代码块语言表（下拉与显示名共用） ----------
 * id 是写进 code_block.language 的值（也是 markdown ```id 的写法），aliases 是常见别名（```js / ```py），
 * 显示名按 id 或别名都能对上。高亮能不能做由 lowlight 自己判定（registered），这张表只管选与显示。
 * 顺序就是下拉里的顺序，常用在前。 */

export type CodeLang = { id: string; label: string; aliases?: string[] }

export const CODE_LANGS: CodeLang[] = [
  { id: '', label: '纯文本', aliases: ['text', 'plaintext', 'txt'] },
  { id: 'mermaid', label: 'Mermaid 图' },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx', 'mts'] },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh', 'console'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc'] },
  { id: 'html', label: 'HTML', aliases: ['xml', 'svg', 'vue'] },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'less', label: 'Less' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'java', label: 'Java' },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'] },
  { id: 'swift', label: 'Swift' },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'hpp'] },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'lua', label: 'Lua' },
  { id: 'r', label: 'R' },
  { id: 'perl', label: 'Perl', aliases: ['pl'] },
  { id: 'objectivec', label: 'Objective-C', aliases: ['objc'] },
  { id: 'graphql', label: 'GraphQL', aliases: ['gql'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'ini', label: 'INI / TOML', aliases: ['toml'] },
  { id: 'makefile', label: 'Makefile', aliases: ['make', 'mk'] },
  { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'] },
  { id: 'vbnet', label: 'VB.NET', aliases: ['vb'] },
  { id: 'wasm', label: 'WebAssembly' },
]

const byKey = new Map<string, CodeLang>()
for (const lang of CODE_LANGS) {
  byKey.set(lang.id, lang)
  for (const alias of lang.aliases ?? []) byKey.set(alias, lang)
}

/** language 值对应的表里的语言（大小写不敏感），不认识返回 null */
export function findLang(language: string): CodeLang | null {
  return byKey.get(language.trim().toLowerCase()) ?? null
}

/** 顶栏显示名：认识的给显示名，不认识的原样显示，空是纯文本 */
export function langLabel(language: string): string {
  const lang = findLang(language)
  return lang ? lang.label : language.trim() || '纯文本'
}

/** 下拉筛选：显示名 / id / 别名包含查询词 */
export function filterLangs(query: string): CodeLang[] {
  const q = query.trim().toLowerCase()
  if (!q) return CODE_LANGS
  return CODE_LANGS.filter((l) => l.label.toLowerCase().includes(q) || l.id.includes(q) || (l.aliases ?? []).some((a) => a.includes(q)))
}

/** 交给 lowlight 的语言名：表里的规范 id（html 换成 xml），不认识的原样交给 lowlight 自己判 */
export function highlightName(language: string): string {
  const lang = findLang(language)
  if (!lang) return language.trim().toLowerCase()
  return lang.id === 'html' ? 'xml' : lang.id
}
