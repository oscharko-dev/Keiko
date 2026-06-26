// Voice Action Governance fixture registry (Epic #491, Issue #503). ALL_VOICE_ACTION_FIXTURES is the
// canonical list the runner and suite tests consume; the selectors resolve a category or a fixture name
// against it. Mirrors the Discussion Intelligence fixtures/index.ts layout.

import { NO_VOICE_FIXTURES } from "./no-voice.js";
import { VOICE_FIXTURES } from "./voice.js";
import { ADVERSARIAL_FIXTURES } from "./adversarial.js";
import type { VoiceActionEvalFixture, VoiceActionFixtureCategory } from "../types.js";

export const ALL_VOICE_ACTION_FIXTURES: readonly VoiceActionEvalFixture[] = [
  ...NO_VOICE_FIXTURES,
  ...VOICE_FIXTURES,
  ...ADVERSARIAL_FIXTURES,
];

export function voiceActionFixturesForCategory(
  category: VoiceActionFixtureCategory,
): readonly VoiceActionEvalFixture[] {
  return ALL_VOICE_ACTION_FIXTURES.filter((f) => f.category === category);
}

export function voiceActionFixtureByName(name: string): VoiceActionEvalFixture | undefined {
  return ALL_VOICE_ACTION_FIXTURES.find((f) => f.name === name);
}
