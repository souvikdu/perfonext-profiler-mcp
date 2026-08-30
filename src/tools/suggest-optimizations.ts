import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';
import { getHotspots, HotspotEntry } from '../parser/call-tree.js';
import { ParsedProfile } from '../parser/types.js';

export interface Suggestion {
  function: string;
  file: string;
  line: number;
  selfPercent: string;
  patterns: PatternMatch[];
  topSuggestion: string;
}

export interface PatternMatch {
  pattern: string;
  detail: string;
  suggestion: string;
}

/**
 * A function call frame. Identity for matching profile nodes is `functionName` + `url` only
 * (see identityKey below). `lineNumber` is carried for display but excluded from the key:
 * `HotspotEntry.lineNumber` is 1-based while raw call frames are 0-based, and detectors need to
 * reach every node of the function regardless of which declaration line the hotspot row carries.
 */
export interface FunctionIdentity {
  functionName: string;
  url: string;
  lineNumber: number;
}

/**
 * Recursive frames must account for at least this share of a function's CPU
 * self-time before recursion is reported. V8 sampling and inlining routinely
 * produce sub-millisecond self-edges in the call tree for non-recursive
 * functions, so a structural cycle alone is not evidence of recursion.
 */
const RECURSION_MIN_SELF_TIME_SHARE = 0.05;

/** V8 bookkeeping frames. They are not call sites, so advice naming them is meaningless. */
const SYNTHETIC_FRAME_NAMES = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

/** Above this self-time share a function always carries explicit CPU-cost evidence. */
const CPU_BOUND_MIN_SELF_PERCENT = 5;

/**
 * Ordering for `topSuggestion`. Patterns backed by direct evidence outrank
 * advisory ones, so a weak `hot-caller` can never displace the CPU-cost finding
 * on an expensive function.
 */
const PATTERN_PRIORITY: Record<string, number> = {
  'gc-pressure': 100,
  'v8-deopt': 90,
  'json-serialization': 80,
  'regex-cost': 80,
  recursion: 70,
  'cpu-bound': 60,
  'high-fan-in': 40,
  'hot-caller': 30,
  orchestrator: 20,
};

function identityKey(frame: FunctionIdentity): string {
  return `${frame.functionName}::${frame.url}`;
}

// ─── Pattern detectors ────────────────────────────────────────────────────────

/**
 * Collect distinct caller identities keyed by functionName::url::lineNumber to
 * avoid inflating fan-in counts when the same logical caller appears as
 * multiple nodes (e.g. after inlining or across aggregation boundaries).
 *
 * Self-edges are skipped: V8 inlining produces `f -> g -> f` for non-recursive
 * code, which otherwise listed a function among its own call sites.
 */
function getUniqueCallerIdentities(
  profile: ParsedProfile,
  functionName: string,
): { keys: Set<string>; namesByKey: Map<string, string> } {
  const keys = new Set<string>();
  const namesByKey = new Map<string, string>();
  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName !== functionName || node.parent === null) continue;
    const parent = profile.nodes.get(node.parent);
    if (!parent) continue;
    const cf = parent.callFrame;
    if (cf.functionName === functionName) continue;
    const key = `${cf.functionName}::${cf.url}::${cf.lineNumber}`;
    keys.add(key);
    namesByKey.set(key, cf.functionName || '(anonymous)');
  }
  return { keys, namesByKey };
}

/**
 * High fan-in: function is called from many distinct callers.
 * Threshold: ≥ 3 distinct caller call frames (identified by functionName + url + line).
 */
export function detectHighFanIn(profile: ParsedProfile, functionName: string): PatternMatch | null {
  const { keys, namesByKey } = getUniqueCallerIdentities(profile, functionName);
  if (keys.size < 3) return null;

  const callerNames = [...new Set(namesByKey.values())].slice(0, 5);

  return {
    pattern: 'high-fan-in',
    detail: `Called from ${keys.size} distinct call sites (e.g. ${callerNames.join(', ')})`,
    suggestion:
      'This function is a shared hot path. Ensure it is well-optimised and monomorphic ' +
      '(consistent argument types). Consider caching results at the call site level or ' +
      'moving shared pre-computation into a single entry point.',
  };
}

/**
 * Recursion: a call-tree node whose immediate parent is the same function, where
 * those frames carry a material share of its CPU self-time.
 *
 * Indirect re-entry (`f -> g -> f`) is not claimed — in sample data it is
 * indistinguishable from V8 inlining a callee into its caller, the shape a plain
 * nested loop produces. This gives up mutual recursion, which sampling cannot
 * prove anyway, to avoid telling a non-recursive function to unroll itself.
 */
