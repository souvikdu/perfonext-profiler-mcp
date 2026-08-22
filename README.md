# perfonext-profiler-mcp

> Analyze V8 and Chrome CPU profiles to find hotspots in Next.js servers and scripts.

[![npm](https://img.shields.io/npm/v/@perfonext/profiler-mcp)](https://www.npmjs.com/package/@perfonext/profiler-mcp)
[![npm downloads](https://img.shields.io/npm/dt/@perfonext/profiler-mcp)](https://www.npmjs.com/package/@perfonext/profiler-mcp)
[![license](https://img.shields.io/npm/l/@perfonext/profiler-mcp)](https://www.npmjs.com/package/@perfonext/profiler-mcp)

`perfonext-profiler-mcp` is a Model Context Protocol (MCP) server that gives GitHub Copilot, Claude Desktop,
Claude Code, and other MCP clients structured CPU profiling data for Next.js performance work. It loads V8 and
Chrome CPU profiles and turns them into hotspot rankings, per-package costs, and source-annotated hot lines —
evidence agents can reason over instead of ingesting multi-megabyte profile dumps.

## Quick Start

Run directly with `npx`:

```bash
npx -y @perfonext/profiler-mcp
```

Or install globally:

```bash
npm install -g @perfonext/profiler-mcp
```

The executable command remains `perfonext-profiler-mcp` after installation.

Add the server to VS Code in `.vscode/mcp.json` (the workspace MCP configuration file):

```json
{
  "servers": {
    "perfonext-profiler": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@perfonext/profiler-mcp"]
    }
  }
}
```

Then reload the VS Code window and run **MCP: List Servers** to start it, or accept the trust prompt when it appears. For a locally-built checkout, point `command`/`args` at `node` and the repo's `dist/index.js` instead.

If the server fails with `spawn npx ENOENT` (or `spawn node ENOENT`), VS Code was likely launched from the Dock/Finder and cannot see nvm. GUI apps do not load shell config, so `npx` is not on `PATH`. Fix it by giving the MCP config an absolute `npx` path and a `PATH` that includes the same Node bin directory (`dirname $(which npx)`):

```json
{
  "servers": {
    "perfonext-profiler": {
      "type": "stdio",
      "command": "/Users/YOU/.nvm/versions/node/v20.10.0/bin/npx",
      "args": ["-y", "@perfonext/profiler-mcp"],
      "env": {
        "PATH": "/Users/YOU/.nvm/versions/node/v20.10.0/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Alternatively, start VS Code from a terminal that already has nvm loaded (`code .`) so it inherits `PATH`.

Then ask Copilot: _"How do I capture a CPU profile of my Next.js server?"_

## What It Does

- loads `.cpuprofile` files and Chrome trace exports that contain CPU profile data
- identifies the hottest functions by self time, annotated with the originating npm package
- explains caller and callee relationships for a selected function
- **reads actual source code for hot functions and annotates each line with V8 sample counts** (v0.2.0)
- **aggregates CPU self-time per npm package to find expensive third-party dependencies** (v0.3.0)
- compares two profiles to surface regressions and improvements
- returns deterministic optimization suggestions for common hotspots
- summarizes loaded profiles so an MCP client can keep context tight

## Tools

| Tool                    | Description                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `how_to_collect`        | Return a ready-to-run command and step-by-step recipe for capturing a `.cpuprofile`, then loading it. Use this when you don't have a profile yet                                                                   |
| `load_profile`          | Parse and load a `.cpuprofile` file or Chrome trace export from disk                                                                                                                                               |
| `get_hotspots`          | Find top functions by self-time. Each entry includes a `package` field identifying the npm package or `(user code)`                                                                                                |
| `explain_function`      | Explain a function's timing, callers, and callees. Pass `includeSource: true` to attach annotated source lines                                                                                                     |
| `read_source_context`   | Read the actual source file for a hot function and annotate each line with tick counts from `positionTicks`                                                                                                        |
| `get_package_costs`     | Aggregate CPU self-time by npm package — shows which dependencies are most expensive                                                                                                                               |
| `compare_profiles`      | Compare two profiles and highlight regressions                                                                                                                                                                     |
| `suggest_optimizations` | Generate structured, multi-pattern optimization suggestions for hot functions. Detects high fan-in, recursion, dominant callers, and V8-specific patterns. Deduplicates functions split across multiple call sites |
| `get_profile_summary`   | Summarize one profile or list all loaded profiles                                                                                                                                                                  |

Every tool result carries a `nextStep` breadcrumb pointing at the natural follow-up call, so an MCP client can walk the collect → analyze → fix loop without guessing.

## Example Copilot Prompts

- "How do I capture a CPU profile of my Next.js server?"
- "Load the CPU profile at `./profile.cpuprofile` and show me the top hotspots."
- "Which npm packages are consuming the most CPU in this profile?"
- "Explain why `processData` is expensive in the loaded profile."
- "Show me the actual source lines for `processData` and mark which lines are hottest."
- "Explain `transformResult` and include the annotated source code."
- "Compare my baseline and current CPU profiles and tell me what got slower."
- "Suggest optimizations for the top three hotspots."

## Deep Tool Reference

<details>
<summary>Per-tool input/output schemas and manual profile capture</summary>

### `how_to_collect` details

```jsonc
// Input
{ "scenario": "next-server" } // or "script"; defaults to "next-server"

// Output
{
  "scenario": "next-server",
  "summary": "Profile a production Next.js server while it handles a single request. ...",
  "command": "node --cpu-prof --cpu-prof-dir=./.perf-profiles ./node_modules/next/dist/bin/next start",
  "steps": [ "...", "load_profile({ filePath: \"./.perf-profiles/<file>.cpuprofile\" })" ],
  "outputDir": "./.perf-profiles",
  "nextStep": "After stopping the server, call load_profile with the .cpuprofile ..."
}
```

`next-server` profiles a production Next.js server while it serves a single request; `script` profiles a standalone Node.js script. Node writes one `.cpuprofile` per process/worker thread into the output directory. The Next server command uses Node CLI flags (not `NODE_OPTIONS`) so it is the same on Unix and Windows.

### `read_source_context` details

```jsonc
// Input
{ "profileId": "<id>", "functionName": "myFn", "contextLines": 10 }

// Output (per line)
{
  "lineNumber": 42,
  "content": "  for (let i = 0; i < items.length; i++) {",
  "ticks": 18,      // V8 samples that landed on this line
  "isHot": true     // true when ticks >= 50% of peak ticks for this function
}
```

The returned window is sized to cover the function's actual hot lines, not just a fixed radius
around its declaration — a function's real bottleneck is often well past its `function` line.
`contextLines` (default 10) sets the minimum padding around both the declaration and the hot
lines; if any ticks still fall outside the returned window, the top-level result includes
`hiddenTicks` (a count) and a `warning` telling you to retry with a larger `contextLines`.
`explain_function` also accepts `contextLines` when called with `includeSource: true`.

Only files inside the current working directory can be read. `file://` URLs and absolute paths are both handled; `http://`, `node:` builtins, and paths outside the project root are rejected.

### `suggest_optimizations` details

```jsonc
// Input
{ "profileId": "<id>", "limit": 5 }

// Output (per function)
{
  "function": "processData",
  "file": "file:///app/src/processor.js",
  "line": 10,
  "selfPercent": "18.2%",
  "patterns": [
    {
      "pattern": "high-fan-in",
      "detail": "Called from 6 distinct call sites (e.g. renderRow, buildTree, …)",
      "suggestion": "This function is a shared hot path. Ensure it is well-optimised and monomorphic …"
    },
    {
      "pattern": "hot-caller",
      "detail": "84% of calls come from \"renderRow\"",
      "suggestion": "Focus optimisation effort on \"renderRow\" rather than this function …"
    }
  ],
  "topSuggestion": "This function is a shared hot path …"
}
```

Patterns detected (multiple can fire for the same function):

| Pattern              | Trigger                                                |
| -------------------- | ------------------------------------------------------ |
| `gc-pressure`        | Function name matches GC/Scavenge/MarkCompact          |
| `json-serialization` | `JSON.parse` / `JSON.stringify`                        |
| `regex-cost`         | RegExp / `exec` / `test` calls                         |
| `v8-deopt`           | Compile / Recompile / Optimize / Deoptimize            |
| `high-fan-in`        | ≥ 3 distinct parent call sites                         |
| `recursion`          | Function appears in its own descendant sub-tree        |
| `hot-caller`         | One caller accounts for ≥ 80% of call-site occurrences |
| `cpu-bound`          | Fallback when no other pattern matches                 |

Functions that appear at multiple call sites are automatically merged before ranking so the same logical function is only reported once.

### `get_package_costs` details

```jsonc
// Input
{ "profileId": "<id>", "limit": 10 }

// Output (per package)
{
  "rank": 1,
  "package": "lodash",
  "selfTime": "42.3ms",
  "selfPercent": "14.1%",
  "totalTime": "58.0ms",
  "totalPercent": "19.3%",
  "topFunctions": [
    { "function": "chunk", "selfTime": "28.0ms", "selfPercent": "9.3%" }
  ]
}
```

Scoped packages (`@babel/core`, `@next/env`, etc.) are handled correctly. User code and native builtins (no `node_modules` in the path) are excluded.

### Generating a CPU Profile

Ask Copilot to call `how_to_collect` for a ready-to-run recipe, or generate one manually:

Next.js production server (profile a single request):

```bash
node --cpu-prof --cpu-prof-dir=./.perf-profiles ./node_modules/next/dist/bin/next start
# hit the route once, then Ctrl-C to flush the profile
```

Standalone Node.js script:

```bash
node --cpu-prof --cpu-prof-dir=./.perf-profiles your-script.js
```

Chrome DevTools:

1. Open DevTools and go to the Performance tab.
2. Record the scenario you want to inspect.
3. Stop recording and save the result as a `.cpuprofile` export.

</details>

## Related Perfonext Tools

- [perfonext-render-mcp](https://github.com/souvikdu/perfonext-render-mcp) — React render analysis for Next.js apps
- [perfonext-build-mcp](https://github.com/souvikdu/perfonext-build-mcp) — Next.js bundle/build analysis

## Development

```bash
npm install
npm run build
npm test
```

The repository already includes sample fixtures under `tests/fixtures/` for local validation.

## License

MIT
