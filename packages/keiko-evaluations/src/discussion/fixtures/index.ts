// Discussion Intelligence fixture registry (Epic #491, Issue #502). ALL_DISCUSSION_FIXTURES is the
// canonical list the runner and suite tests consume; the selectors resolve a category or a fixture name
// against it. Mirrors the Prompt Enhancer fixtures/index.ts layout.

import { NO_VOICE_FIXTURES } from "./no-voice.js";
import { VOICE_FIXTURES } from "./voice.js";
import { CORRECTION_FIXTURES } from "./correction.js";
import type { DiscussionEvalFixture, DiscussionFixtureCategory } from "../types.js";

export const ALL_DISCUSSION_FIXTURES: readonly DiscussionEvalFixture[] = [
  ...NO_VOICE_FIXTURES,
  ...VOICE_FIXTURES,
  ...CORRECTION_FIXTURES,
];

export function discussionFixturesForCategory(
  category: DiscussionFixtureCategory,
): readonly DiscussionEvalFixture[] {
  return ALL_DISCUSSION_FIXTURES.filter((f) => f.category === category);
}

export function discussionFixtureByName(name: string): DiscussionEvalFixture | undefined {
  return ALL_DISCUSSION_FIXTURES.find((f) => f.name === name);
}
