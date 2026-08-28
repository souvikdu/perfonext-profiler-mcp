import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerLoadProfile, formatLoadProfileError } from '../src/tools/load-profile.js';
import { registerGetProfileSummary } from '../src/tools/get-profile-summary.js';
import { removeProfile } from '../src/store.js';
import { createToolHandlerStub } from './helpers/tool-stub.js';

const fixturePath = resolve(import.meta.dirname, 'fixtures/sample.cpuprofile');

describe('load_profile error handling', () => {
  let loadedProfileId: string | undefined;
  afterEach(() => {
    if (loadedProfileId) removeProfile(loadedProfileId);
    loadedProfileId = undefined;
  });

  it('loads a valid fixture without error', async () => {
    const { server, call } = createToolHandlerStub();
    registerLoadProfile(server);

    const result = await call('load_profile', { filePath: fixturePath });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text as string);
    loadedProfileId = payload.profileId;
    expect(payload.sampleCount).toBe(50);
  });

  it('returns a clear error for a missing file, not a raw ENOENT', async () => {
    const { server, call } = createToolHandlerStub();
    registerLoadProfile(server);

    const result = await call('load_profile', { filePath: '/tmp/does-not-exist.cpuprofile' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No file found');
    expect(result.content[0].text).not.toContain('ENOENT');
  });

  it('returns a clear error when pointed at a directory, without enumerating its contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perfonext-load-profile-'));
    try {
      const { server, call } = createToolHandlerStub();
      registerLoadProfile(server);

      const result = await call('load_profile', { filePath: dir });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('is a directory');
      expect(result.content[0].text).toContain('single profile file path');
      expect(result.content[0].text).not.toContain('EISDIR');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a clear error for malformed JSON, not a raw SyntaxError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perfonext-load-profile-'));
    const badFile = join(dir, 'broken.cpuprofile');
    try {
      await writeFile(badFile, '{ "nodes": [', 'utf-8');

      const { server, call } = createToolHandlerStub();
      registerLoadProfile(server);

      const result = await call('load_profile', { filePath: badFile });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not valid JSON');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a clear error for valid JSON with no usable profile data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perfonext-load-profile-'));
    const badFile = join(dir, 'empty-shape.cpuprofile');
    try {
      await writeFile(badFile, JSON.stringify({ foo: 'bar' }), 'utf-8');

      const { server, call } = createToolHandlerStub();
      registerLoadProfile(server);

      const result = await call('load_profile', { filePath: badFile });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('missing nodes, samples, or timeDeltas');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a clear error for an empty nodes array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perfonext-load-profile-'));
    const badFile = join(dir, 'no-nodes.cpuprofile');
    try {
      await writeFile(
        badFile,
        JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 }),
        'utf-8',
      );

      const { server, call } = createToolHandlerStub();
      registerLoadProfile(server);

      const result = await call('load_profile', { filePath: badFile });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no call-tree nodes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('succeeds without crashing on a profile with zero samples and dangling child ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perfonext-load-profile-'));
    const zeroSampleFile = join(dir, 'zero-sample.cpuprofile');
    try {
      // Mirrors the testbed X2 fixture: one root node whose children reference ids
      // that never appear as node objects, plus empty samples/timeDeltas.
      await writeFile(
        zeroSampleFile,
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
              children: [2, 3, 40],
            },
          ],
          startTime: 0,
          endTime: 0,
          samples: [],
          timeDeltas: [],
        }),
        'utf-8',
      );

      const { server, call } = createToolHandlerStub();
      registerLoadProfile(server);
      registerGetProfileSummary(server);

      const result = await call('load_profile', { filePath: zeroSampleFile });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text as string);
      loadedProfileId = payload.profileId;
      expect(payload.sampleCount).toBe(0);

      // Verify get_profile_summary returns a zero-valued summary without throwing TypeError
      const summaryResult = await call('get_profile_summary', { profileId: loadedProfileId });
      expect(summaryResult.isError).toBeFalsy();
      const summaryPayload = JSON.parse(summaryResult.content[0].text as string);
      expect(summaryPayload.idlePercent).toBe('0.0%');
      expect(summaryPayload.activePercent).toBe('0.0%');
      expect(summaryPayload.callTree.children).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('formatLoadProfileError', () => {
  it('maps ENOENT to a friendly message', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENOENT' });
    expect(formatLoadProfileError(err, '/x/y.cpuprofile')).toContain('No file found');
  });

  it('maps EISDIR to a friendly message', () => {
    const err = Object.assign(new Error('boom'), { code: 'EISDIR' });
    expect(formatLoadProfileError(err, '/x/dir')).toContain('is a directory');
  });

  it('maps SyntaxError to a friendly message', () => {
    expect(formatLoadProfileError(new SyntaxError('bad json'), '/x/y.json')).toContain(
      'not valid JSON',
    );
  });

  it('falls back to the original message for unrecognized errors', () => {
    expect(formatLoadProfileError(new Error('weird failure'), '/x/y.cpuprofile')).toContain(
      'weird failure',
    );
  });
});
