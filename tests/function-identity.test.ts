import { describe, it, expect, afterEach } from 'vitest';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import { storeProfile, removeProfile } from '../src/store.js';
import { describeFrameOrigin, frameKey, getCallersOf } from '../src/parser/call-tree.js';
import { computePackageCosts } from '../src/tools/get-package-costs.js';
import { registerGetHotspots } from '../src/tools/get-hotspots.js';
import { registerExplainFunction } from '../src/tools/explain-function.js';
import { registerCompareProfiles } from '../src/tools/compare-profiles.js';
import { createToolHandlerStub } from './helpers/tool-stub.js';

const GEO_URL = 'file:///app/src/geo.js';
const UTIL_URL = 'file:///app/src/util.js';

/**
 * A profile where one function is sampled under two different callers, two unrelated
 * anonymous functions share a file, and one frame is a native builtin with no URL.
 *
 * Sample budget (10 000 µs each):
 *   findNearby under renderList (id 4):  10 → 100 000 µs
 *   findNearby under renderMap  (id 6):   6 →  60 000 µs
 *   readFileUtf8, native        (id 7):   4 →  40 000 µs
 *   (anonymous) util.js:4       (id 8):   3 →  30 000 µs
 *   (anonymous) util.js:81      (id 9):   2 →  20 000 µs
 */
function buildProfileJson(findNearbyExtraSamples = 0) {
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
      children: [2],
    },
    {
      id: 2,
      callFrame: {
        functionName: 'main',
        scriptId: '1',
        url: 'file:///app/src/main.js',
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: 0,
      children: [3, 5, 7, 8, 9],
    },
    {
      id: 3,
      callFrame: {
        functionName: 'renderList',
        scriptId: '1',
        url: 'file:///app/src/main.js',
        lineNumber: 20,
        columnNumber: 0,
      },
      hitCount: 0,
      children: [4],
    },
    {
      id: 4,
      callFrame: {
        functionName: 'findNearby',
        scriptId: '2',
        url: GEO_URL,
        lineNumber: 8,
        columnNumber: 0,
      },
      hitCount: 10 + findNearbyExtraSamples,
      children: [],
    },
    {
      id: 5,
      callFrame: {
        functionName: 'renderMap',
        scriptId: '1',
        url: 'file:///app/src/main.js',
        lineNumber: 40,
        columnNumber: 0,
      },
      hitCount: 0,
      children: [6],
    },
    {
      id: 6,
      callFrame: {
        functionName: 'findNearby',
        scriptId: '2',
        url: GEO_URL,
        lineNumber: 8,
        columnNumber: 0,
      },
      hitCount: 6,
      children: [],
    },
    {
      id: 7,
      callFrame: {
        functionName: 'readFileUtf8',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      hitCount: 4,
      children: [],
    },
    {
      id: 8,
      callFrame: {
        functionName: '(anonymous)',
        scriptId: '3',
        url: UTIL_URL,
        lineNumber: 3,
        columnNumber: 0,
      },
      hitCount: 3,
      children: [],
    },
    {
      id: 9,
      callFrame: {
        functionName: '(anonymous)',
        scriptId: '3',
        url: UTIL_URL,
        lineNumber: 80,
        columnNumber: 0,
      },
      hitCount: 2,
      children: [],
    },
  ];

  const samples: number[] = [
    ...Array(10 + findNearbyExtraSamples).fill(4),
    ...Array(6).fill(6),
    ...Array(4).fill(7),
    ...Array(3).fill(8),
    ...Array(2).fill(9),
  ];
  const timeDeltas = new Array(samples.length).fill(10000);

  return JSON.stringify({
    nodes,
    startTime: 0,
    endTime: samples.length * 10000,
    samples,
    timeDeltas,
  });
}

describe('frame identity', () => {
  it('treats name, file and declaration line as one identity', () => {
    const frame = {
      functionName: 'f',
      scriptId: '1',
      url: GEO_URL,
      lineNumber: 8,
      columnNumber: 0,
    };
    expect(frameKey(frame)).toBe(`f::${GEO_URL}::8`);
    expect(frameKey({ ...frame, lineNumber: 9 })).not.toBe(frameKey(frame));
  });

  it('labels frames without a URL as native rather than user code', () => {
    expect(describeFrameOrigin('')).toBe('(native)');
    expect(describeFrameOrigin(GEO_URL)).toBe('(user code)');
    expect(describeFrameOrigin('file:///app/node_modules/lodash/index.js')).toBe('lodash');
  });
});

