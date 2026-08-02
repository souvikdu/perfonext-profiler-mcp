import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';
import { ParsedProfile } from '../parser/types.js';
import { extractPackageName } from '../parser/call-tree.js';

export interface PackageFunctionEntry {
  functionName: string;
  url: string;
  selfTime: number;
  selfPercent: number;
}

export interface PackageCostEntry {
  package: string;
  selfTime: number;
  selfPercent: number;
  totalTime: number;
  totalPercent: number;
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
  // package → list of nodes (for deriving top functions)
  const nodesMap = new Map<string, { functionName: string; url: string; selfTime: number }[]>();

  for (const node of profile.nodes.values()) {
    // Skip zero-self-time nodes and V8 internals
    if (node.selfTime === 0) continue;
    const pkg = extractPackageName(node.callFrame.url);
    if (!pkg) continue;

    selfMap.set(pkg, (selfMap.get(pkg) ?? 0) + node.selfTime);
    totalMap.set(pkg, (totalMap.get(pkg) ?? 0) + node.totalTime);
    countMap.set(pkg, (countMap.get(pkg) ?? 0) + 1);

    const list = nodesMap.get(pkg) ?? [];
    list.push({
      functionName: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      selfTime: node.selfTime,
    });
    nodesMap.set(pkg, list);
  }

  const entries: PackageCostEntry[] = [];
  for (const [pkg, selfTime] of selfMap) {
    const topFunctions = (nodesMap.get(pkg) ?? [])
      .sort((a, b) => b.selfTime - a.selfTime)
      .slice(0, topFunctionsPerPkg)
      .map((n) => ({
        functionName: n.functionName,
        url: n.url,
        selfTime: n.selfTime,
        selfPercent: (n.selfTime / profile.totalDuration) * 100,
      }));

    entries.push({
      package: pkg,
      selfTime,
      selfPercent: (selfTime / profile.totalDuration) * 100,
      totalTime: totalMap.get(pkg) ?? 0,
      totalPercent: ((totalMap.get(pkg) ?? 0) / profile.totalDuration) * 100,
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
        totalTime: `${(c.totalTime / 1000).toFixed(1)}ms`,
        totalPercent: `${c.totalPercent.toFixed(1)}%`,
        topFunctions: c.topFunctions.map((f) => ({
          function: f.functionName,
          selfTime: `${(f.selfTime / 1000).toFixed(1)}ms`,
          selfPercent: `${f.selfPercent.toFixed(1)}%`,
        })),
      }));

      const nextStep = `Call suggest_optimizations for ranked fixes, or explain_function on a top function from '${formatted[0].package}' to see where its CPU time goes.`;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ packages: formatted, nextStep }, null, 2),
          },
        ],
      };
    },
  );
}
