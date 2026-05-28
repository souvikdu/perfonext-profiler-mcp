import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getProfile } from '../store.js';
import { ParsedProfile } from '../parser/types.js';

export interface SourceLine {
  lineNumber: number;
  content: string;
  ticks: number;
  isHot: boolean;
}

export interface SourceContextResult {
  functionName: string;
  file: string;
  functionLine: number;
  startLine: number;
  endLine: number;
  lines: SourceLine[];
  totalTicks: number;
}

/**
 * Convert a file:// URL or absolute path to a filesystem path.
 * Returns null for URLs with unsupported schemes (http, node:, etc.).
 */
export function fileUrlToPath(url: string): string | null {
  if (url.startsWith('file://')) {
    // file:///path  → /path  (strip file:// prefix)
    return decodeURIComponent(url.slice('file://'.length));
  }
  // Already an absolute path
  if (url.startsWith('/') || /^[A-Za-z]:[/\\]/.test(url)) {
    return url;
  }
  return null;
}

/**
 * Security gate: the resolved path must be within the current working directory.
 */
export function isWithinCwd(filePath: string): boolean {
  const cwd = process.cwd();
  const resolved = resolve(filePath);
  return resolved === cwd || resolved.startsWith(cwd + '/') || resolved.startsWith(cwd + '\\');
}

/**
 * Core logic, exported for unit testing.
 */
export async function readSourceContext(
  profile: ParsedProfile,
  functionName: string,
  contextLines: number,
): Promise<SourceContextResult> {
  // Collect all nodes matching the function name that have a resolvable file URL
  const matches = Array.from(profile.nodes.values()).filter(
    n => n.callFrame.functionName === functionName && n.callFrame.url,
  );

  if (matches.length === 0) {
    throw new Error(
      `Function "${functionName}" not found in profile or has no associated source URL. ` +
      `Check the exact name using get_hotspots.`,
    );
  }

  // Pick the node with the highest hit count as the canonical location
  const primary = matches.reduce(
    (best, n) => n.hitCount > best.hitCount ? n : best,
    matches[0],
  );

  const { url, lineNumber: rawLine } = primary.callFrame;
  const filePath = fileUrlToPath(url);

  if (!filePath) {
    throw new Error(
      `Cannot read source: unsupported URL scheme for "${url}". ` +
      `Only file:// URLs and absolute paths are supported.`,
    );
  }

  if (!isWithinCwd(filePath)) {
    throw new Error(
      `Access denied: "${filePath}" is outside the current working directory. ` +
      `The server only reads source files within the project root.`,
    );
  }

  const content = await readFile(filePath, 'utf-8');
  const allLines = content.split('\n');

  // Aggregate per-line ticks across all matching nodes.
  // positionTicks line numbers are 1-based in the V8 format.
  const tickMap = new Map<number, number>();
  for (const node of matches) {
    for (const pt of node.positionTicks ?? []) {
      tickMap.set(pt.line, (tickMap.get(pt.line) ?? 0) + pt.ticks);
    }
  }

  // callFrame.lineNumber is 0-based; convert to 1-based for display / slicing
  const funcLine = rawLine + 1;
  const startLine = Math.max(1, funcLine - contextLines);
  const endLine = Math.min(allLines.length, funcLine + contextLines);

  const totalTicks = Array.from(tickMap.values()).reduce((a, b) => a + b, 0);
  const maxTicks = tickMap.size > 0 ? Math.max(...tickMap.values()) : 0;

  const lines: SourceLine[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    const ticks = tickMap.get(ln) ?? 0;
    lines.push({
      lineNumber: ln,
      content: allLines[ln - 1] ?? '',
      ticks,
      // Mark a line as "hot" if it carries at least half the max ticks for this function
      isHot: maxTicks > 0 && ticks >= maxTicks * 0.5,
    });
  }

  return {
    functionName,
    file: filePath,
    functionLine: funcLine,
    startLine,
    endLine,
    lines,
    totalTicks,
  };
}

export function registerReadSourceContext(server: McpServer): void {
  server.registerTool(
    'read_source_context',
    {
      title: 'Read Source Context',
      description:
        'Read the actual source code for a hot function and annotate each line with ' +
        'sampled tick counts from positionTicks. Helps identify which specific lines ' +
        'within a function are the bottleneck. Only reads files within the project root.',
      inputSchema: {
        profileId: z.string().describe('Profile ID returned by load_profile'),
        functionName: z.string().describe('Exact function name to look up'),
        contextLines: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Lines of context before and after the function definition (default: 10)'),
      },
    },
    async ({ profileId, functionName, contextLines = 10 }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: `Error: Profile "${profileId}" not found.` }],
          isError: true,
        };
      }

      try {
        const result = await readSourceContext(profile, functionName, contextLines);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
