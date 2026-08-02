import { AggregatedNode, ParsedProfile } from './types.js';

/**
 * Extract the npm package name from a V8 URL, or null for user code / builtins.
 *
 * Examples:
 *   file:///app/node_modules/lodash/src/foo.js  → "lodash"
 *   file:///app/node_modules/@babel/core/lib/index.js → "@babel/core"
 *   file:///app/src/utils.ts → null
 *   "" (native/builtin) → null
 */
export function extractPackageName(url: string): string | null {
  if (!url) return null;
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url);
  return match ? match[1] : null;
}

export interface HotspotEntry {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTime: number;
  totalTime: number;
  selfPercent: number;
  totalPercent: number;
  hitCount: number;
  package: string | null;
}

export function getHotspots(profile: ParsedProfile, limit: number): HotspotEntry[] {
  const nodes = Array.from(profile.nodes.values())
    .filter(
      (n) =>
        n.selfTime > 0 &&
        n.callFrame.functionName !== '(idle)' &&
        n.callFrame.functionName !== '(root)',
    )
    .sort((a, b) => b.selfTime - a.selfTime)
    .slice(0, limit);

  return nodes.map((n) => ({
    functionName: n.callFrame.functionName || '(anonymous)',
    url: n.callFrame.url,
    lineNumber: n.callFrame.lineNumber + 1, // Convert 0-based to 1-based
    selfTime: n.selfTime,
    totalTime: n.totalTime,
    selfPercent: (n.selfTime / profile.totalDuration) * 100,
    totalPercent: (n.totalTime / profile.totalDuration) * 100,
    hitCount: n.hitCount,
    package: extractPackageName(n.callFrame.url),
  }));
}

export interface CallTreeNode {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTime: number;
  totalTime: number;
  selfPercent: number;
  totalPercent: number;
  children: CallTreeNode[];
}

export function buildCallTree(profile: ParsedProfile, nodeId?: number, depth = 2): CallTreeNode {
  const rootId = nodeId ?? profile.root;
  return buildTreeRecursive(profile, rootId, depth, 0, profile.totalDuration);
}

function buildTreeRecursive(
  profile: ParsedProfile,
  nodeId: number,
  maxDepth: number,
  currentDepth: number,
  totalDuration: number,
  minTimePercent = 0.1,
): CallTreeNode {
  const node = profile.nodes.get(nodeId)!;
  const children =
    currentDepth < maxDepth
      ? node.children
          .map((cid) => profile.nodes.get(cid)!)
          .filter((c) => c.totalTime > 0 && (c.totalTime / totalDuration) * 100 >= minTimePercent)
          .sort((a, b) => b.totalTime - a.totalTime)
          .slice(0, 20) // Cap to top 20 children per node
          .map((c) =>
            buildTreeRecursive(
              profile,
              c.id,
              maxDepth,
              currentDepth + 1,
              totalDuration,
              minTimePercent,
            ),
          )
      : [];

  return {
    functionName: node.callFrame.functionName || '(anonymous)',
    url: node.callFrame.url,
    lineNumber: node.callFrame.lineNumber + 1,
    selfTime: node.selfTime,
    totalTime: node.totalTime,
    selfPercent: (node.selfTime / totalDuration) * 100,
    totalPercent: (node.totalTime / totalDuration) * 100,
    children,
  };
}

export function getCallersOf(profile: ParsedProfile, functionName: string): AggregatedNode[] {
  const targets: AggregatedNode[] = [];
  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName === functionName && node.parent !== null) {
      const parent = profile.nodes.get(node.parent);
      if (parent) targets.push(parent);
    }
  }
  return targets;
}

export function getCalleesOf(profile: ParsedProfile, functionName: string): AggregatedNode[] {
  const callees: AggregatedNode[] = [];
  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName === functionName) {
      for (const childId of node.children) {
        const child = profile.nodes.get(childId);
        if (child) callees.push(child);
      }
    }
  }
  return callees;
}
