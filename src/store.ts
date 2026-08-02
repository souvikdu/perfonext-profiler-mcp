import { ParsedProfile } from './parser/types.js';

const profiles = new Map<string, ParsedProfile>();

export function storeProfile(profile: ParsedProfile): void {
  profiles.set(profile.id, profile);
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
