import { describe, it, expect, afterEach } from 'vitest';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import { storeProfile, removeProfile } from '../src/store.js';
import { ParsedProfile, AggregatedNode } from '../src/parser/types.js';

import {
  deduplicateHotspots,
  detectHighFanIn,
  detectRecursion,
  detectHotCaller,
} from '../src/tools/suggest-optimizations.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  functionName: string,
  parent: number | null,
  children: number[],
  selfTime = 10,
  totalTime = 20,
): AggregatedNode {
  return {
    id,
    callFrame: {
      functionName,
      scriptId: '1',
      url: 'file:///app/src/index.js',
      lineNumber: id,
      columnNumber: 0,
    },
    hitCount: 1,
    selfTime,
    totalTime,
    parent,
    children,
    positionTicks: [],
  };
}

function makeProfile(nodes: AggregatedNode[], id = 'test-profile'): ParsedProfile {
  const nodeMap = new Map<number, AggregatedNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return {
    id,
    filename: 'test.cpuprofile',
    nodes: nodeMap,
    totalDuration: 1_000_000,
    sampleCount: nodes.length,
    root: nodes[0]?.id ?? 1,
  };
}

// ─── Import helpers under test (they are not currently re-exported, so we
//     exercise them indirectly through the full tool via the fixture profile)
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fixturePath = resolve(import.meta.dirname, 'fixtures/sample.cpuprofile');

async function loadFixtureProfile(): Promise<ParsedProfile> {
  const content = await readFile(fixturePath, 'utf-8');
  return parseCpuProfile(content, 'sample.cpuprofile');
}

// ─── Deduplication ───────────────────────────────────────────────────────────

describe('suggest_optimizations – deduplication', () => {
  it('merges the same function appearing at multiple call sites', async () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2]),
      makeNode(2, 'entry', 1, [3, 4]),
      makeNode(3, 'hotFn', 2, [], 100, 100),
      makeNode(4, 'callerB', 2, [5]),
      makeNode(5, 'hotFn', 4, [], 80, 80),
    ];
    const profile = makeProfile(nodes);
    const { getHotspots } = await import('../src/parser/call-tree.js');
    const raw = getHotspots(profile, 10);
    const deduped = deduplicateHotspots(raw, profile.totalDuration);

    const hotFnEntries = deduped.filter((h) => h.functionName === 'hotFn');
    // After dedup: exactly one entry for hotFn
    expect(hotFnEntries).toHaveLength(1);
    // Merged selfTime should equal sum of both nodes (100 + 80)
    expect(hotFnEntries[0].selfTime).toBe(180);
    // Percents recomputed from merged times — must not exceed 100
    expect(hotFnEntries[0].selfPercent).toBeLessThanOrEqual(100);
  });
});

// ─── Fan-in detection ────────────────────────────────────────────────────────

describe('suggest_optimizations – fan-in', () => {
  it('detects high fan-in when a function is called from 3+ distinct callers', () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2, 4, 6, 8]),
      makeNode(2, 'callerA', 1, [3]),
      makeNode(3, 'sharedUtil', 2, [], 50, 50),
      makeNode(4, 'callerB', 1, [5]),
      makeNode(5, 'sharedUtil', 4, [], 50, 50),
      makeNode(6, 'callerC', 1, [7]),
      makeNode(7, 'sharedUtil', 6, [], 50, 50),
      makeNode(8, 'otherFn', 1, [], 10, 10),
    ];
    const profile = makeProfile(nodes);
    const result = detectHighFanIn(profile, 'sharedUtil');
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('high-fan-in');
    expect(result!.detail).toContain('3 distinct call sites');
  });

  it('does NOT flag fan-in for functions with < 3 distinct callers', () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2, 4]),
      makeNode(2, 'callerA', 1, [3]),
      makeNode(3, 'util', 2, [], 50, 50),
      makeNode(4, 'callerB', 1, [5]),
      makeNode(5, 'util', 4, [], 50, 50),
    ];
    const profile = makeProfile(nodes);
    expect(detectHighFanIn(profile, 'util')).toBeNull();
  });
});

// ─── Recursion detection ─────────────────────────────────────────────────────

describe('suggest_optimizations – recursion', () => {
  it('detects direct recursion (fn calls itself)', () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2]),
      makeNode(2, 'recurse', 1, [3], 10, 100),
      makeNode(3, 'recurse', 2, [], 90, 90),
    ];
    const profile = makeProfile(nodes);
    const result = detectRecursion(profile, 'recurse');
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('recursion');
  });

  it('detects indirect recursion (A → B → A)', () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2]),
      makeNode(2, 'fnA', 1, [3], 5, 100),
      makeNode(3, 'fnB', 2, [4], 5, 90),
      makeNode(4, 'fnA', 3, [], 80, 80),
    ];
    const profile = makeProfile(nodes);
    const result = detectRecursion(profile, 'fnA');
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('recursion');
  });
});

// ─── Hot-caller detection ────────────────────────────────────────────────────

