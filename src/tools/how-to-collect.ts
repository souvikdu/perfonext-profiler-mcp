import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type CollectScenario = 'next-server' | 'script';

const PROFILE_DIR = './.perf-profiles';
const NEXT_SERVER_COMMAND = `node --cpu-prof --cpu-prof-dir=${PROFILE_DIR} ./node_modules/next/dist/bin/next start`;
const SCRIPT_COMMAND = `node --cpu-prof --cpu-prof-dir=${PROFILE_DIR} .next/standalone/server.js`;

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
        'Profile a Next.js standalone server (output: "standalone"), or substitute another Node entry. ' +
        'Keep the scenario narrow (one route, one hit) so the profile stays focused. Node writes one ' +
        '.cpuprofile per process/worker thread into the output directory.',
      command: SCRIPT_COMMAND,
      steps: [
        'Build first if you have not already: next build',
        `Start the process with profiling: ${SCRIPT_COMMAND}`,
        'Hit the route you want to profile exactly once (e.g. curl http://localhost:3000/your-route).',
        'Stop the process so it can exit and write the .cpuprofile.',
        `Load the result: load_profile({ filePath: "${PROFILE_DIR}/<file>.cpuprofile" })`,
      ],
      outputDir: PROFILE_DIR,
      nextStep: `Once the process exits, call load_profile with the .cpuprofile written under "${PROFILE_DIR}".`,
    };
  }

  // Default: next-server
  return {
    scenario: 'next-server',
    summary:
      'Profile a production Next.js server while it handles a single request. ' +
      'Keep the scenario narrow (one route, one hit) so the profile stays focused.',
    command: NEXT_SERVER_COMMAND,
    steps: [
      'Build first if you have not already: next build',
      `Start the server with profiling: ${NEXT_SERVER_COMMAND}`,
      'If next start says standalone output is unsupported, use the script scenario with .next/standalone/server.js instead.',
      'Hit the route you want to profile exactly once (e.g. curl http://localhost:3000/your-route).',
      'Stop the server so the process can exit and write the .cpuprofile.',
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
              'production server; "script" profiles a Next.js standalone server.js (or another Node entry).',
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