export function detectRecursion(
  profile: ParsedProfile,
  target: FunctionIdentity,
): PatternMatch | null {
  const targetKey = identityKey(target);

  let selfTimeTotal = 0;
  let selfTimeRecursive = 0;

  for (const node of profile.nodes.values()) {
    if (identityKey(node.callFrame) !== targetKey) continue;

    selfTimeTotal += node.selfTime;

    const parent = node.parent === null ? undefined : profile.nodes.get(node.parent);
    if (parent && identityKey(parent.callFrame) === targetKey) {
      selfTimeRecursive += node.selfTime;
    }
  }

  if (selfTimeTotal <= 0 || selfTimeRecursive <= 0) return null;

  const share = selfTimeRecursive / selfTimeTotal;
  if (share < RECURSION_MIN_SELF_TIME_SHARE) return null;

  return {
    pattern: 'recursion',
    detail:
      `Calls itself directly; self-recursive frames account for ` +
      `${(share * 100).toFixed(1)}% of its CPU self-time`,
    suggestion:
      'Recursive functions can cause stack pressure and prevent V8 inlining. ' +
      'Consider converting tail recursion to iteration, adding a depth limit, ' +
      'or memoizing sub-problems if inputs repeat.',
  };
}

/**
 * Hot caller: one caller accounts for the dominant share of this function's total hits.
 * Threshold: single caller contributes ≥ 80% of all call-site occurrences.
 * Synthetic V8 frames are skipped — they cannot be made to call anything less often.
 */
export function detectHotCaller(profile: ParsedProfile, functionName: string): PatternMatch | null {
  // Count occurrences per parent function name
  const callerCounts = new Map<string, number>();
  let total = 0;

  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName !== functionName) continue;
    if (node.parent === null) continue;
    const parent = profile.nodes.get(node.parent);
    const callerName = parent?.callFrame.functionName || '(anonymous)';
    if (SYNTHETIC_FRAME_NAMES.has(callerName)) continue;
    callerCounts.set(callerName, (callerCounts.get(callerName) ?? 0) + 1);
    total++;
  }

  if (total === 0) return null;

  for (const [callerName, count] of callerCounts) {
    const pct = (count / total) * 100;
    if (pct >= 80) {
      return {
        pattern: 'hot-caller',
        detail: `${pct.toFixed(0)}% of calls come from "${callerName}"`,
        suggestion:
          `Focus optimisation effort on "${callerName}" rather than this function. ` +
          `Reducing how often "${callerName}" calls this function — via caching, ` +
          `early exit, or batching — will have the most impact.`,
      };
    }
  }
  return null;
}

/**
 * GC pressure: matches all known V8 GC entry-point names and annotates the
 * suggestion with the top user-code functions by total-time as likely
 * allocation sources.
 */
function detectGcPressure(profile: ParsedProfile, functionName: string): PatternMatch | null {
  if (!/\(garbage collector\)|\bGC\b|Scavenge|MarkCompact|IncrementalMark/.test(functionName)) {
    return null;
  }

  // Find top named user-code functions by total-time as likely allocation sources
  const userNodes = [...profile.nodes.values()]
    .filter(
      (n) =>
        n.callFrame.url.startsWith('file://') &&
        !n.callFrame.url.includes('node_modules') &&
        n.callFrame.functionName &&
        !n.callFrame.functionName.startsWith('('),
    )
    .sort((a, b) => b.totalTime - a.totalTime)
    .slice(0, 3);

  const allocatorHints =
    userNodes.length > 0
      ? ` Likely allocation sources by CPU total-time: ${userNodes
          .map((n) => n.callFrame.functionName || '(anonymous)')
          .join(', ')}.`
      : '';

  return {
    pattern: 'gc-pressure',
    detail: 'Garbage collection is consuming significant CPU time',
    suggestion:
      'Reduce short-lived object allocations in hot paths — look for .map(), .filter(), ' +
      '.slice() calls and object literals inside tight loops; replace with in-place mutation ' +
      `or pre-allocated buffers.${allocatorHints}`,
  };
}

/**
 * Orchestrator: the function's own CPU cost is negligible compared to its
 * total-time, meaning almost all work happens in callees.
 */
function detectOrchestrator(hotspot: HotspotEntry): PatternMatch | null {
  if (hotspot.totalPercent === 0) return null;
  if (hotspot.selfPercent >= hotspot.totalPercent * 0.1) return null;
  return {
    pattern: 'orchestrator',
    detail:
      `Self-time is ${hotspot.selfPercent.toFixed(1)}% vs ` +
      `${hotspot.totalPercent.toFixed(1)}% total — most work is in callees`,
    suggestion:
      'Optimise the hottest callees rather than this function itself. ' +
      'Use get_hotspots or explain_function on the children to find the real bottleneck.',
  };
}

/** Name-based patterns that don't need profile context (JSON, RegExp, deopt). */
function detectNamePattern(functionName: string, _hotspot: HotspotEntry): PatternMatch | null {
  if (/^JSON\.(parse|stringify)$/.test(functionName)) {
    return {
      pattern: 'json-serialization',
      detail: 'JSON serialization/deserialization is a bottleneck',
      suggestion:
        'Consider caching parsed results, using streaming parsers for large payloads, ' +
        'or schema-based binary formats (protobuf, msgpack) for high-frequency paths.',
    };
  }

  if (/RegExp|regexp/.test(functionName) || functionName === 'exec' || functionName === 'test') {
    return {
      pattern: 'regex-cost',
      detail: 'Regular expression execution is expensive',
      suggestion:
        'Pre-compile regex outside loops. Replace complex patterns with string operations ' +
        'where possible. Check for catastrophic backtracking with long inputs.',
    };
  }

  if (/Compile|Recompile|Optimize|Deoptimize/.test(functionName)) {
    return {
      pattern: 'v8-deopt',
      detail: 'V8 is spending time compiling or deoptimising this function',
      suggestion:
        'Avoid polymorphic call sites, hidden class changes, and `arguments` object ' +
        'usage in hot functions. Run with --trace-deopt to find specific deopt reasons.',
    };
  }

  return null;
}

