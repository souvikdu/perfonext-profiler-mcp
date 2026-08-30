import { AggregatedNode, CallFrame, ParsedProfile } from './types.js';

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

/**
 * The single identity rule for a function across every tool in this server. Sampling splits one
 * logical function into many nodes, so tools must aggregate on this instead of the bare name —
 * otherwise the same function is reported several times with a fraction of its cost each.
 */
export function frameKey(frame: CallFrame): string {
  return `${frame.functionName}::${frame.url}::${frame.lineNumber}`;
}

/** Empty URLs are V8/Node internals — there is no source file to open, so say so. */
export function describeFrameOrigin(url: string): string {
  if (!url) return '(native)';
  return extractPackageName(url) ?? '(user code)';
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
  occurrences: number;
  package: string | null;
}

export function getHotspots(profile: ParsedProfile, limit: number): HotspotEntry[] {
  const aggregated = new Map<string, HotspotEntry>();

  for (const node of profile.nodes.values()) {
    if (node.selfTime <= 0) continue;
    if (node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(root)') {
      continue;
    }

    const existing = aggregated.get(frameKey(node.callFrame));
    if (existing) {
      existing.selfTime += node.selfTime;
      existing.totalTime += node.totalTime;
      existing.hitCount += node.hitCount;
      existing.occurrences += 1;
      continue;
    }

    aggregated.set(frameKey(node.callFrame), {
      functionName: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      lineNumber: node.callFrame.lineNumber + 1, // Convert 0-based to 1-based
      selfTime: node.selfTime,
      totalTime: node.totalTime,
      selfPercent: 0,
      totalPercent: 0,
      hitCount: node.hitCount,
      occurrences: 1,
      package: extractPackageName(node.callFrame.url),
    });
  }

  return Array.from(aggregated.values())
    .sort((a, b) => b.selfTime - a.selfTime)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      selfPercent: profile.totalDuration > 0 ? (entry.selfTime / profile.totalDuration) * 100 : 0,
      totalPercent: profile.totalDuration > 0 ? (entry.totalTime / profile.totalDuration) * 100 : 0,
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
  const node = profile.nodes.get(nodeId);
  if (!node) {
    return {
      functionName: '(root)',
      url: '',
      lineNumber: 1,
      selfTime: 0,
      totalTime: 0,
      selfPercent: 0,
      totalPercent: 0,
      children: [],
    };
  }

  const children =
    currentDepth < maxDepth
      ? node.children
          .map((cid) => profile.nodes.get(cid))
          .filter(
            (c): c is AggregatedNode =>
              c !== undefined &&
              c.totalTime > 0 &&
              (totalDuration > 0 ? (c.totalTime / totalDuration) * 100 >= minTimePercent : false),
          )
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
    selfPercent: totalDuration > 0 ? (node.selfTime / totalDuration) * 100 : 0,
    totalPercent: totalDuration > 0 ? (node.totalTime / totalDuration) * 100 : 0,
    children,
  };
}

export interface CallSiteEntry {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTime: number;
  totalTime: number;
  occurrences: number;
}

/** Collapse a set of profile nodes into one row per distinct function, summing their times. */
function aggregateCallSites(nodes: AggregatedNode[]): CallSiteEntry[] {
  const merged = new Map<string, CallSiteEntry>();
  const countedNodeIds = new Set<number>();

  for (const node of nodes) {
    if (countedNodeIds.has(node.id)) continue;
    countedNodeIds.add(node.id);

    const key = frameKey(node.callFrame);
    const existing = merged.get(key);
    if (existing) {
      existing.selfTime += node.selfTime;
      existing.totalTime += node.totalTime;
      existing.occurrences += 1;
      continue;
    }

    merged.set(key, {
      functionName: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      lineNumber: node.callFrame.lineNumber + 1,
      selfTime: node.selfTime,
      totalTime: node.totalTime,
      occurrences: 1,
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.totalTime - a.totalTime);
}

export function getCallersOf(profile: ParsedProfile, functionName: string): CallSiteEntry[] {
  const parents: AggregatedNode[] = [];
  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName === functionName && node.parent !== null) {
      const parent = profile.nodes.get(node.parent);
      if (parent) parents.push(parent);
    }
  }
  return aggregateCallSites(parents);
}

export function getCalleesOf(profile: ParsedProfile, functionName: string): CallSiteEntry[] {
  const children: AggregatedNode[] = [];
  for (const node of profile.nodes.values()) {
    if (node.callFrame.functionName === functionName) {
      for (const childId of node.children) {
        const child = profile.nodes.get(childId);
        if (child) children.push(child);
      }
    }
  }
  return aggregateCallSites(children);
}
