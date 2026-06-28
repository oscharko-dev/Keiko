// Voice Digital Twin fixture registry (Epic #491, Issue #505). ALL_VOICE_TWIN_FIXTURES is the canonical
// list the runner and suite tests consume; the selectors resolve a category or a fixture name against it.
// Mirrors the Voice Action fixtures/index.ts layout.

import { NO_VOICE_FIXTURES } from "./no-voice.js";
import { STT_ONLY_FIXTURES } from "./stt-only.js";
import { SPEECH_OUTPUT_FIXTURES } from "./speech-output.js";
import { FULL_REALTIME_FIXTURES } from "./full-realtime.js";
import { PRIVACY_FIXTURES } from "./privacy.js";
import type { VoiceTwinFixture, VoiceTwinFixtureCategory } from "../types.js";

export const ALL_VOICE_TWIN_FIXTURES: readonly VoiceTwinFixture[] = [
  ...NO_VOICE_FIXTURES,
  ...STT_ONLY_FIXTURES,
  ...SPEECH_OUTPUT_FIXTURES,
  ...FULL_REALTIME_FIXTURES,
  ...PRIVACY_FIXTURES,
];

export function voiceTwinFixturesForCategory(
  category: VoiceTwinFixtureCategory,
): readonly VoiceTwinFixture[] {
  return ALL_VOICE_TWIN_FIXTURES.filter((f) => f.category === category);
}

export function voiceTwinFixtureByName(name: string): VoiceTwinFixture | undefined {
  return ALL_VOICE_TWIN_FIXTURES.find((f) => f.name === name);
}
