import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import {
  extractPackageName,
  getHotspots,
  buildCallTree,
  getCallersOf,
  getCalleesOf,
} from '../src/parser/call-tree.js';

const fixturePath = resolve(import.meta.dirname, 'fixtures/sample.cpuprofile');

describe('cpuprofile parser', () => {
  it('parses a valid .cpuprofile file', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    expect(profile.filename).toBe('sample.cpuprofile');
    expect(profile.nodes.size).toBe(7);
    expect(profile.sampleCount).toBe(50);
    expect(profile.totalDuration).toBe(500000);
    expect(profile.id).toBeTruthy();
  });

  it('calculates self-time from samples', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    // JSON.parse node (id 4) should have significant self-time (many samples land on it)
    const jsonParseNode = profile.nodes.get(4)!;
    expect(jsonParseNode.callFrame.functionName).toBe('JSON.parse');
    expect(jsonParseNode.selfTime).toBeGreaterThan(0);

    // (idle) node (id 7) should have self-time
    const idleNode = profile.nodes.get(7)!;
    expect(idleNode.callFrame.functionName).toBe('(idle)');
    expect(idleNode.selfTime).toBeGreaterThan(0);
  });

  it('calculates total-time correctly (parent >= child)', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    const processData = profile.nodes.get(3)!;
    const jsonParse = profile.nodes.get(4)!;

    // processData's total time should include its children's time
    expect(processData.totalTime).toBeGreaterThanOrEqual(jsonParse.totalTime);
  });

  it('rejects invalid profile data', () => {
    expect(() => parseCpuProfile('{}', 'bad.cpuprofile')).toThrow('Invalid profile format');
  });

  it('canonicalizes Windows filesystem paths to POSIX file:// at ingest', () => {
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
              functionName: 'chunk',
              scriptId: '1',
              url: 'C:\\proj\\node_modules\\lodash\\index.js',
              lineNumber: 0,
              columnNumber: 0,
            },
            hitCount: 1,
            children: [],
          },
        ],
        startTime: 0,
        endTime: 10000,
        samples: [2],
        timeDeltas: [10000],
      }),
      'win.cpuprofile',
    );

    const url = profile.nodes.get(2)!.callFrame.url;
    expect(url).toBe('file:///C:/proj/node_modules/lodash/index.js');
    expect(extractPackageName(url)).toBe('lodash');
  });
});

describe('call-tree analysis', () => {
  it('returns hotspots sorted by self-time', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    const hotspots = getHotspots(profile, 5);
    expect(hotspots.length).toBeGreaterThan(0);

    // Should be sorted by self-time descending
    for (let i = 1; i < hotspots.length; i++) {
      expect(hotspots[i - 1].selfTime).toBeGreaterThanOrEqual(hotspots[i].selfTime);
    }

    // Should not include (idle) or (root)
    expect(hotspots.every((h) => h.functionName !== '(idle)' && h.functionName !== '(root)')).toBe(
      true,
    );
  });

  it('builds a call tree', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    const tree = buildCallTree(profile, undefined, 3);
    expect(tree.functionName).toBe('(root)');
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it('finds callers and callees', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');

    const callers = getCallersOf(profile, 'JSON.parse');
    expect(callers.length).toBe(1);
    expect(callers[0].callFrame.functionName).toBe('processData');

    const callees = getCalleesOf(profile, 'processData');
    expect(callees.length).toBe(2); // JSON.parse and transformResult
  });
});

const traceFixturePath = resolve(import.meta.dirname, 'fixtures/sample-trace.json');

describe('Chrome Trace JSON parser', () => {
  it('parses a Chrome trace export and extracts CPU profile', async () => {
    const content = await readFile(traceFixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample-trace.json');

    expect(profile.filename).toBe('sample-trace.json');
    expect(profile.nodes.size).toBe(6);
    expect(profile.sampleCount).toBe(20);
    expect(profile.totalDuration).toBe(200000);
  });

  it('reconstructs children from parent references in trace format', async () => {
    const content = await readFile(traceFixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample-trace.json');

    // Root should have children: main and (idle)
    const root = profile.nodes.get(1)!;
    expect(root.children.length).toBe(2);

    // main should have children: render and JSON.parse
    const main = profile.nodes.get(2)!;
    expect(main.callFrame.functionName).toBe('main');
    expect(main.children.length).toBe(2);
  });

  it('calculates self-time correctly from reassembled chunks', async () => {
    const content = await readFile(traceFixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample-trace.json');

    const hotspots = getHotspots(profile, 10);
    // JSON.parse, layout, render, and main should all have self-time
    const names = hotspots.map((h) => h.functionName);
    expect(names).toContain('JSON.parse');
    expect(names).toContain('layout');
  });
});
