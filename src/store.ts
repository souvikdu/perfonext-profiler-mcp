import { ParsedProfile } from './parser/types.js';

// Caps memory growth for a long-running session — a Map keeps insertion order, so evicting the
// oldest entry once we're over the cap is a cheap FIFO policy. Parsed CPU profiles are the largest
// objects this server holds.
const MAX_PROFILES = 20;

const profiles = new Map<string, ParsedProfile>();

export function storeProfile(profile: ParsedProfile): void {
  profiles.set(profile.id, profile);
  if (profiles.size > MAX_PROFILES) {
    const oldestId = profiles.keys().next().value;
    if (oldestId !== undefined) {
      profiles.delete(oldestId);
    }
  }
}

export function getProfile(id: string): ParsedProfile | undefined {
  return profiles.get(id);
}

export function listProfiles(): {
  id: string;
  filename: string;
  duration: number;
  sampleCount: number;
}[] {
  return Array.from(profiles.values()).map((p) => ({
    id: p.id,
    filename: p.filename,
    duration: p.totalDuration,
    sampleCount: p.sampleCount,
  }));
}

export function removeProfile(id: string): boolean {
  return profiles.delete(id);
}

/** Test-only teardown hook — clears all stored profiles so test order can't leak state. */
export function clearProfiles(): void {
  profiles.clear();
}
