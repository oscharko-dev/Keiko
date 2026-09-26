// Fixture registry + suite/fixture selection (ADR-0012 D3/D10). ALL_FIXTURES is the canonical list
// the runner and CLI consume; fixturesForSuite and fixtureByName resolve a --suite or --fixture
// selector against it.

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

// Result of resolving a --fixture selector (KEIKO-0533, #3310). A bare "<name>" selector can match
// more than one fixture when the same name is reused across workflow kinds (e.g. "happy-path" exists
// under both unit-tests and bug-investigation) — "ambiguous" surfaces that distinguishably instead of
// silently returning ALL_FIXTURES' first match, so the CLI can fail closed per AGENTS.md §7.
export type FixtureLookupResult =
  | { readonly status: "found"; readonly fixture: EvaluationFixture }
  | { readonly status: "not-found" }
  | { readonly status: "ambiguous"; readonly matches: readonly EvaluationFixture[] };

// Resolves a single fixture by its "<kind>/<name>" or bare "<name>" selector. The "<kind>/<name>"
// form is always unambiguous (workflowKind + name is unique per fixture). The bare form returns
// "ambiguous" with every match when more than one fixture shares that name across workflow kinds.
export function fixtureByName(selector: string): FixtureLookupResult {
  const slash = selector.indexOf("/");
  if (slash !== -1) {
    const kind = selector.slice(0, slash);
    const name = selector.slice(slash + 1);
    const fixture = ALL_FIXTURES.find((f) => f.workflowKind === kind && f.name === name);
    return fixture === undefined ? { status: "not-found" } : { status: "found", fixture };
  }
  const matches = ALL_FIXTURES.filter((f) => f.name === selector);
  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  const [fixture] = matches;
  return fixture === undefined ? { status: "not-found" } : { status: "found", fixture };
}
