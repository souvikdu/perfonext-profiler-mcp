import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile, listProfiles } from '../store.js';
import { buildCallTree } from '../parser/call-tree.js';

export function registerGetProfileSummary(server: McpServer) {
  server.registerTool(
    'get_profile_summary',
    {
      title: 'Get Profile Summary',
      description:
        'Returns an overview of a loaded profile: duration, sample count, top-level call tree (filtered to functions >0.1% of total time), and idle time percentage. For large profiles, the call tree is limited to depth 2 and top 20 children per node to keep output manageable. Also lists all loaded profiles if no ID is given.',
      inputSchema: {
        profileId: z
          .string()
          .optional()
          .describe('Profile ID. If omitted, lists all loaded profiles.'),
        treeDepth: z
          .number()
          .min(1)
          .max(5)
          .default(2)
          .describe('Depth of call tree to include (default: 2, max: 5)'),
      },
    },
    async ({ profileId, treeDepth }) => {
      if (!profileId) {
        const profiles = listProfiles();
        if (profiles.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No profiles loaded. Use load_profile to load a .cpuprofile file.',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  loadedProfiles: profiles.map((p) => ({
                    ...p,
                    duration: `${(p.duration / 1000).toFixed(1)}ms`,
                  })),
                  nextStep: `Call get_hotspots with one of the profileId values above to find its top functions.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found.` }],
          isError: true,
        };
      }

      // Calculate idle time
      let idleTime = 0;
      for (const node of profile.nodes.values()) {
        if (node.callFrame.functionName === '(idle)') {
          idleTime += node.selfTime;
        }
      }

      const tree = buildCallTree(profile, undefined, treeDepth);

      const idlePercentNum =
        profile.totalDuration > 0 ? (idleTime / profile.totalDuration) * 100 : 0;
      const activePercentNum =
        profile.totalDuration > 0
          ? ((profile.totalDuration - idleTime) / profile.totalDuration) * 100
          : 0;

      const summary = {
        filename: profile.filename,
        totalDuration: `${(profile.totalDuration / 1000).toFixed(1)}ms`,
        sampleCount: profile.sampleCount,
        nodeCount: profile.nodes.size,
        idlePercent: `${idlePercentNum.toFixed(1)}%`,
        activePercent: `${activePercentNum.toFixed(1)}%`,
        callTree: tree,
        nextStep: `Call get_hotspots with profileId '${profileId}' to rank functions by self-time.`,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
