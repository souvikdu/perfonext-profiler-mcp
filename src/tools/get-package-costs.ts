import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';
import { ParsedProfile } from '../parser/types.js';
import { extractPackageName, frameKey } from '../parser/call-tree.js';

export interface PackageFunctionEntry {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTime: number;
  selfPercent: number;
}

export interface PackageCostEntry {
  package: string;
  selfTime: number;
  selfPercent: number;
  /** Includes time spent in user code that this package called back into (hooks, comparators, callbacks). */
  totalTimeIncludingCallbacks: number;
  totalPercentIncludingCallbacks: number;
  nodeCount: number;
  topFunctions: PackageFunctionEntry[];
}

/**
 * Core aggregation logic — exported for unit testing.
 *
 * Walks all nodes in the profile and groups self/total time by the npm package
 * name extracted from the node's URL. Nodes without a package (user code or
 * builtins with empty URLs) are excluded.
 */
export function computePackageCosts(
  profile: ParsedProfile,
  limit: number,
  topFunctionsPerPkg = 3,
): PackageCostEntry[] {
  // Per-package accumulators
  const selfMap = new Map<string, number>();
  const totalMap = new Map<string, number>();
  const countMap = new Map<string, number>();
  // package → frame identity → merged function entry (sampling splits one function across nodes)
  const nodesMap = new Map<
    string,
    Map<string, { functionName: string; url: string; lineNumber: number; selfTime: number }>
  >();

  for (const node of profile.nodes.values()) {
    // Skip zero-self-time nodes and V8 internals
    if (node.selfTime === 0) continue;
    const pkg = extractPackageName(node.callFrame.url);
    if (!pkg) continue;

    selfMap.set(pkg, (selfMap.get(pkg) ?? 0) + node.selfTime);
    totalMap.set(pkg, (totalMap.get(pkg) ?? 0) + node.totalTime);
    countMap.set(pkg, (countMap.get(pkg) ?? 0) + 1);

    const functions = nodesMap.get(pkg) ?? new Map();
    const key = frameKey(node.callFrame);
    const existing = functions.get(key);
    if (existing) {
      existing.selfTime += node.selfTime;
    } else {
      functions.set(key, {
        functionName: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber + 1,
        selfTime: node.selfTime,
      });
    }
    nodesMap.set(pkg, functions);
  }

  const entries: PackageCostEntry[] = [];
  for (const [pkg, selfTime] of selfMap) {
    const topFunctions = Array.from((nodesMap.get(pkg) ?? new Map()).values())
      .sort((a, b) => b.selfTime - a.selfTime)
      .slice(0, topFunctionsPerPkg)
      .map((n) => ({
        functionName: n.functionName,
        url: n.url,
        lineNumber: n.lineNumber,
        selfTime: n.selfTime,
        selfPercent: (n.selfTime / profile.totalDuration) * 100,
      }));

    entries.push({
      package: pkg,
      selfTime,
      selfPercent: (selfTime / profile.totalDuration) * 100,
      totalTimeIncludingCallbacks: totalMap.get(pkg) ?? 0,
      totalPercentIncludingCallbacks: ((totalMap.get(pkg) ?? 0) / profile.totalDuration) * 100,
      nodeCount: countMap.get(pkg) ?? 0,
      topFunctions,
    });
  }

  return entries.sort((a, b) => b.selfTime - a.selfTime).slice(0, limit);
}

export function registerGetPackageCosts(server: McpServer): void {
  server.registerTool(
    'get_package_costs',
    {
      title: 'Get Package Costs',
      description:
        'Aggregate CPU self-time by npm package. Identifies which third-party ' +
        'dependencies are consuming the most CPU, by parsing node_modules paths ' +
        'from the profile. Useful for deciding which packages to replace, lazy-load, ' +
        'or avoid. Scoped packages (e.g. @babel/core) are handled correctly.',
      inputSchema: {
        profileId: z.string().describe('Profile ID returned by load_profile'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of packages to return, sorted by self-time (default: 10)'),
      },
    },
    async ({ profileId, limit = 10 }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found.` }],
          isError: true,
        };
      }

      const costs = computePackageCosts(profile, limit);

      if (costs.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No npm package frames found in this profile. All CPU time is in user code or native builtins.',
            },
          ],
        };
      }

      const formatted = costs.map((c, i) => ({
        rank: i + 1,
        package: c.package,
        selfTime: `${(c.selfTime / 1000).toFixed(1)}ms`,
        selfPercent: `${c.selfPercent.toFixed(1)}%`,
        totalTimeIncludingCallbacks: `${(c.totalTimeIncludingCallbacks / 1000).toFixed(1)}ms`,
        totalPercentIncludingCallbacks: `${c.totalPercentIncludingCallbacks.toFixed(1)}%`,
        topFunctions: c.topFunctions.map((f) => ({
          function: f.functionName,
          file: f.url,
          line: f.lineNumber,
          selfTime: `${(f.selfTime / 1000).toFixed(1)}ms`,
          selfPercent: `${f.selfPercent.toFixed(1)}%`,
        })),
      }));

      const nextStep = `Call suggest_optimizations for ranked fixes, or explain_function on a top function from '${formatted[0].package}' to see where its CPU time goes.`;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                packages: formatted,
                note: 'selfTime is CPU spent inside the package itself and is what you should rank by. totalTimeIncludingCallbacks also counts your own code that the package called back into (comparators, hooks, render callbacks), so a thin wrapper around expensive user code can look costly there.',
                nextStep,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
