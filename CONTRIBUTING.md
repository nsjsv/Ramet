# Contributing

## Development setup

You need Node.js 22+ and Docker.

```bash
npm install
docker compose up -d          # Postgres 17, data in ./postgres-data
npm run dev                   # server :3789 + web :5173
```

Open http://localhost:5173 and create the admin account on the setup page.

```bash
docker compose exec postgres createdb -U postgres ramet_test   # once: test database
npm test                       # web unit tests + server integration tests (real Postgres)
npm run build                  # server type check + web build
node scripts/code-lines.mjs    # source files must stay ≤ 800 lines (excluding comments)
```

Vitest does not type-check; run `npm run build` before trusting a green test run.

## Issues and pull requests

AI-generated issues and pull requests are welcome, but **must be labeled**. If an AI wrote your issue or PR (fully or mostly), end its description with a separate line saying so, naming the tool if you can:

```
AI-generated (Claude Code)
```

Unlabeled AI-generated submissions may be closed without review.

## Commit messages

We follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). Commit messages are written in **English only**.

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Header

- **type** (required):

  | type | use for |
  |---|---|
  | `feat` | a new user-facing feature |
  | `fix` | a bug fix |
  | `perf` | a performance improvement |
  | `refactor` | a code change that neither fixes a bug nor adds a feature |
  | `docs` | documentation only |
  | `style` | formatting, whitespace; no behavior change |
  | `test` | adding or fixing tests |
  | `build` | build system, Dockerfile, dependencies |
  | `ci` | CI configuration |
  | `chore` | maintenance that fits nothing above |
  | `revert` | reverting a previous commit |

- **scope** (optional): the area touched, lowercase. Common scopes: `server`, `web`, `shared`, `editor`, `collab`, `db`, `auth`, `search`, `history`, `collections`, `export`, `connector`, `agents`, `mcp`, `deps`. Omit it when the change is cross-cutting.
- **subject** (required): imperative mood ("add", not "added" / "adds"), lowercase first letter, no trailing period. Keep the whole header within 72 characters.

### Body

Optional. Separate it from the header with a blank line and wrap at 72 characters. Explain **what** changed and **why**; the diff already shows how. For bug fixes, describe the symptom and the root cause.

### Footer

- Breaking changes: add `!` after the type/scope (`feat(db)!: …`) and a `BREAKING CHANGE: <description>` footer.
- Issue references: `Fixes #123`, `Closes #123`, `Refs #45`.

### Examples

```
feat(collections): add group-by for board view
```

```
fix(editor): stop extra blank line after trailing inline atoms

Paragraphs ending with a page mention or block reference rendered an
empty line below them. The block-level image rule also matched the
placeholder <img> ProseMirror inserts before a trailing atom
(ProseMirror-separator). Exclude that placeholder from the rule.

Fixes #42
```

```
feat(db)!: store uploads under per-space directories

BREAKING CHANGE: existing uploads must be moved with
`node scripts/migrate-uploads.mjs` before starting the new version.
```

### Guidelines

- One logical change per commit; don't mix refactors with behavior changes.
- Don't commit generated files, secrets, or local configuration (`.env`, `agents.json`).
