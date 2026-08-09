import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCpuProfile } from '../parser/cpuprofile.js';
import { storeProfile } from '../store.js';

/**
 * Turn a raw fs/JSON error into a message that says what failed and what the tool expects.
 * Exported for unit testing.
 */
export function formatLoadProfileError(err: unknown, absPath: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return `Error: No file found at "${absPath}". load_profile needs the path to a single .cpuprofile or Chrome trace .json file.`;
  }
  if (code === 'EISDIR') {
    return `Error: "${absPath}" is a directory. load_profile only accepts a single profile file path, not a directory.`;
  }
  if (err instanceof SyntaxError) {
    return `Error: "${absPath}" is not valid JSON. The file may be truncated or corrupted — try re-collecting the profile.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Error: Failed to load profile from "${absPath}": ${message}`;
}

export function registerLoadProfile(server: McpServer) {
  server.registerTool(
    'load_profile',
    {
      title: 'Load CPU Profile',
      description:
        'Parse and load a V8/Chrome CPU profile from disk. Supports both .cpuprofile files and Chrome DevTools Trace JSON exports. Returns a profile ID for use with other tools.',
      inputSchema: {
        filePath: z
          .string()
          .describe('Absolute or relative path to the .cpuprofile or Chrome trace .json file'),
      },
    },
    async ({ filePath }) => {
      const absPath = resolve(filePath);

      try {
        const content = await readFile(absPath, 'utf-8');
        const profile = parseCpuProfile(content, absPath);
        storeProfile(profile);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  profileId: profile.id,
                  filename: profile.filename,
                  totalDuration: `${(profile.totalDuration / 1000).toFixed(1)}ms`,
                  sampleCount: profile.sampleCount,
                  nodeCount: profile.nodes.size,
                  nextStep: `Call get_hotspots with profileId '${profile.id}' to find the top functions by self-time.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatLoadProfileError(err, absPath) }],
          isError: true,
        };
      }
    },
  );
}
