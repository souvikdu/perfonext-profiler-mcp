import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import { readSourceContext, fileUrlToPath, isWithinCwd } from '../src/tools/read-source-context.js';

// Absolute path to the fixture source file we will reference in test profiles
const fixtureSourcePath = resolve(import.meta.dirname, 'fixtures/sample-source.js');

/**
 * Build a minimal cpuprofile JSON string whose hot node points at
 * `fixtureSourcePath` and includes positionTicks.
 */
function buildProfileJson(
  lineNumber: number,
  positionTicks: { line: number; ticks: number }[],
  functionName = 'heavyComputation',
) {
  return JSON.stringify({
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
          functionName,
          scriptId: '1',
          url: `file://${fixtureSourcePath}`,
          lineNumber, // 0-based
          columnNumber: 0,
        },
        hitCount: 20,
        children: [],
        positionTicks,
      },
    ],
    startTime: 0,
    endTime: 200000,
    samples: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    timeDeltas: new Array(20).fill(10000),
  });
}

describe('fileUrlToPath', () => {
  it('strips file:// prefix', () => {
    expect(fileUrlToPath('file:///app/src/foo.js')).toBe('/app/src/foo.js');
  });

  it('returns absolute paths as-is', () => {
    expect(fileUrlToPath('/home/user/project/src/foo.js')).toBe('/home/user/project/src/foo.js');
  });

  it('returns null for http URLs', () => {
    expect(fileUrlToPath('http://example.com/foo.js')).toBeNull();
  });

  it('returns null for node: builtins', () => {
    expect(fileUrlToPath('node:fs')).toBeNull();
  });
});

describe('isWithinCwd', () => {
  it('accepts a path inside cwd', () => {
    const inside = resolve(process.cwd(), 'src/index.ts');
    expect(isWithinCwd(inside)).toBe(true);
  });

  it('rejects a path outside cwd', () => {
    expect(isWithinCwd('/etc/passwd')).toBe(false);
  });

  it('rejects a path that traverses above cwd via ..', () => {
    const escaped = resolve(process.cwd(), '../../etc/passwd');
    expect(isWithinCwd(escaped)).toBe(false);
  });
});

