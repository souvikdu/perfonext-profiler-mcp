import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';
import { getCallersOf, getCalleesOf } from '../parser/call-tree.js';
import { readSourceContext } from './read-source-context.js';

export function registerExplainFunction(server: McpServer) {
  server.registerTool(
    'explain_function',
    {
      title: 'Explain Function',
      description:
        'Returns detailed timing info for a specific function: self-time, total-time, callers, and callees. Use this to understand why a function is slow.',
      inputSchema: {
        profileId: z.string().describe('Profile ID returned by load_profile'),
        functionName: z.string().describe('Exact function name to look up'),
        includeSource: z
          .boolean()
          .optional()
          .describe(
            'When true, include annotated source code lines with per-line tick counts (default: false)',
          ),
        contextLines: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'Only used with includeSource: minimum lines of padding around the declaration and hot lines (default: 10)',
          ),
      },
    },
    async ({ profileId, functionName, includeSource = false, contextLines = 10 }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found.` }],
          isError: true,
        };
      }

      // Find all nodes matching this function name
      const matches = Array.from(profile.nodes.values()).filter(
        (n) => n.callFrame.functionName === functionName,
      );

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Function "${functionName}" not found in profile. Check the exact name using get_hotspots.`,
            },
          ],
          isError: true,
        };
      }

      const aggregated = {
        functionName,
        occurrences: matches.length,
        selfTime: matches.reduce((sum, n) => sum + n.selfTime, 0),
        totalTime: matches.reduce((sum, n) => sum + n.totalTime, 0),
        hitCount: matches.reduce((sum, n) => sum + n.hitCount, 0),
        locations: matches.map((n) => ({
          file: n.callFrame.url,
          line: n.callFrame.lineNumber + 1,
        })),
      };

      const callers = getCallersOf(profile, functionName).map((c) => ({
        function: c.callFrame.functionName || '(anonymous)',
        file: c.callFrame.url,
        totalTime: `${(c.totalTime / 1000).toFixed(1)}ms`,
      }));

      const callees = getCalleesOf(profile, functionName).map((c) => ({
        function: c.callFrame.functionName || '(anonymous)',
        file: c.callFrame.url,
        selfTime: `${(c.selfTime / 1000).toFixed(1)}ms`,
        totalTime: `${(c.totalTime / 1000).toFixed(1)}ms`,
      }));

      const output: Record<string, unknown> = {
        ...aggregated,
        selfTime: `${(aggregated.selfTime / 1000).toFixed(1)}ms`,
        selfPercent: `${((aggregated.selfTime / profile.totalDuration) * 100).toFixed(1)}%`,
        totalTime: `${(aggregated.totalTime / 1000).toFixed(1)}ms`,
        totalPercent: `${((aggregated.totalTime / profile.totalDuration) * 100).toFixed(1)}%`,
        callers,
        callees,
      };

      if (includeSource) {
        try {
          output.sourceContext = await readSourceContext(profile, functionName, contextLines);
        } catch (err) {
          output.sourceContext = { error: (err as Error).message };
        }
      }

      output.nextStep = includeSource
        ? `Call suggest_optimizations to get ranked, pattern-based fixes for the hottest functions.`
        : `Call read_source_context with functionName '${functionName}' to see which source lines are hottest, or explain_function again with includeSource: true.`;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    },
  );
}
