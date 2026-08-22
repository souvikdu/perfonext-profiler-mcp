import { CpuProfile, AggregatedNode, ParsedProfile } from './types.js';
import { randomUUID } from 'node:crypto';
import { canonicalizeProfileUrl } from '../platform.js';
import { detectFormat, parseTraceProfile } from './trace.js';

export function parseCpuProfile(json: string, filename: string): ParsedProfile {
  let raw: CpuProfile;

  const format = detectFormat(json);
  if (format === 'trace') {
    raw = parseTraceProfile(json);
  } else {
    raw = JSON.parse(json);
  }

  if (!raw.nodes || !raw.samples || !raw.timeDeltas) {
    throw new Error('Invalid profile format: missing nodes, samples, or timeDeltas');
  }

  if (raw.nodes.length === 0) {
    throw new Error('Profile contains no call-tree nodes. The file may be empty or corrupted.');
  }

  const totalDuration = raw.endTime - raw.startTime;
  const nodeMap = new Map<number, AggregatedNode>();

  // Build node map with zero times initially. Canonicalize filesystem / file://
  // URLs once so later tools only see POSIX file:// identity.
  for (const node of raw.nodes) {
    nodeMap.set(node.id, {
      id: node.id,
      callFrame: {
        ...node.callFrame,
        url: canonicalizeProfileUrl(node.callFrame.url ?? ''),
      },
      selfTime: 0,
      totalTime: 0,
      hitCount: node.hitCount,
      children: node.children ?? [],
      parent: null,
      positionTicks: node.positionTicks,
    });
  }

  // Set parent references
  for (const node of raw.nodes) {
    if (node.children) {
      for (const childId of node.children) {
        const child = nodeMap.get(childId);
        if (child) {
          child.parent = node.id;
        }
      }
    }
  }

  // Calculate self time from samples + timeDeltas
  for (let i = 0; i < raw.samples.length; i++) {
    const nodeId = raw.samples[i];
    const delta = raw.timeDeltas[i];
    const node = nodeMap.get(nodeId);
    if (node) {
      node.selfTime += delta;
    }
  }

  // Calculate total time (self time + all descendants' self time)
  // Use bottom-up propagation
  const visited = new Set<number>();

  function computeTotalTime(id: number): number {
    if (visited.has(id)) return 0;
    visited.add(id);
    // A child id can be missing from nodeMap in a truncated/degenerate profile.
    const node = nodeMap.get(id);
    if (!node) return 0;
    let total = node.selfTime;
    for (const childId of node.children) {
      total += computeTotalTime(childId);
    }
    node.totalTime = total;
    return total;
  }

  // Find root (node without parent)
  let rootId = raw.nodes[0].id;
  for (const node of nodeMap.values()) {
    if (node.parent === null) {
      rootId = node.id;
      break;
    }
  }

  computeTotalTime(rootId);

  return {
    id: randomUUID(),
    filename,
    nodes: nodeMap,
    totalDuration,
    sampleCount: raw.samples.length,
    root: rootId,
  };
}
