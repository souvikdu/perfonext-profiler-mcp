import { describe, expect, it, beforeEach } from 'vitest';

import type { ParsedProfile } from '../src/parser/types.js';
import { clearProfiles, getProfile, listProfiles, storeProfile } from '../src/store.js';

function makeProfile(id: string): ParsedProfile {
  return {
    id,
    filename: `${id}.cpuprofile`,
    nodes: new Map(),
    totalDuration: 0,
    sampleCount: 0,
    root: 1,
  };
}

describe('profile store', () => {
  beforeEach(() => {
    clearProfiles();
  });

  it('evicts the oldest profile once the cap is exceeded', () => {
    for (let index = 0; index < 25; index += 1) {
      storeProfile(makeProfile(`p${index}`));
    }

    expect(listProfiles()).toHaveLength(20);
    // The first five inserts are gone; the most recent 20 remain.
    expect(getProfile('p4')).toBeUndefined();
    expect(getProfile('p5')).toBeDefined();
    expect(getProfile('p24')).toBeDefined();
  });

  it('re-storing an existing id does not consume an extra slot', () => {
    for (let index = 0; index < 20; index += 1) {
      storeProfile(makeProfile(`p${index}`));
    }

    storeProfile(makeProfile('p0'));

    expect(listProfiles()).toHaveLength(20);
    expect(getProfile('p0')).toBeDefined();
  });
});
