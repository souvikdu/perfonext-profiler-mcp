import { describe, it, expect } from 'vitest';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import { extractPackageName, getHotspots } from '../src/parser/call-tree.js';
import { computePackageCosts } from '../src/tools/get-package-costs.js';

// ─── extractPackageName ───────────────────────────────────────────────────────

describe('extractPackageName', () => {
  it('extracts a simple package name', () => {
    expect(extractPackageName('file:///app/node_modules/lodash/src/foo.js')).toBe('lodash');
  });

  it('extracts a scoped package name', () => {
    expect(extractPackageName('file:///app/node_modules/@babel/core/lib/index.js')).toBe(
      '@babel/core',
    );
  });

  it('extracts nested node_modules correctly (picks outermost match)', () => {
    expect(
      extractPackageName('file:///app/node_modules/webpack/node_modules/acorn/src/parse.js'),
    ).toBe('webpack');
  });

  it('returns null for user code', () => {
    expect(extractPackageName('file:///app/src/utils.ts')).toBeNull();
  });

  it('returns null for empty URL (native builtins)', () => {
    expect(extractPackageName('')).toBeNull();
  });

  it('returns null for node: builtins', () => {
    expect(extractPackageName('node:fs')).toBeNull();
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal cpuprofile JSON with nodes spanning two packages and user code.
 *
 * Timing layout (each sample = 10 000 µs):
 *   - lodash/chunk (id 3):      12 samples → 120 000 µs self
 *   - lodash/merge (id 4):       8 samples → 80 000 µs self
 *   - @scope/pkg/foo (id 5):    15 samples → 150 000 µs self
 *   - user code/process (id 6):  5 samples → 50 000 µs self
 *   - (idle) (id 7):            10 samples → 100 000 µs self
 */
function buildMultiPkgProfileJson() {
  const nodes = [
    {
      id: 1,
      callFrame: {
        functionName: '(root)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      hitCount: 0,
      children: [2, 7],
    },
    {
      id: 2,
      callFrame: {
        functionName: '(program)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      hitCount: 0,
      children: [3, 4, 5, 6],
    },
    {
      id: 3,
      callFrame: {
        functionName: 'chunk',
        scriptId: '1',
        url: 'file:///app/node_modules/lodash/src/chunk.js',
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: 12,
      children: [],
    },
    {
      id: 4,
      callFrame: {
        functionName: 'merge',
        scriptId: '2',
        url: 'file:///app/node_modules/lodash/src/merge.js',
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: 8,
      children: [],
    },
    {
      id: 5,
      callFrame: {
        functionName: 'transform',
        scriptId: '3',
        url: 'file:///app/node_modules/@scope/pkg/lib/transform.js',
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: 15,
      children: [],
    },
    {
      id: 6,
      callFrame: {
        functionName: 'processItems',
        scriptId: '4',
        url: 'file:///app/src/processor.js',
        lineNumber: 5,
        columnNumber: 0,
      },
      hitCount: 5,
      children: [],
    },
    {
      id: 7,
      callFrame: {
        functionName: '(idle)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      hitCount: 10,
      children: [],
    },
  ];

  // 50 samples total; distribute matching hitCounts above
  const samples: number[] = [
    ...Array(12).fill(3), // lodash/chunk
    ...Array(8).fill(4), // lodash/merge
    ...Array(15).fill(5), // @scope/pkg
    ...Array(5).fill(6), // user code
    ...Array(10).fill(7), // idle
  ];
  const timeDeltas = new Array(50).fill(10000);

  return JSON.stringify({ nodes, startTime: 0, endTime: 500000, samples, timeDeltas });
}

// ─── computePackageCosts ──────────────────────────────────────────────────────

describe('computePackageCosts', () => {
  it('aggregates self-time per package, sorted descending', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const costs = computePackageCosts(profile, 10);

    // lodash: chunk (120 000) + merge (80 000) = 200 000 µs → rank 1
    // @scope/pkg: transform (150 000) µs → rank 2
    expect(costs).toHaveLength(2);
    expect(costs[0].package).toBe('lodash');
    expect(costs[1].package).toBe('@scope/pkg');
  });

  it('lodash combined self-time equals chunk + merge', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const costs = computePackageCosts(profile, 10);
    const lodash = costs.find((c) => c.package === 'lodash')!;
    expect(lodash.selfTime).toBe(200000); // (12 + 8) * 10 000
    expect(lodash.nodeCount).toBe(2);
  });

  it('@scope/pkg scoped package is handled correctly', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const costs = computePackageCosts(profile, 10);
    const scoped = costs.find((c) => c.package === '@scope/pkg')!;
    expect(scoped).toBeDefined();
    expect(scoped.selfTime).toBe(150000); // 15 * 10 000
    expect(scoped.topFunctions[0].functionName).toBe('transform');
  });

  it('respects the limit parameter', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const costs = computePackageCosts(profile, 1);
    expect(costs).toHaveLength(1);
    expect(costs[0].package).toBe('lodash');
  });

  it('returns empty array when no node_modules frames present', () => {
    // Use the original sample fixture which has no node_modules URLs
    const noModsJson = JSON.stringify({
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: '(root)',
            scriptId: '0',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
          hitCount: 0,
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'userFn',
            scriptId: '1',
            url: 'file:///app/src/app.js',
            lineNumber: 0,
            columnNumber: 0,
          },
          hitCount: 10,
          children: [],
        },
      ],
      startTime: 0,
      endTime: 100000,
      samples: Array(10).fill(2),
      timeDeltas: new Array(10).fill(10000),
    });
    const profile = parseCpuProfile(noModsJson, 'test.cpuprofile');
    expect(computePackageCosts(profile, 10)).toHaveLength(0);
  });

  it('selfPercent sums to ≤ 100', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const costs = computePackageCosts(profile, 10);
    const total = costs.reduce((s, c) => s + c.selfPercent, 0);
    expect(total).toBeLessThanOrEqual(100);
  });
});

// ─── get_hotspots package field ───────────────────────────────────────────────

describe('getHotspots package field', () => {
  it('annotates node_modules entries with the package name', () => {
    const profile = parseCpuProfile(buildMultiPkgProfileJson(), 'test.cpuprofile');
    const hotspots = getHotspots(profile, 10);

    const chunk = hotspots.find((h) => h.functionName === 'chunk');
    expect(chunk?.package).toBe('lodash');

    const transform = hotspots.find((h) => h.functionName === 'transform');
    expect(transform?.package).toBe('@scope/pkg');

    const user = hotspots.find((h) => h.functionName === 'processItems');
    expect(user?.package).toBeNull();
  });
});