describe('readSourceContext', () => {
  it('returns annotated lines centred on the function', async () => {
    // heavyComputation starts at line 2 in the fixture (0-based: 1)
    const profileJson = buildProfileJson(1, [
      { line: 4, ticks: 3 },
      { line: 5, ticks: 12 },
      { line: 6, ticks: 5 },
    ]);
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    const result = await readSourceContext(profile, 'heavyComputation', 5);

    expect(result.functionName).toBe('heavyComputation');
    expect(result.functionLine).toBe(2); // 0-based 1 → 1-based 2
    expect(result.file).toBe(fixtureSourcePath);
    expect(result.startLine).toBeGreaterThanOrEqual(1);
    expect(result.endLine).toBeGreaterThan(result.startLine);

    // Line 5 has the most ticks — it should be marked hot
    const hotLine = result.lines.find((l) => l.lineNumber === 5);
    expect(hotLine).toBeDefined();
    expect(hotLine!.ticks).toBe(12);
    expect(hotLine!.isHot).toBe(true);

    // Line 4 has fewer ticks — hot threshold is >= 50% of max (12), so 3 < 6 → not hot
    const coolLine = result.lines.find((l) => l.lineNumber === 4);
    expect(coolLine).toBeDefined();
    expect(coolLine!.ticks).toBe(3);
    expect(coolLine!.isHot).toBe(false);
  });

  it('returns lines without tick annotations when positionTicks is absent', async () => {
    const profileJson = buildProfileJson(1, []);
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    const result = await readSourceContext(profile, 'heavyComputation', 3);

    expect(result.totalTicks).toBe(0);
    expect(result.lines.every((l) => l.ticks === 0 && !l.isHot)).toBe(true);
  });

  it('throws when function is not in the profile', async () => {
    const profileJson = buildProfileJson(1, []);
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    await expect(readSourceContext(profile, 'nonExistentFn', 5)).rejects.toThrow(
      'not found in profile',
    );
  });

  it('throws when the source file URL is outside cwd', async () => {
    const profileJson = JSON.stringify({
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
            functionName: 'secretFn',
            scriptId: '1',
            url: 'file:///etc/passwd',
            lineNumber: 0,
            columnNumber: 0,
          },
          hitCount: 5,
          children: [],
        },
      ],
      startTime: 0,
      endTime: 50000,
      samples: [2, 2, 2, 2, 2],
      timeDeltas: new Array(5).fill(10000),
    });
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    await expect(readSourceContext(profile, 'secretFn', 5)).rejects.toThrow('Access denied');
  });

  it('respects contextLines parameter', async () => {
    const profileJson = buildProfileJson(1, [{ line: 5, ticks: 10 }]);
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    const narrow = await readSourceContext(profile, 'heavyComputation', 1);
    const wide = await readSourceContext(profile, 'heavyComputation', 8);

    expect(wide.lines.length).toBeGreaterThan(narrow.lines.length);
  });

  it('widens the window to cover hot lines far past the function declaration (H1 regression)', async () => {
    // longFunctionWithDistantHotLines is declared at line 14 (0-based 13) but its
    // only hot line is 28 — 14 lines below, outside the old fixed +/-10 window (ended at 24).
    const profileJson = buildProfileJson(
      13,
      [{ line: 28, ticks: 40 }],
      'longFunctionWithDistantHotLines',
    );
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    const result = await readSourceContext(profile, 'longFunctionWithDistantHotLines', 10);

    expect(result.endLine).toBeGreaterThanOrEqual(28);
    const hotLine = result.lines.find((l) => l.lineNumber === 28);
    expect(hotLine).toBeDefined();
    expect(hotLine!.ticks).toBe(40);
    expect(hotLine!.isHot).toBe(true);
    expect(result.totalTicks).toBe(40);
    expect(result.visibleTicks).toBe(40);
    expect(result.hiddenTicks).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it('reports hiddenTicks and a warning when the tick spread exceeds the window cap', async () => {
    // Must live inside the repo (not the OS tmpdir) — readSourceContext enforces isWithinCwd.
    const dir = resolve(import.meta.dirname, 'fixtures/.tmp-huge');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'huge.js');
    try {
      const lines = ['function hugeFn(data) {'];
      for (let i = 0; i < 398; i++) lines.push(`  // padding ${i}`);
      lines.push('}');
      await writeFile(filePath, lines.join('\n'), 'utf-8');

      // Ticks at line 10 and line 350 are too far apart to fit inside MAX_WINDOW_LINES (200),
      // so the far tick must be reported as hidden rather than silently dropped.
      const profileJson = JSON.stringify({
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
              functionName: 'hugeFn',
              scriptId: '1',
              url: `file://${filePath}`,
              lineNumber: 0,
              columnNumber: 0,
            },
            hitCount: 20,
            children: [],
            positionTicks: [
              { line: 10, ticks: 5 },
              { line: 350, ticks: 50 },
            ],
          },
        ],
        startTime: 0,
        endTime: 200000,
        samples: new Array(20).fill(2),
        timeDeltas: new Array(20).fill(10000),
      });
      const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

      const result = await readSourceContext(profile, 'hugeFn', 10);

      expect(result.endLine - result.startLine + 1).toBeLessThanOrEqual(200);
      expect(result.totalTicks).toBe(55);
      expect(result.hiddenTicks).toBeGreaterThan(0);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('ticks fall outside');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let ticks from a same-named function in another file pollute totals', async () => {
    const otherFileTicks = 99;
    const profileJson = JSON.stringify({
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
          children: [2, 3],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'heavyComputation',
            scriptId: '1',
            url: `file://${fixtureSourcePath}`,
            lineNumber: 1,
            columnNumber: 0,
          },
          hitCount: 20,
          children: [],
          positionTicks: [{ line: 5, ticks: 12 }],
        },
        {
          id: 3,
          callFrame: {
            functionName: 'heavyComputation',
            scriptId: '2',
            url: 'file:///some/other/file.js',
            lineNumber: 1,
            columnNumber: 0,
          },
          hitCount: 5,
          children: [],
          positionTicks: [{ line: 5, ticks: otherFileTicks }],
        },
      ],
      startTime: 0,
      endTime: 200000,
      samples: new Array(20).fill(2),
      timeDeltas: new Array(20).fill(10000),
    });
    const profile = parseCpuProfile(profileJson, 'test.cpuprofile');

    const result = await readSourceContext(profile, 'heavyComputation', 5);

    // The node with the highest hitCount (id 2, same-file) is picked as primary,
    // so only its 12 ticks should count — not the other file's 99.
    expect(result.totalTicks).toBe(12);
  });
});
