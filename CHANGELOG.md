# Changelog

All notable changes to `@perfonext/profiler-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.3] - 2026-08-29

### Fixed

- Empty or zero-sample CPU profiles now produce an empty call tree and zero-valued summary percentages instead of crashing or returning `NaN` values.

## [0.6.2] - 2026-08-27

### Changed

- README setup instructions now cover VS Code, Claude Desktop, Claude Code, and other MCP-compatible clients, with macOS and nvm troubleshooting for missing `npx` or `node` paths.

## [0.6.1] - 2026-08-23

### Fixed

- **`read_source_context` now resolves Windows `file://` URLs and CRLF sources correctly.** The previous helper stripped the `file://` prefix by hand, so V8 frames like `file:///C:/Users/...` became `/C:/Users/...` and failed to open. Sandbox checks now use `path.relative` (and `realpath` when the file exists) instead of a string prefix. Source files are split on LF, CRLF, or CR so Windows line endings no longer leave a trailing `\r` on every line. Profile `callFrame.url` values are canonicalized to POSIX `file://` at ingest.
- **`how_to_collect` next-server recipe is no longer bash-only.** It now starts Next via `node --cpu-prof --cpu-prof-dir=./.perf-profiles ./node_modules/next/dist/bin/next start` instead of `NODE_OPTIONS='...' next start`.

### Changed

- Pull-request CI now also runs on `windows-latest`, still on Node 22 (same as `.nvmrc` and publish).

## [0.6.0] - 2026-08-09

### Fixed

- **`suggest_optimizations` no longer reports false `recursion` on non-recursive functions.** Detection previously searched a function's _entire descendant subtree_ for a matching **function name**, so it fired on any function that reappeared anywhere deeper in the call tree — including a shared utility reached through an unrelated branch, or a same-named function in a different module. It also treated any structural cycle as recursion, and V8 routinely records sub-millisecond self-edges for inlined or mis-attributed samples. On a real profile this labelled the two hottest functions (a plain `haversine` distance calculation and its O(n²) caller) as recursive on the strength of a 0.3ms edge against 1081ms of work, and recommended "convert tail recursion to iteration" — the wrong fix for the actual bottleneck. Recursion now requires the function to re-enter itself along a single **root-to-leaf path**, is keyed on `functionName + url + lineNumber` rather than name alone, and requires the recursive frames to carry at least **5% of the function's CPU self-time**. The `detail` field now reports the measured recursion depth and self-time share so the finding can be weighed rather than taken on faith.
- **`cpu-bound` is no longer suppressed by a lower-confidence pattern.** It was emitted only as a fallback when _nothing else_ matched, so a function burning 29% of CPU self-time could report an advisory `hot-caller` ("optimise the caller instead") and never state its own cost, while a 6% function reported it. CPU-cost evidence is now always emitted for functions at or above 5% self-time, in addition to whatever else matched. `patterns` is also ordered by confidence — direct evidence (`gc-pressure`, `v8-deopt`, `json-serialization`, `regex-cost`, gated `recursion`) first, then `cpu-bound`, then advisory patterns (`high-fan-in`, `hot-caller`, `orchestrator`) — so `topSuggestion` can no longer be an advisory pattern on an expensive function.
- **`read_source_context` / `explain_function(includeSource: true)`** no longer report a misleading window. Previously the shown source lines were a fixed +/-10 (default `contextLines`) radius around the function's _declaration_ line, so a function whose real hot lines were farther down (a common shape) could report a large `totalTicks` while every visible line showed 0-1 ticks, with no indication anything was hidden. The window is now sized from the function's actual tick extent (scoped to its own file, so a same-named function elsewhere can no longer pollute the totals), capped at 200 lines. The result now also reports `visibleTicks` and `hiddenTicks`, plus a `warning` whenever ticks still fall outside the returned window. **Behavior change:** `startLine`/`endLine` (and therefore `lines`) for the same call can now differ from v0.5.1.
- `explain_function` now accepts an optional `contextLines` parameter for `includeSource: true` instead of hardcoding it to `10`.
- `load_profile` no longer lets raw filesystem/JSON errors reach the caller. Missing files, a directory path, and malformed JSON now return a clear, actionable `isError` message instead of a raw `ENOENT`/`EISDIR`/`SyntaxError`. Pointing `load_profile` at a directory is still rejected — by design, it only ever accepts a single profile file — but the message now says so plainly instead of surfacing `EISDIR: illegal operation on a directory, read`.
- Fixed a crash (`TypeError: Cannot read properties of undefined (reading 'selfTime')`) when a profile's call-tree references a child node id that isn't present in `nodes` (e.g. a profile with zero samples). `load_profile` now loads such profiles successfully, reporting `sampleCount: 0`.
- Added a clear error for a profile with an empty `nodes` array, instead of an unhandled exception.

