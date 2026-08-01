import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCpuProfile } from '../parser/cpuprofile.js';
import { storeProfile } from '../store.js';

export function registerLoadProfile(server: McpServer) {
  server.registerTool('load_profile', {
    title: 'Load CPU Profile',
    description: 'Parse and load a V8/Chrome CPU profile from disk. Supports both .cpuprofile files and Chrome DevTools Trace JSON exports. Returns a profile ID for use with other tools.',
    inputSchema: {
      filePath: z.string().describe('Absolute or relative path to the .cpuprofile or Chrome trace .json file'),
    },
  }, async ({ filePath }) => {
    const absPath = resolve(filePath);
    const content = await readFile(absPath, 'utf-8');
    const profile = parseCpuProfile(content, absPath);
    storeProfile(profile);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          profileId: profile.id,
          filename: profile.filename,
          totalDuration: `${(profile.totalDuration / 1000).toFixed(1)}ms`,
          sampleCount: profile.sampleCount,
          nodeCount: profile.nodes.size,
          nextStep: `Call get_hotspots with profileId '${profile.id}' to find the top functions by self-time.`,
        }, null, 2),
      }],
    };
  });
}
