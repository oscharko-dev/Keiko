import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

// #3389 — read-only journey observation/reconciliation. Reuses the #3387 draft-delivery fixture's
// server, repository and confirmed-PR machinery (same state directory, coordinated through
// KEIKO_E2E_STATE_DIR) and adds only the journey GraphQL read fixture on top of it.

export const HANDOFF_PORT = 32591;

export function handoffStateDir(): string {
  return e2eStateDir("coding-issue-handoff-3389");
}

export function handoffProviderPath(stateDir: string): string {
  return join(stateDir, "handoff-provider.json");
}

/**
 * The bounded outcomes this fixture's `gh api graphql` response can take, keyed to the acceptance
 * criteria this lane proves:
 *  - "open"                 — the confirmed draft PR observed unchanged (no merge, no closure).
 *  - "blocked-review"       — a non-draft PR carrying unresolved conversations / requested changes;
 *                              readiness/description are not yet produced by this lane (#3399 has
 *                              not landed a production description-apply path this wave), so the
 *                              assertion this mode proves is narrower than the full reviewer-blocked
 *                              reason: the outcome never reports a false ready/completed state.
 *  - "merged-open"          — a human merge is observed; the bound issue is still open.
 *  - "merged-closed"        — a human merge AND the bound issue's closure are both observed.
 *  - "closed-unmerged"      — the PR was closed without an observed merge.
 */
export const HANDOFF_MODES = [
  "open",
  "blocked-review",
  "merged-open",
  "merged-closed",
  "closed-unmerged",
] as const;
export type HandoffFixtureMode = (typeof HANDOFF_MODES)[number];

export interface HandoffProviderState {
  readonly mode: HandoffFixtureMode;
  readonly reads: number;
  readonly deniedCalls: number;
}