### Changed

- Publish workflow migrated to npm trusted publishing (OIDC): `npm publish --provenance` with `id-token: write`, removing the long-lived `NPM_TOKEN` bypass-2FA granular access token. The workflow also upgrades npm to latest before `npm ci`/`npm publish` — npm 10.x (bundled with Node 22) can sign provenance via sigstore but cannot perform the OIDC exchange to authenticate to the registry, so publishes ran anonymously and the registry returned a misleading 404.
- `detectRecursion` is now called with a `FunctionIdentity` (`{ functionName, url, lineNumber }`) instead of a bare function name. This is an internal export, not part of the MCP tool surface.

### Added

- Test coverage for the `load_profile` tool wrapper (`tests/load-profile.test.ts`) — previously only parser functions had tests, which is why the source-window bug went unnoticed.
- Regression tests reproducing the exact failure shape from `REVIEW.md` H1 (hot lines far past the function declaration) and the window-cap/`hiddenTicks` reporting path.
- Regression tests for the recursion false positives (negligible self-edge, same name in another file, shared utility in a sibling branch) and for `cpu-bound` surviving alongside an advisory pattern.

## [0.5.1] - 2026-08-02

### Added

- ESLint 9 flat config and Prettier tooling, with `lint`, `lint:fix`, `format`, and `format:check` npm scripts.
- Lint and format checks wired into the pull-request CI workflow.
- Pull request, release, bug report, and feature request templates, plus Dependabot config and release-note categories.
- `.nvmrc` pinning the Node version for contributors.

### Changed

- README rewritten: installation, quick start, VS Code MCP setup, tool reference, and troubleshooting.
- Source and test files reformatted with Prettier (no functional changes).
- Build script now runs `shx chmod +x dist/index.js` so `npm run build` works on Windows as well as Unix.

### Fixed

- Removed unused imports and other ESLint-reported issues in parsers and tools.
- Added the missing trailing newline to the publish workflow.

## [0.5.0] - 2026-08-02

### Added

- `how_to_collect` tool — generates ready-to-run CPU profiling commands for Next.js production servers and standalone Node.js scripts when no profile exists yet.
- `nextStep` workflow breadcrumbs on profiler tools, guiding MCP clients through the collect → load → inspect → explain → optimize flow.

### Changed

- Upgraded MCP Inspector integration from the deprecated v1 to v2 (requires Node.js >= 22.19.0). The inspector script now uses the locally installed `mcp-inspector` executable instead of an implicit `npx` download.

## [0.4.0] - 2026-05-30

### Added

- Multi-pattern analysis in `suggest_optimizations` — returns a `patterns[]` array instead of a single issue/suggestion pair; multiple patterns can fire per function.
- New detection patterns: `high-fan-in` (≥3 call sites), `recursion` (direct/indirect), and `hot-caller` (single caller ≥80% of invocations).
- Profile-aware GC suggestions — `gc-pressure` now lists top user-code functions by total time as likely allocation sources instead of a generic tip.
- Deduplication of functions appearing at multiple call sites before ranking.

### Fixed

- `orchestrator` pattern restored for low-self-time wrapper/benchmark frames (regression introduced in v0.3.0).
- GC detection now correctly matches the `(garbage collector)` entry emitted by modern V8 builds, not just `Scavenge`/`MarkCompact` variants.

## [0.3.0] - 2026-05-30

### Added

- `get_package_costs` tool — aggregates CPU self-time per npm dependency, with top 3 hottest functions per package.
- `package` field added to every `get_hotspots` entry (npm package name or `(user code)`).
- `npm run inspector` script for reliably launching MCP Inspector.

### Changed

- Build script now runs `chmod +x dist/index.js` automatically, removing the need for manual permission fixes.

## [0.2.0] - 2026-05-29

### Added

- Source-code-aware analysis: `read_source_context` and `explain_function` (with `includeSource: true`) now annotate each source line with V8 tick counts.

## [0.1.0] - 2026-05-29

### Added

- Initial release of `@perfonext/profiler-mcp`.
- Loads and analyzes V8 and Chrome CPU profiles.
- MCP server support for GitHub Copilot and other MCP clients.
- Core tools: `load_profile`, `get_hotspots`, `explain_function`, `compare_profiles`, `suggest_optimizations`, `get_profile_summary`.
