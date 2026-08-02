# Changelog

All notable changes to `@perfonext/profiler-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