describe('get_hotspots aggregation', () => {
  const profileId = 'identity-fixture';
  afterEach(() => removeProfile(profileId));

  it('reports a function sampled under several callers as a single row', async () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerGetHotspots(server);
    const payload = JSON.parse(
      (await call('get_hotspots', { profileId, limit: 10 })).content[0].text as string,
    );

    const findNearby = payload.hotspots.filter(
      (h: { function: string }) => h.function === 'findNearby',
    );
    expect(findNearby).toHaveLength(1);
    // 100 000 + 60 000 µs, both call sites merged
    expect(findNearby[0].selfTime).toBe('160.0ms');
    expect(findNearby[0].occurrences).toBe(2);
    expect(findNearby[0].line).toBe(9);
  });

  it('agrees with explain_function on the same function', async () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerGetHotspots(server);
    registerExplainFunction(server);

    const hotspots = JSON.parse(
      (await call('get_hotspots', { profileId, limit: 10 })).content[0].text as string,
    );
    const explained = JSON.parse(
      (await call('explain_function', { profileId, functionName: 'findNearby' })).content[0]
        .text as string,
    );

    const row = hotspots.hotspots.find((h: { function: string }) => h.function === 'findNearby');
    expect(row.selfTime).toBe(explained.selfTime);
    expect(row.occurrences).toBe(explained.occurrences);
  });

  it('keeps unrelated anonymous functions in one file apart', async () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerGetHotspots(server);
    const payload = JSON.parse(
      (await call('get_hotspots', { profileId, limit: 10 })).content[0].text as string,
    );

    const anon = payload.hotspots.filter((h: { function: string }) => h.function === '(anonymous)');
    expect(anon).toHaveLength(2);
    expect(anon.map((h: { line: number }) => h.line).sort((a: number, b: number) => a - b)).toEqual(
      [4, 81],
    );
  });

  it('buckets URL-less builtins as native', async () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerGetHotspots(server);
    const payload = JSON.parse(
      (await call('get_hotspots', { profileId, limit: 10 })).content[0].text as string,
    );

    const native = payload.hotspots.find(
      (h: { function: string }) => h.function === 'readFileUtf8',
    );
    expect(native.package).toBe('(native)');
  });
});

describe('explain_function locations', () => {
  const profileId = 'identity-locations';
  afterEach(() => removeProfile(profileId));

  it('lists each source location once', async () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerExplainFunction(server);
    const payload = JSON.parse(
      (await call('explain_function', { profileId, functionName: 'findNearby' })).content[0]
        .text as string,
    );

    expect(payload.occurrences).toBe(2);
    expect(payload.locations).toEqual([{ file: GEO_URL, line: 9 }]);
    expect(payload.callers.map((c: { function: string }) => c.function).sort()).toEqual([
      'renderList',
      'renderMap',
    ]);
    expect(payload.callers[0]).toHaveProperty('callerTotalTime');
  });
});

describe('getCallersOf deduplication', () => {
  it('reports one row per distinct caller', () => {
    const profile = parseCpuProfile(buildProfileJson(), 'test.cpuprofile');
    const callers = getCallersOf(profile, 'findNearby');
    expect(callers).toHaveLength(2);
    expect(callers.every((c) => c.occurrences === 1)).toBe(true);
  });
});

describe('package cost top functions', () => {
  it('names the total-time field for what it measures', () => {
    const profile = parseCpuProfile(
      JSON.stringify({
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
              functionName: 'sortBy',
              scriptId: '1',
              url: 'file:///app/node_modules/lodash/sortBy.js',
              lineNumber: 3,
              columnNumber: 0,
            },
            hitCount: 2,
            children: [3],
          },
          {
            id: 3,
            callFrame: {
              functionName: 'comparator',
              scriptId: '2',
              url: 'file:///app/src/sort.js',
              lineNumber: 11,
              columnNumber: 0,
            },
            hitCount: 8,
            children: [],
          },
        ],
        startTime: 0,
        endTime: 100000,
        samples: [...Array(2).fill(2), ...Array(8).fill(3)],
        timeDeltas: new Array(10).fill(10000),
      }),
      'test.cpuprofile',
    );

    const [lodash] = computePackageCosts(profile, 10);
    expect(lodash.package).toBe('lodash');
    expect(lodash.selfTime).toBe(20000);
    // The callback into user code is counted here but not in selfTime
    expect(lodash.totalTimeIncludingCallbacks).toBe(100000);
    expect(lodash.topFunctions[0]).toMatchObject({ functionName: 'sortBy', lineNumber: 4 });
  });
});

describe('compare_profiles identity', () => {
  const baseId = 'identity-base';
  const compareId = 'identity-compare';
  afterEach(() => {
    removeProfile(baseId);
    removeProfile(compareId);
  });

  it('reports the source location of each change and keeps same-named functions apart', async () => {
    storeProfile({ ...parseCpuProfile(buildProfileJson(), 'base.cpuprofile'), id: baseId });
    storeProfile({ ...parseCpuProfile(buildProfileJson(20), 'after.cpuprofile'), id: compareId });

    const { server, call } = createToolHandlerStub();
    registerCompareProfiles(server);
    const payload = JSON.parse(
      (
        await call('compare_profiles', {
          baseProfileId: baseId,
          compareProfileId: compareId,
          limit: 10,
        })
      ).content[0].text as string,
    );

    const regressed = payload.topChanges.find(
      (c: { function: string }) => c.function === 'findNearby',
    );
    expect(regressed.file).toBe(GEO_URL);
    expect(regressed.line).toBe(9);
    expect(regressed.status).toBe('slower');
    expect(regressed.delta).toBe('+200.0ms');

    // Anonymous frames are now scoped to a file instead of being pooled globally
    const anon = payload.topChanges.filter(
      (c: { function: string }) => c.function === '(anonymous)',
    );
    expect(anon.every((c: { file: string }) => c.file === UTIL_URL)).toBe(true);
    expect(payload.identityNote).toContain('name and file');
  });
});
