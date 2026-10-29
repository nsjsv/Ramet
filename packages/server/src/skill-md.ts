// ---------- SKILL.md：Agent Skills 开放标准的 frontmatter 解析 / 校验 / 输出 ----------
// 规则（agentskills.io）：frontmatter 里 name 必填、≤64 字、小写字母数字与连字符、不以连字符开头结尾、不连续连字符；
// description 必填、1–1024 字；可选 license / compatibility（≤500）/ metadata（键值表）/ allowed-tools。
// 不依赖 YAML 库：只解析这份标准实际用到的子集（标量、引号串、`|` / `>` 块标量、一层嵌套表、`- ` 列表）；
// 认不出的写法明确报「无法解析」，不猜。

export class SkillError extends Error {}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 一个标量值：双引号串按 JSON 读、单引号串去引号、`{…}` / `[…]` 按 JSON 流式写法读（emitSkillMd 输出的形状），其余原样 */
function scalar(raw: string): unknown {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v) as unknown
    } catch {
      return v
    }
  }
  return v
}

const unquote = (raw: string): string => String(scalar(raw))

/** 缩进深度 */
const depth = (line: string): number => line.length - line.trimStart().length

export function parseYamlSubset(src: string): Record<string, unknown> {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: Record<string, unknown> = {}
  let i = 0
  const fail = (line: string): never => {
    throw new SkillError(`frontmatter 无法解析：${line.trim().slice(0, 60)}`)
  }
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    if (depth(line) !== 0) fail(line)
    const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line)
    if (!m) return fail(line)
    const key = m[1]!
    const rest = (m[2] ?? '').trim()
    i++
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const block: string[] = []
      while (i < lines.length && (!lines[i]!.trim() || depth(lines[i]!) > 0)) block.push(lines[i++]!)
      const pad = Math.min(...block.filter((l) => l.trim()).map(depth), Infinity)
      const body = block.map((l) => (l.trim() ? l.slice(pad === Infinity ? 0 : pad) : ''))
      while (body.length && !body[body.length - 1]) body.pop()
      out[key] = rest.startsWith('|')
        ? body.join('\n')
        : body.reduce((acc, l) => (l ? `${acc && !acc.endsWith('\n') ? `${acc} ` : acc}${l}` : `${acc}\n`), '').trim()
    } else if (rest === '') {
      const nested: string[] = []
      while (i < lines.length && (!lines[i]!.trim() || depth(lines[i]!) > 0)) nested.push(lines[i++]!)
      const real = nested.filter((l) => l.trim() && !l.trimStart().startsWith('#'))
      if (real.every((l) => l.trimStart().startsWith('- '))) out[key] = real.map((l) => unquote(l.trimStart().slice(2)))
      else {
        const map: Record<string, string> = {}
        for (const l of real) {
          const kv = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(l)
          if (!kv) return fail(l)
          map[kv[1]!] = unquote(kv[2]!)
        }
        out[key] = map
      }
    } else out[key] = scalar(rest)
  }
  return out
}

/** SKILL.md 全文 → frontmatter 键值 + 正文（markdown） */
export function parseSkillMd(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) throw new SkillError('SKILL.md 必须以 `---` 包起来的 frontmatter 开头')
  return { meta: parseYamlSubset(m[1]!), body: m[2]!.replace(/^\r?\n/, '') }
}

export type SkillMeta = { name: string; description: string; extra: Record<string, unknown> }

/** 校验 frontmatter（name / description 规则）；其余键原样进 extra */
export function validateSkill(meta: Record<string, unknown>): SkillMeta {
  const { name, description, ...extra } = meta
  if (typeof name !== 'string' || !name) throw new SkillError('frontmatter 缺少 name')
  if (name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillError('name 只能是小写字母、数字和连字符（不以连字符开头 / 结尾、不连续），且不超过 64 个字符')
  }
  if (typeof description !== 'string' || !description.trim()) throw new SkillError('frontmatter 缺少 description')
  if (description.length > 1024) throw new SkillError('description 不能超过 1024 个字符')
  const compat = extra.compatibility
  if (compat !== undefined && (typeof compat !== 'string' || compat.length > 500)) {
    throw new SkillError('compatibility 必须是不超过 500 字符的字符串')
  }
  return { name, description: description.trim(), extra }
}

/** 输出 SKILL.md：值一律用 JSON 写（JSON 是合法的 YAML 流式写法，引号 / 冒号 / 换行都安全） */
export function emitSkillMd(skill: SkillMeta, body: string): string {
  const lines = ['---', `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`]
  for (const [k, v] of Object.entries(skill.extra)) lines.push(`${k}: ${JSON.stringify(v)}`)
  lines.push('---', '', body)
  return lines.join('\n')
}