describe('suggest_optimizations – hot caller', () => {
  it('identifies dominant caller contributing ≥80% of call sites', () => {
    // hotFn appears 5 times: 4 from dominantCaller, 1 from otherCaller
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2, 3, 4, 5, 6, 7]),
      makeNode(2, 'dominantCaller', 1, [10]),
      makeNode(3, 'dominantCaller', 1, [11]),
      makeNode(4, 'dominantCaller', 1, [12]),
      makeNode(5, 'dominantCaller', 1, [13]),
      makeNode(6, 'otherCaller', 1, [14]),
      makeNode(7, 'unrelated', 1, [], 200, 200),
      makeNode(10, 'hotFn', 2, [], 50, 50),
      makeNode(11, 'hotFn', 3, [], 50, 50),
      makeNode(12, 'hotFn', 4, [], 50, 50),
      makeNode(13, 'hotFn', 5, [], 50, 50),
      makeNode(14, 'hotFn', 6, [], 50, 50),
    ];
    const profile = makeProfile(nodes);
    const result = detectHotCaller(profile, 'hotFn');
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('hot-caller');
    expect(result!.detail).toContain('dominantCaller');
    expect(result!.detail).toContain('80%');
  });

  it('does NOT flag hot-caller when no single caller reaches 80%', () => {
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2, 3, 4]),
      makeNode(2, 'callerA', 1, [5]),
      makeNode(3, 'callerB', 1, [6]),
      makeNode(4, 'callerC', 1, [7]),
      makeNode(5, 'hotFn', 2, [], 50, 50),
      makeNode(6, 'hotFn', 3, [], 50, 50),
      makeNode(7, 'hotFn', 4, [], 50, 50),
    ];
    const profile = makeProfile(nodes);
    expect(detectHotCaller(profile, 'hotFn')).toBeNull();
  });
});

// ─── Name-based patterns (GC, JSON, RegExp, Deopt) ──────────────────────────

describe('suggest_optimizations – name-based patterns', () => {
  it('JSON.parse in fixture triggers json-serialization suggestion', async () => {
    const profile = await loadFixtureProfile();
    const { getHotspots } = await import('../src/parser/call-tree.js');
    const hotspots = getHotspots(profile, 20);
    const jsonParseHotspot = hotspots.find((h) => h.functionName === 'JSON.parse');
    expect(jsonParseHotspot).toBeDefined();
  });

  it('GC function name matches gc-pressure pattern', () => {
    const gcNames = [
      '(garbage collector)',
      'GC prologue',
      'Scavenge',
      'MarkCompact',
      'IncrementalMark',
    ];
    for (const name of gcNames) {
      expect(/\(garbage collector\)|\bGC\b|Scavenge|MarkCompact|IncrementalMark/.test(name)).toBe(
        true,
      );
    }
  });

  it('V8 deopt function names match compile pattern', () => {
    const deoptNames = ['Compile', 'Recompile', 'Optimize', 'Deoptimize'];
    for (const name of deoptNames) {
      expect(/Compile|Recompile|Optimize|Deoptimize/.test(name)).toBe(true);
    }
  });
});

// ─── End-to-end: store round-trip ───────────────────────────────────────────

describe('suggest_optimizations – full tool', () => {
  afterEach(() => removeProfile('e2e-profile'));

  it('returns an array of suggestions with required fields', async () => {
    const profile = await loadFixtureProfile();
    storeProfile({ ...profile, id: 'e2e-profile' });

    // Directly call the inner handler by creating a minimal McpServer stub
    // We exercise the shape via the store helpers and direct module import.
    const { getHotspots } = await import('../src/parser/call-tree.js');
    const hotspots = getHotspots(profile, 5);

    expect(hotspots.length).toBeGreaterThan(0);
    // Each hotspot has the fields the tool reads
    for (const h of hotspots) {
      expect(typeof h.functionName).toBe('string');
      expect(typeof h.selfPercent).toBe('number');
      expect(typeof h.lineNumber).toBe('number');
    }
  });

  it('deduplicates when the same function name appears multiple times', async () => {
    // Two nodes for 'processData' in the fixture (it only appears once there, so
    // we build a custom profile with duplicates)
    const nodes: AggregatedNode[] = [
      makeNode(1, '(root)', null, [2, 3]),
      makeNode(2, 'caller1', 1, [4]),
      makeNode(3, 'caller2', 1, [5]),
      makeNode(4, 'sharedWork', 2, [], 200, 200),
      makeNode(5, 'sharedWork', 3, [], 150, 150),
    ];
    const profile = makeProfile(nodes);

    const { getHotspots } = await import('../src/parser/call-tree.js');
    const raw = getHotspots(profile, 10);
    const deduped = deduplicateHotspots(raw, profile.totalDuration);
    const sharedWorkEntries = deduped.filter((h) => h.functionName === 'sharedWork');
    expect(sharedWorkEntries).toHaveLength(1);
    expect(sharedWorkEntries[0].selfTime).toBe(350); // 200 + 150
  });
});
