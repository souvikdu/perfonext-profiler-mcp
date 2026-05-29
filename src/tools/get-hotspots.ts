import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProfile } from '../store.js';
import { getHotspots } from '../parser/call-tree.js';

export function registerGetHotspots(server: McpServer) {
  server.registerTool('get_hotspots', {
    title: 'Get Hotspots',
    description: 'Returns the top N functions by self-time (CPU time spent directly in the function, not its callees). Use this to find performance bottlenecks.',
    inputSchema: {
      profileId: z.string().describe('Profile ID returned by load_profile'),
      limit: z.number().min(1).max(100).default(10).describe('Number of hotspots to return (default: 10)'),
    },
  }, async ({ profileId, limit }) => {
    const profile = getProfile(profileId);
    if (!profile) {
      return {
        content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found. Use load_profile first.` }],
        isError: true,
      };
    }

    const hotspots = getHotspots(profile, limit);
    const formatted = hotspots.map((h, i) => ({
      rank: i + 1,
      function: h.functionName,
      file: h.url,
      line: h.lineNumber,
      package: h.package ?? '(user code)',
      selfTime: `${(h.selfTime / 1000).toFixed(1)}ms`,
      selfPercent: `${h.selfPercent.toFixed(1)}%`,
      totalTime: `${(h.totalTime / 1000).toFixed(1)}ms`,
      totalPercent: `${h.totalPercent.toFixed(1)}%`,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(formatted, null, 2),
      }],
    };
  });
}
