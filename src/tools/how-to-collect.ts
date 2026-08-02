import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type CollectScenario = 'next-server' | 'script';

const PROFILE_DIR = './.perf-profiles';

export interface CollectRecipe {
  scenario: CollectScenario;
  summary: string;
  command: string;
  steps: string[];
  outputDir: string;
  nextStep: string;
}

/**
 * Build a ready-to-run collection recipe for the requested scenario.
 * Exported for unit testing.
 */
export function buildCollectRecipe(scenario: CollectScenario): CollectRecipe {
  if (scenario === 'script') {
    return {
      scenario,
      summary:
        'Profile a standalone Node.js script. Node writes one .cpuprofile per ' +
        'process/worker thread into the output directory.',
      command: `node --cpu-prof --cpu-prof-dir=${PROFILE_DIR} your-script.js`,
      steps: [
        `Run: node --cpu-prof --cpu-prof-dir=${PROFILE_DIR} your-script.js`,
        'Let the script finish (the profile is flushed on exit).',
        `Load the result: load_profile({ filePath: "${PROFILE_DIR}/<file>.cpuprofile" })`,
      ],
      outputDir: PROFILE_DIR,
      nextStep: `Once the script exits, call load_profile with the .cpuprofile written under "${PROFILE_DIR}".`,
    };
  }

  // Default: next-server
  return {
    scenario: 'next-server',
    summary:
      'Profile a production Next.js server while it handles a single request. ' +
      'Keep the scenario narrow (one route, one hit) so the profile stays focused. ' +
      'Command uses bash/zsh env-var syntax; on Windows PowerShell, set $env:NODE_OPTIONS first.',
    command: `NODE_OPTIONS='--cpu-prof --cpu-prof-dir=${PROFILE_DIR}' next start`,
    steps: [
      'Build first if you have not already: next build',
      `Start the server with profiling: NODE_OPTIONS='--cpu-prof --cpu-prof-dir=${PROFILE_DIR}' next start`,
      'Hit the route you want to profile exactly once (e.g. curl http://localhost:3000/your-route).',
      'Stop the server with Ctrl-C — Node flushes the .cpuprofile on exit.',
      `Load the result: load_profile({ filePath: "${PROFILE_DIR}/<file>.cpuprofile" })`,
    ],
    outputDir: PROFILE_DIR,
    nextStep: `After stopping the server, call load_profile with the .cpuprofile written under "${PROFILE_DIR}".`,
  };
}

export function registerHowToCollect(server: McpServer): void {
  server.registerTool(
    'how_to_collect',
    {
      title: 'How To Collect a CPU Profile',
      description:
        'Returns a ready-to-run command and step-by-step recipe for capturing a V8 ' +
        'CPU profile, then loading it with load_profile. Use this when you do not yet ' +
        'have a .cpuprofile file. Choose the scenario that matches how the code runs.',
      inputSchema: {
        scenario: z
          .enum(['next-server', 'script'])
          .optional()
          .describe(
            'How the code under test runs. "next-server" (default) profiles a Next.js ' +
              'production server; "script" profiles a standalone Node.js script.',
          ),
      },
    },
    async ({ scenario = 'next-server' }) => {
      const recipe = buildCollectRecipe(scenario);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(recipe, null, 2) }],
      };
    },
  );
}
