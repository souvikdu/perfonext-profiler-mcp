# perfonext-profiler-mcp

[![npm](https://img.shields.io/npm/v/@perfonext/profiler-mcp)](https://www.npmjs.com/package/@perfonext/profiler-mcp)

`perfonext-profiler-mcp` is an MCP server for loading and analyzing V8 and Chrome CPU profiles. It gives GitHub Copilot and other MCP clients structured performance data they can reason over instead of forcing the model to ingest multi-megabyte profile dumps.

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

| Tool | Description |
|------|-------------|
| `how_to_collect` | Return a ready-to-run command and step-by-step recipe for capturing a `.cpuprofile`, then loading it. Use this when you don't have a profile yet |
| `load_profile` | Parse and load a `.cpuprofile` file or Chrome trace export from disk |
| `get_hotspots` | Find top functions by self-time. Each entry includes a `package` field identifying the npm package or `(user code)` |
| `explain_function` | Explain a function's timing, callers, and callees. Pass `includeSource: true` to attach annotated source lines |
| `read_source_context` | Read the actual source file for a hot function and annotate each line with tick counts from `positionTicks` |
| `get_package_costs` | Aggregate CPU self-time by npm package — shows which dependencies are most expensive |
| `compare_profiles` | Compare two profiles and highlight regressions |
| `suggest_optimizations` | Generate structured, multi-pattern optimization suggestions for hot functions. Detects high fan-in, recursion, dominant callers, and V8-specific patterns. Deduplicates functions split across multiple call sites |
| `get_profile_summary` | Summarize one profile or list all loaded profiles |

Every tool result carries a `nextStep` breadcrumb pointing at the natural follow-up call, so an MCP client can walk the collect → analyze → fix loop without guessing.

### `how_to_collect` details

```jsonc
// Input
{ "scenario": "next-server" } // or "script"; defaults to "next-server"

// Output
{
  "scenario": "next-server",
  "summary": "Profile a production Next.js server while it handles a single request. ...",
  "command": "NODE_OPTIONS='--cpu-prof --cpu-prof-dir=./.perf-profiles' next start",
  "steps": [ "...", "load_profile({ filePath: \"./.perf-profiles/<file>.cpuprofile\" })" ],
  "outputDir": "./.perf-profiles",
  "nextStep": "After stopping the server, call load_profile with the .cpuprofile ..."
}
```

`next-server` profiles a production Next.js server while it serves a single request; `script` profiles a standalone Node.js script. Node writes one `.cpuprofile` per process/worker thread into the output directory. The `command` uses bash/zsh env-var syntax (`NODE_OPTIONS='...' next start`); on Windows PowerShell, set `$env:NODE_OPTIONS` first.

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

| Pattern | Trigger |
|---|---|
| `gc-pressure` | Function name matches GC/Scavenge/MarkCompact |
| `json-serialization` | `JSON.parse` / `JSON.stringify` |
| `regex-cost` | RegExp / `exec` / `test` calls |
| `v8-deopt` | Compile / Recompile / Optimize / Deoptimize |
| `high-fan-in` | ≥ 3 distinct parent call sites |
| `recursion` | Function appears in its own descendant sub-tree |
| `hot-caller` | One caller accounts for ≥ 80% of call-site occurrences |
| `cpu-bound` | Fallback when no other pattern matches |

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

## Install

Run directly with `npx`:

```bash
npx -y @perfonext/profiler-mcp
```

Or install globally:

```bash
npm install -g @perfonext/profiler-mcp
```

The executable command remains `perfonext-profiler-mcp` after installation.

## MCP Configuration

Add this server to VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "perfonext-profiler": {
        "command": "npx",
        "args": ["-y", "@perfonext/profiler-mcp"]
      }
    }
  }
}
```

## Example Copilot Prompts

- "How do I capture a CPU profile of my Next.js server?"
- "Load the CPU profile at `./profile.cpuprofile` and show me the top hotspots."
- "Which npm packages are consuming the most CPU in this profile?"
- "Explain why `processData` is expensive in the loaded profile."
- "Show me the actual source lines for `processData` and mark which lines are hottest."
- "Explain `transformResult` and include the annotated source code."
- "Compare my baseline and current CPU profiles and tell me what got slower."
- "Suggest optimizations for the top three hotspots."

## Development

```bash
npm install
npm run build
npm test
```

The repository already includes sample fixtures under `tests/fixtures/` for local validation.

## Generating a CPU Profile

Ask Copilot to call `how_to_collect` for a ready-to-run recipe, or generate one manually:

Next.js production server (profile a single request):

```bash
NODE_OPTIONS='--cpu-prof --cpu-prof-dir=./.perf-profiles' next start
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

## License

MIT
