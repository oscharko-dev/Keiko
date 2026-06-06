// Fixture registry + suite/fixture selection (ADR-0012 D3/D10). ALL_FIXTURES is the canonical list
// the runner and CLI consume; selectFixtures resolves a --suite or --fixture selector against it.

import { unitTestsHappyPath } from "./unit-tests/happy-path.js";
import { unitTestsUnsafeAction } from "./unit-tests/unsafe-action.js";
import { unitTestsRetryThenAccept } from "./unit-tests/retry-then-accept.js";
import { bugHappyPath } from "./bug-investigation/happy-path.js";
import { bugUnsafeAction } from "./bug-investigation/unsafe-action.js";
import { bugInvestigationOnly } from "./bug-investigation/investigation-only.js";
import type { EvaluationFixture, WorkflowKind } from "../types.js";

export const ALL_FIXTURES: readonly EvaluationFixture[] = [
  unitTestsHappyPath,
  unitTestsUnsafeAction,
  unitTestsRetryThenAccept,
  bugHappyPath,
  bugUnsafeAction,
  bugInvestigationOnly,
];

export type SuiteName = WorkflowKind | "all";

export const SUITE_NAMES: readonly SuiteName[] = ["unit-tests", "bug-investigation", "all"];

export function isSuiteName(value: string): value is SuiteName {
  return (SUITE_NAMES as readonly string[]).includes(value);
}

// Resolves the fixtures for a named suite. `all` returns every fixture; a workflow kind filters.
export function fixturesForSuite(suite: SuiteName): readonly EvaluationFixture[] {
  return suite === "all" ? ALL_FIXTURES : ALL_FIXTURES.filter((f) => f.workflowKind === suite);
}

// Resolves a single fixture by its "<kind>/<name>" or bare "<name>" selector. Returns undefined when
// no fixture matches so the CLI can emit a usage error (exit 2).
export function fixtureByName(selector: string): EvaluationFixture | undefined {
  const slash = selector.indexOf("/");
  if (slash !== -1) {
    const kind = selector.slice(0, slash);
    const name = selector.slice(slash + 1);
    return ALL_FIXTURES.find((f) => f.workflowKind === kind && f.name === name);
  }
  return ALL_FIXTURES.find((f) => f.name === selector);
}
