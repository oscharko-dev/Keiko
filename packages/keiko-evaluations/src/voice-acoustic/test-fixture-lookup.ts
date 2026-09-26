// Test-support only: a fixture-lookup-or-throw helper shared by this folder's test files
// (KEIKO-0651). NOT exported from index.ts -- voice-acoustic's public barrel never carries
// test-only helpers.

import { voiceAcousticFixtureByName } from "./fixtures/index.js";
import type { VoiceAcousticFixture } from "./types.js";

export function fixture(name: string): VoiceAcousticFixture {
  const found = voiceAcousticFixtureByName(name);
  if (found === undefined) {
    throw new Error(`missing fixture ${name}`);
  }
  return found;
}
