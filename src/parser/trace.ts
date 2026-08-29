import { CpuProfile, ProfileNode } from './types.js';

/**
 * Chrome Trace Event format types (subset relevant to CPU profiling)
 */
interface TraceEvent {
  cat: string;
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  args?: {
    data?: {
      startTime?: number;
      endTime?: number;
      cpuProfile?: {
        nodes?: TraceProfileNode[];
        samples?: number[];
      };
      timeDeltas?: number[];
    };
  };
}

interface TraceProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  parent?: number;
  hitCount?: number;
}

/**
 * Detects whether parsed JSON is a Chrome Trace or a V8 .cpuprofile. Inspects the parsed value
 * rather than the source text: a `.cpuprofile` can legitimately contain the string `"traceEvents"`
 * inside a script URL or function name.
 */
export function detectFormat(raw: unknown): 'cpuprofile' | 'trace' {
  if (Array.isArray(raw)) {
    return 'trace';
  }

  if (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { traceEvents?: unknown }).traceEvents)
  ) {
    return 'trace';
  }

  return 'cpuprofile';
}

/**
 * Parses Chrome Trace JSON and extracts a CpuProfile by reassembling ProfileChunk events.
 */
export function parseTraceProfile(raw: unknown): CpuProfile {
  // Handle both formats: { traceEvents: [...] } or just [...]
  const events: TraceEvent[] = Array.isArray(raw)
    ? (raw as TraceEvent[])
    : ((raw as { traceEvents?: TraceEvent[] })?.traceEvents ?? []);

  if (!events || !Array.isArray(events)) {
    throw new Error('Invalid Chrome Trace format: missing traceEvents array');
  }

  // Filter to CPU profiler events
  const cpuEvents = events.filter(
    (e) =>
      e.cat === 'disabled-by-default-v8.cpu_profiler' ||
      e.cat === 'disabled-by-default-v8.cpu_profiler.hires',
  );

  if (cpuEvents.length === 0) {
    throw new Error(
      'No CPU profiler data found in trace. Make sure the recording includes JavaScript profiling.',
    );
  }

  // Pick the main thread (usually has the most profile data)
  // Group by tid and pick the one with most chunks
  const byThread = new Map<number, TraceEvent[]>();
  for (const e of cpuEvents) {
    const existing = byThread.get(e.tid) ?? [];
    existing.push(e);
    byThread.set(e.tid, existing);
  }

  let targetEvents = cpuEvents;
  if (byThread.size > 1) {
    // Pick thread with most events
    let maxCount = 0;
    for (const [_tid, evts] of byThread) {
      if (evts.length > maxCount) {
        maxCount = evts.length;
        targetEvents = evts;
      }
    }
  }

  // Reassemble the profile from chunks
  const allNodes: TraceProfileNode[] = [];
  const allSamples: number[] = [];
  const allTimeDeltas: number[] = [];
  let startTime = 0;
  let endTime = 0;

  for (const event of targetEvents) {
    const data = event.args?.data;
    if (!data) continue;

    if (event.name === 'Profile' && data.startTime !== undefined) {
      startTime = data.startTime;
    }

    if (event.name === 'ProfileChunk' || event.name === 'Profile') {
      if (data.cpuProfile?.nodes) {
        allNodes.push(...data.cpuProfile.nodes);
      }
      if (data.cpuProfile?.samples) {
        allSamples.push(...data.cpuProfile.samples);
      }
      if (data.timeDeltas) {
        allTimeDeltas.push(...data.timeDeltas);
      }
      if (data.endTime !== undefined) {
        endTime = data.endTime;
      }
    }
  }

  if (allNodes.length === 0) {
    throw new Error('No profile nodes found in trace events');
  }

  // If endTime wasn't set, estimate from startTime + sum of timeDeltas
  if (endTime === 0 && allTimeDeltas.length > 0) {
    endTime = startTime + allTimeDeltas.reduce((sum, d) => sum + d, 0);
  }

  // Convert trace nodes to CpuProfile nodes format
  // Trace format uses `parent` references; we need to convert to `children` arrays
  const childrenMap = new Map<number, number[]>();
  for (const node of allNodes) {
    if (!childrenMap.has(node.id)) {
      childrenMap.set(node.id, []);
    }
    if (node.parent !== undefined) {
      const parentChildren = childrenMap.get(node.parent) ?? [];
      parentChildren.push(node.id);
      childrenMap.set(node.parent, parentChildren);
    }
  }

  const profileNodes: ProfileNode[] = allNodes.map((n) => ({
    id: n.id,
    callFrame: n.callFrame,
    hitCount: n.hitCount ?? 0,
    children: childrenMap.get(n.id) ?? [],
  }));

  return {
    nodes: profileNodes,
    startTime,
    endTime,
    samples: allSamples,
    timeDeltas: allTimeDeltas,
  };
}
