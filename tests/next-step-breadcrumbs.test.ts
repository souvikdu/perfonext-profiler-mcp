import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCpuProfile } from '../src/parser/cpuprofile.js';
import { storeProfile, removeProfile } from '../src/store.js';
import { registerLoadProfile } from '../src/tools/load-profile.js';
import { registerGetHotspots } from '../src/tools/get-hotspots.js';
import { createToolHandlerStub } from './helpers/tool-stub.js';

const fixturePath = resolve(import.meta.dirname, 'fixtures/sample.cpuprofile');

describe('load_profile nextStep breadcrumb', () => {
  let loadedProfileId: string | undefined;
  afterEach(() => {
    if (loadedProfileId) removeProfile(loadedProfileId);
    loadedProfileId = undefined;
  });

  it('points at get_hotspots with the newly loaded profileId', async () => {
    const { server, call } = createToolHandlerStub();
    registerLoadProfile(server);

    const result = await call('load_profile', { filePath: fixturePath });
    const payload = JSON.parse(result.content[0].text as string);
    loadedProfileId = payload.profileId;

    expect(payload.nextStep).toContain('get_hotspots');
    expect(payload.nextStep).toContain(payload.profileId);
  });
});

describe('get_hotspots nextStep breadcrumb', () => {
  const profileId = 'nextstep-fixture';
  afterEach(() => removeProfile(profileId));

  it('points at explain_function with the current profileId', async () => {
    const content = await readFile(fixturePath, 'utf-8');
    const profile = parseCpuProfile(content, 'sample.cpuprofile');
    storeProfile({ ...profile, id: profileId });

    const { server, call } = createToolHandlerStub();
    registerGetHotspots(server);

    const result = await call('get_hotspots', { profileId, limit: 5 });
    const payload = JSON.parse(result.content[0].text as string);

    expect(payload.nextStep).toContain('explain_function');
    expect(payload.nextStep).toContain(profileId);
  });
});
