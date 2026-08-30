import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';

export function registerCompareProfiles(server: McpServer) {
  server.registerTool(
    'compare_profiles',
    {
      title: 'Compare Profiles',
      description:
        'Compare two loaded CPU profiles side-by-side. Shows functions that got slower/faster and new/removed hotspots.',
      inputSchema: {
        baseProfileId: z.string().describe('Profile ID of the baseline (before)'),
        compareProfileId: z.string().describe('Profile ID to compare (after)'),
        limit: z.number().min(1).max(50).default(10).describe('Number of top changes to show'),
      },
    },
    async ({ baseProfileId, compareProfileId, limit }) => {
      const base = getProfile(baseProfileId);
      const compare = getProfile(compareProfileId);

      if (!base) {
        return {
          content: [
            { type: 'text' as const, text: `Error: Base profile "${baseProfileId}" not found.` },
          ],
          isError: true,
        };
      }
      if (!compare) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Compare profile "${compareProfileId}" not found.`,
            },
          ],
          isError: true,
        };
      }

      // Aggregate by function identity (name + file), not by bare name
      const baseFuncs = aggregateByFunction(base);
      const compareFuncs = aggregateByFunction(compare);

      const allKeys = new Set([...baseFuncs.keys(), ...compareFuncs.keys()]);
      const diffs: FunctionDiff[] = [];

      for (const key of allKeys) {
        const entry = compareFuncs.get(key) ?? baseFuncs.get(key);
        if (!entry) continue;
        if (SYNTHETIC_FRAMES.has(entry.functionName)) continue;

        const baseSelf = baseFuncs.get(key)?.selfTime ?? 0;
        const compareSelf = compareFuncs.get(key)?.selfTime ?? 0;
        const delta = compareSelf - baseSelf;

        if (baseSelf > 0 || compareSelf > 0) {
          diffs.push({
            functionName: entry.functionName,
            url: entry.url,
            lineNumber: entry.lineNumber,
            baseSelfTime: baseSelf,
            compareSelfTime: compareSelf,
            delta,
            percentChange: baseSelf > 0 ? (delta / baseSelf) * 100 : compareSelf > 0 ? Infinity : 0,
          });
        }
      }

      // Sort by absolute delta (biggest changes first)
      diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const topChanges = diffs.slice(0, limit);

      const result = {
        baseDuration: `${(base.totalDuration / 1000).toFixed(1)}ms`,
        compareDuration: `${(compare.totalDuration / 1000).toFixed(1)}ms`,
        durationChange: `${((compare.totalDuration - base.totalDuration) / 1000).toFixed(1)}ms`,
        topChanges: topChanges.map((d) => ({
          function: d.functionName,
          file: d.url,
          line: d.lineNumber,
          baseSelfTime: `${(d.baseSelfTime / 1000).toFixed(1)}ms`,
          compareSelfTime: `${(d.compareSelfTime / 1000).toFixed(1)}ms`,
          delta: `${d.delta > 0 ? '+' : ''}${(d.delta / 1000).toFixed(1)}ms`,
          percentChange:
            d.percentChange === Infinity
              ? 'new'
              : `${d.percentChange > 0 ? '+' : ''}${d.percentChange.toFixed(1)}%`,
          status: d.delta > 0 ? 'slower' : d.delta < 0 ? 'faster' : 'unchanged',
        })),
        identityNote:
          'Functions are matched across the two profiles by name and file, so same-named functions in different files are no longer merged. A function that moved to a different file (or a renamed bundle chunk) shows up as one removed and one new entry rather than as a delta.',
        nextStep: (() => {
          const slower = topChanges.find((d) => d.delta > 0);
          return slower
            ? `Call explain_function with functionName '${slower.functionName}' on profileId '${compareProfileId}' to see why it got slower.`
            : `No regressions in the top changes. Call get_hotspots on profileId '${compareProfileId}' to inspect the current hotspots.`;
        })(),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

const SYNTHETIC_FRAMES = new Set(['(idle)', '(root)', '(program)', '(garbage collector)']);

interface FunctionDiff {
  functionName: string;
  url: string;
  lineNumber: number;
  baseSelfTime: number;
  compareSelfTime: number;
  delta: number;
  percentChange: number;
}

interface AggFunc {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTime: number;
  totalTime: number;
}

/**
 * Identity here is name + file, deliberately without the declaration line used elsewhere:
 * the two profiles come from different builds, where an unrelated edit above a function
 * shifts its line and would otherwise report it as removed-and-re-added.
 */
function aggregateByFunction(profile: {
  nodes: Map<
    number,
    {
      callFrame: { functionName: string; url: string; lineNumber: number };
      selfTime: number;
      totalTime: number;
    }
  >;
}): Map<string, AggFunc> {
  const map = new Map<string, AggFunc>();
  for (const node of profile.nodes.values()) {
    const name = node.callFrame.functionName || '(anonymous)';
    const key = `${name}::${node.callFrame.url}`;
    const existing = map.get(key);
    if (existing) {
      existing.selfTime += node.selfTime;
      existing.totalTime += node.totalTime;
      existing.lineNumber = Math.min(existing.lineNumber, node.callFrame.lineNumber + 1);
    } else {
      map.set(key, {
        functionName: name,
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber + 1,
        selfTime: node.selfTime,
        totalTime: node.totalTime,
      });
    }
  }
  return map;
}
