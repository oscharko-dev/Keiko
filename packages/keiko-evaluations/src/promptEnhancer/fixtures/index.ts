// Prompt Enhancer fixture registry (Epic #1307, Issue #1315). ALL_PROMPT_ENHANCER_FIXTURES is the
// canonical list the runner and suite tests consume; the selectors resolve a category or a fixture name
// against it. Mirrors the agent-trajectory fixtures/index.ts layout.

import { TASK_CLASS_FIXTURES } from "./task-classes.js";
import { GROUNDING_FIXTURES } from "./grounding.js";
import { ADVERSARIAL_FIXTURES } from "./adversarial.js";
import { FORMAT_FIXTURES } from "./format.js";
import { TOKEN_EFFICIENCY_FIXTURES } from "./token-efficiency.js";
import type { PromptEnhancerEvalFixture, PromptEnhancerFixtureCategory } from "../types.js";

export const ALL_PROMPT_ENHANCER_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  ...TASK_CLASS_FIXTURES,
  ...GROUNDING_FIXTURES,
  ...ADVERSARIAL_FIXTURES,
  ...FORMAT_FIXTURES,
  ...TOKEN_EFFICIENCY_FIXTURES,
];

export function fixturesForCategory(
  category: PromptEnhancerFixtureCategory,
): readonly PromptEnhancerEvalFixture[] {
  return ALL_PROMPT_ENHANCER_FIXTURES.filter((f) => f.category === category);
}

export function promptEnhancerFixtureByName(name: string): PromptEnhancerEvalFixture | undefined {
  return ALL_PROMPT_ENHANCER_FIXTURES.find((f) => f.name === name);
}