/**
 * Deduplicate: merge entries for the same function at the same URL so the same
 * logical function split across multiple call sites is reported once.
 *
 * Key is functionName::url (not just functionName) to avoid conflating unrelated
 * functions that share a name across different files.
 *
 * Percents are recomputed from the merged times to avoid summing ratios, which
 * can produce values > 100%.
 */
export function deduplicateHotspots(
  hotspots: HotspotEntry[],
  totalDuration: number,
): HotspotEntry[] {
  const seen = new Map<string, HotspotEntry>();
  for (const h of hotspots) {
    const key = `${h.functionName}::${h.url}::${h.lineNumber}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...h });
    } else {
      existing.selfTime += h.selfTime;
      existing.totalTime += h.totalTime;
      existing.hitCount += h.hitCount;
      existing.occurrences += h.occurrences;
    }
  }
  // Recompute percents from the merged absolute times using the original denominator
  const result = [...seen.values()];
  if (totalDuration > 0) {
    for (const h of result) {
      h.selfPercent = (h.selfTime / totalDuration) * 100;
      h.totalPercent = (h.totalTime / totalDuration) * 100;
    }
  }
  return result.sort((a, b) => b.selfTime - a.selfTime);
}

// ─── Suggestion assembly ──────────────────────────────────────────────────────

/**
 * Build the pattern list for one hotspot.
 *
 * `cpu-bound` is emitted whenever the function is expensive enough to matter,
 * not only as a fallback: an expensive function that also matches an advisory
 * pattern still needs its CPU cost stated, otherwise the most important finding
 * in the profile is the one that goes unreported.
 */
export function buildSuggestion(profile: ParsedProfile, h: HotspotEntry): Suggestion {
  const patterns: PatternMatch[] = [];

  const gc = detectGcPressure(profile, h.functionName);
  if (gc) patterns.push(gc);

  const fanIn = detectHighFanIn(profile, h.functionName);
  if (fanIn) patterns.push(fanIn);

  const recursion = detectRecursion(profile, h);
  if (recursion) patterns.push(recursion);

  const hotCaller = detectHotCaller(profile, h.functionName);
  if (hotCaller) patterns.push(hotCaller);

  const namePattern = detectNamePattern(h.functionName, h);
  if (namePattern) patterns.push(namePattern);

  const orchestrator = detectOrchestrator(h);
  if (orchestrator) patterns.push(orchestrator);

  if (h.selfPercent >= CPU_BOUND_MIN_SELF_PERCENT || patterns.length === 0) {
    patterns.push({
      pattern: 'cpu-bound',
      detail: `Consumes ${h.selfPercent.toFixed(1)}% of CPU self-time`,
      suggestion:
        'Review for algorithmic complexity, unnecessary allocations, or repeated ' +
        'computations that could be cached or moved outside hot loops.',
    });
  }

  patterns.sort((a, b) => (PATTERN_PRIORITY[b.pattern] ?? 0) - (PATTERN_PRIORITY[a.pattern] ?? 0));

  return {
    function: h.functionName,
    file: h.url,
    line: h.lineNumber,
    selfPercent: `${h.selfPercent.toFixed(1)}%`,
    patterns,
    topSuggestion: patterns[0].suggestion,
  };
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerSuggestOptimizations(server: McpServer) {
  server.registerTool(
    'suggest_optimizations',
    {
      title: 'Suggest Optimizations',
      description:
        'Analyzes the profile and returns structured optimization suggestions for the hottest ' +
        'functions. Detects high fan-in, recursion, dominant callers, V8-specific patterns, ' +
        'always reports CPU self-time cost for expensive functions, and deduplicates functions ' +
        'split across multiple call sites.',
      inputSchema: {
        profileId: z.string().describe('Profile ID returned by load_profile'),
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe('Number of functions to analyze (default: 5)'),
      },
    },
    async ({ profileId, limit }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found.` }],
          isError: true,
        };
      }

      // Fetch more candidates before deduplication so limit is met after merging
      const rawHotspots = getHotspots(profile, limit * 3);
      const hotspots = deduplicateHotspots(rawHotspots, profile.totalDuration).slice(0, limit);

      const suggestions: Suggestion[] = hotspots.map((h) => buildSuggestion(profile, h));

      const nextStep =
        suggestions.length > 0
          ? `Call read_source_context with functionName '${suggestions[0].function}' to see the hottest lines before applying a fix.`
          : 'No suggestions generated. Confirm the profile captured active work via get_profile_summary.';

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ suggestions, nextStep }, null, 2),
          },
        ],
      };
    },
  );
}
