// Voice Session Recap fixture registry (Epic #491, Issue #504). ALL_VOICE_RECAP_FIXTURES is the canonical
// list the runner and suite tests consume; the selectors resolve a category or a fixture name against it.
// Mirrors the Voice Action Governance fixtures/index.ts layout.

import type { VoiceRecapEvalFixture, VoiceRecapFixtureCategory } from "../types.js";
import { ADVERSARIAL_FIXTURES } from "./adversarial.js";
import { NO_VOICE_FIXTURES } from "./no-voice.js";
import { VOICE_FIXTURES } from "./voice.js";

export const ALL_VOICE_RECAP_FIXTURES: readonly VoiceRecapEvalFixture[] = [
  ...NO_VOICE_FIXTURES,
  ...VOICE_FIXTURES,
  ...ADVERSARIAL_FIXTURES,
];

export function voiceRecapFixturesForCategory(
  category: VoiceRecapFixtureCategory,
): readonly VoiceRecapEvalFixture[] {
  return ALL_VOICE_RECAP_FIXTURES.filter((f) => f.category === category);
}

export function voiceRecapFixtureByName(name: string): VoiceRecapEvalFixture | undefined {
  return ALL_VOICE_RECAP_FIXTURES.find((f) => f.name === name);
}
