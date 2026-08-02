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

      // Aggregate by function name
      const baseFuncs = aggregateByFunction(base);
      const compareFuncs = aggregateByFunction(compare);

      const allFunctions = new Set([...baseFuncs.keys(), ...compareFuncs.keys()]);
      const diffs: FunctionDiff[] = [];

      for (const fn of allFunctions) {
        if (fn === '(idle)' || fn === '(root)' || fn === '(program)') continue;

        const baseSelf = baseFuncs.get(fn)?.selfTime ?? 0;
        const compareSelf = compareFuncs.get(fn)?.selfTime ?? 0;
        const delta = compareSelf - baseSelf;

        if (baseSelf > 0 || compareSelf > 0) {
          diffs.push({
            functionName: fn,
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
          baseSelfTime: `${(d.baseSelfTime / 1000).toFixed(1)}ms`,
          compareSelfTime: `${(d.compareSelfTime / 1000).toFixed(1)}ms`,
          delta: `${d.delta > 0 ? '+' : ''}${(d.delta / 1000).toFixed(1)}ms`,
          percentChange:
            d.percentChange === Infinity
              ? 'new'
              : `${d.percentChange > 0 ? '+' : ''}${d.percentChange.toFixed(1)}%`,
          status: d.delta > 0 ? 'slower' : d.delta < 0 ? 'faster' : 'unchanged',
        })),
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

interface FunctionDiff {
  functionName: string;
  baseSelfTime: number;
  compareSelfTime: number;
  delta: number;
  percentChange: number;
}

interface AggFunc {
  selfTime: number;
  totalTime: number;
}

function aggregateByFunction(profile: {
  nodes: Map<number, { callFrame: { functionName: string }; selfTime: number; totalTime: number }>;
}): Map<string, AggFunc> {
  const map = new Map<string, AggFunc>();
  for (const node of profile.nodes.values()) {
    const name = node.callFrame.functionName || '(anonymous)';
    const existing = map.get(name);
    if (existing) {
      existing.selfTime += node.selfTime;
      existing.totalTime += node.totalTime;
    } else {
      map.set(name, { selfTime: node.selfTime, totalTime: node.totalTime });
    }
  }
  return map;
}
