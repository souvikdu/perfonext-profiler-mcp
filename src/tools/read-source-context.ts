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
  visibleTicks: number;
  hiddenTicks: number;
  warning?: string;
}

// Hard cap on window size so a single misplaced tick can't return the whole file.
const MAX_WINDOW_LINES = 200;

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
    (n) => n.callFrame.functionName === functionName && n.callFrame.url,
  );

  if (matches.length === 0) {
    throw new Error(
      `Function "${functionName}" not found in profile or has no associated source URL. ` +
        `Check the exact name using get_hotspots.`,
    );
  }

  // Pick the node with the highest hit count as the canonical location
  const primary = matches.reduce((best, n) => (n.hitCount > best.hitCount ? n : best), matches[0]);

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

  // Only aggregate ticks from nodes in the same file — same function name in a
  // different file must not pollute this function's tick totals or window.
  const sameFileMatches = matches.filter((n) => n.callFrame.url === url);

  // Aggregate per-line ticks across all matching nodes.
  // positionTicks line numbers are 1-based in the V8 format.
  const tickMap = new Map<number, number>();
  for (const node of sameFileMatches) {
    for (const pt of node.positionTicks ?? []) {
      tickMap.set(pt.line, (tickMap.get(pt.line) ?? 0) + pt.ticks);
    }
  }

  // callFrame.lineNumber is 0-based; convert to 1-based for display / slicing
  const funcLine = rawLine + 1;
  // A loop avoids Math.min/max(...array), which can throw on very large spreads.
  let minTickLine = funcLine;
  let maxTickLine = funcLine;
  let maxTicks = 0;
  let totalTicks = 0;
  for (const [line, ticks] of tickMap) {
    if (line < minTickLine) minTickLine = line;
    if (line > maxTickLine) maxTickLine = line;
    if (ticks > maxTicks) maxTicks = ticks;
    totalTicks += ticks;
  }

  // Size the window from the actual tick extent, not just a fixed radius around the
  // declaration line — a hot function's real work is often many lines past its `function` line.
  const startLine = Math.max(1, Math.min(funcLine, minTickLine) - contextLines);
  let endLine = Math.min(allLines.length, Math.max(funcLine, maxTickLine) + contextLines);
  let cappedByMaxWindow = false;
  if (endLine - startLine + 1 > MAX_WINDOW_LINES) {
    endLine = Math.min(allLines.length, startLine + MAX_WINDOW_LINES - 1);
    cappedByMaxWindow = true;
  }

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

  const visibleTicks = lines.reduce((sum, l) => sum + l.ticks, 0);
  const hiddenTicks = totalTicks - visibleTicks;

  let warning: string | undefined;
  if (hiddenTicks > 0) {
    warning = cappedByMaxWindow
      ? `${hiddenTicks} of ${totalTicks} ticks fall outside this ${startLine}-${endLine} window because the hot lines span more than ${MAX_WINDOW_LINES} lines; a larger contextLines will not help.`
      : `${hiddenTicks} of ${totalTicks} ticks fall outside this ${startLine}-${endLine} window. Call again with a larger contextLines to see them.`;
  }

  return {
    functionName,
    file: filePath,
    functionLine: funcLine,
    startLine,
    endLine,
    lines,
    totalTicks,
    visibleTicks,
    hiddenTicks,
    warning,
  };
}

export function registerReadSourceContext(server: McpServer): void {
  server.registerTool(
    'read_source_context',
    {
      title: 'Read Source Context',
      description:
        'Read the actual source code for a hot function and annotate each line with ' +
        'sampled tick counts from positionTicks. The returned window is sized to cover the ' +
        "function's actual hot lines, not just the area around its declaration; if any ticks " +
        'still fall outside it, a `warning` field reports how many and suggests a larger ' +
        'contextLines. Only reads files within the project root.',
      inputSchema: {
        profileId: z.string().describe('Profile ID returned by load_profile'),
        functionName: z.string().describe('Exact function name to look up'),
        contextLines: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'Minimum lines of padding around the function declaration and its hot lines (default: 10)',
          ),
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
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ...result,
                  nextStep: `Call suggest_optimizations for pattern-based fixes, or explain_function with functionName '${functionName}' to inspect its callers and callees.`,
                },
                null,
                2,
              ),
            },
          ],
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
