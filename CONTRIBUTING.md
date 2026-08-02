# Contributing to @perfonext/profiler-mcp

Thanks for contributing! This project is a local MCP server that analyzes V8 / Chrome CPU
profiles so GitHub Copilot and other MCP clients can turn raw profile dumps into actionable
evidence.

## Prerequisites

- Node.js 22.x — pinned in `.nvmrc` (`nvm use` or `fnm use` picks it up)
- npm

## Setup

```sh
npm install
npm run build
```

`npm run build` compiles TypeScript and makes `dist/index.js` executable (via `shx`, so it
works on Windows too). The MCP entry point is `dist/index.js`.

## Development loop

| Command                           | What it does                            |
| --------------------------------- | --------------------------------------- |
| `npm run dev`                     | `tsc --watch`                           |
| `npm test`                        | run the Vitest suite                    |
| `npm run lint` / `lint:fix`       | ESLint 9 (flat config)                  |
| `npm run format` / `format:check` | Prettier (config in `.prettierrc.json`) |

The pull-request CI runs lint, format check, build, and tests — make sure all four pass
locally before pushing.

## Project layout

```
src/
  index.ts          server bootstrap + tool registration
  tools/            one file per MCP tool
  parser/           profile parsing and analysis (cpuprofile, call-tree, trace)
  store.ts          in-memory profile store
  format.ts         shared formatting helpers
tests/
  *.test.ts         Vitest suites
  fixtures/         sample .cpuprofile / trace fixtures
  helpers/          tool-stub for testing tool handlers
```

## Making a change

1. Branch from `main`: `git checkout -b <scope>/<short-description>`.
2. Follow the commit style already in the history: `feat:`, `fix:`, `chore:`, `docs:`.
3. Keep the PR scoped to one change — the PR template has a "scoped to one change"
   checklist item.

## Testing an MCP tool

- `npm run inspector` launches MCP Inspector against the built server so you can call the
  tools interactively.
- Or add the server to VS Code (`.vscode/mcp.json`, see the README) and drive it from
  Copilot Chat.

## Pull requests

- Fill out `.github/PULL_REQUEST_TEMPLATE.md`: type of change, what's affected, and how you
  tested it.
- Update `CHANGELOG.md` under `[Unreleased]` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- Update the README if user-facing behavior changed.

## Releasing

Maintainers publish by tagging `vX.Y.Z` on `main` — `.github/workflows/publish.yml` runs
`npm publish`. Release notes are assembled from PR labels via `.github/release.yml`
(`feat` → Features, `fix` → Bug Fixes, `chore` → Maintenance). Bump the version in
`package.json`, `package-lock.json`, and `src/index.ts` (the MCP handshake reports this
version) in the same PR that ships the change.
