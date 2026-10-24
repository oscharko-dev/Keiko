import type { CodingWorkbenchRuntimeFailureCode } from "@oscharko-dev/keiko-contracts";

/**
 * The turn-revert vocabulary every layer of the Workbench shares (B3, S04): the runtime port that
 * does the work, the dispatcher that admits it, the coordinator that serializes it and the route
 * that answers it. Pure data, so no layer imports another to name a refusal.
 *
 * Why an undo only STAGES the runtime's revert while the run is live: committing deletes the
 * rewound messages from the session, and Keiko's history reconciliation is append-only per session
 * (a message that reappears at an already-seen position with another digest fails the run). A
 * staged revert keeps the history intact, restores the files, and stays recoverable. Only when the
 * post-completion undo window closes (#3904 AC3), after the run settled and its history was
 * captured, is a staged undo committed, so the retained session matches the workspace.
 */
export const CODING_RUNTIME_REVERT_REFUSALS = [
  "already-staged",
  "interrupt-failed",
  "not-admitted",
  "nothing-staged",
  "nothing-to-undo",
  "revert-failed",
  "run-unavailable",
  "turn-blocked",
  "turn-boundary-missing",
  "unsupported",
  "workspace-changed",
] as const;

export type CodingRuntimeRevertRefusal = (typeof CODING_RUNTIME_REVERT_REFUSALS)[number];

/**
 * Who started a turn the operator did not: Keiko's automatic verification continuation. Such a turn
 * continues the human's accepted request, so an undo of the newest turn reaches back across it to
 * that request (#3904 AC3).
 */
export type CodingRuntimeTurnOrigin = "verification-continuation";

export interface CodingRuntimeRevertCounts {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface CodingRuntimeRevertState extends CodingRuntimeRevertCounts {
  readonly staged: boolean;
}

export type CodingRuntimeRevertResult =
  | ({ readonly ok: true } & CodingRuntimeRevertCounts)
  | { readonly ok: false; readonly reason: CodingRuntimeRevertRefusal };

type RevertFailureCode = Extract<
  CodingWorkbenchRuntimeFailureCode,
  "authority-resolution-failed" | "invalid-intent" | "runtime-failed"
>;

/**
 * The failure code each refusal answers with. A refusal that states a fact about the request or the
 * run's current state is the request's own (`invalid-intent`); one the authority guard made is an
 * authority failure; everything else is the runtime failing. A record keyed by the closed refusal
 * list, so a new refusal cannot be added without choosing its answer.
 */
const REVERT_REFUSAL_FAILURE_CODES = {
  "already-staged": "invalid-intent",
  "interrupt-failed": "runtime-failed",
  "not-admitted": "authority-resolution-failed",
  "nothing-staged": "invalid-intent",
  "nothing-to-undo": "invalid-intent",
  "revert-failed": "runtime-failed",
  "run-unavailable": "runtime-failed",
  "turn-blocked": "runtime-failed",
  "turn-boundary-missing": "invalid-intent",
  unsupported: "invalid-intent",
  "workspace-changed": "invalid-intent",
} as const satisfies Record<CodingRuntimeRevertRefusal, RevertFailureCode>;

export function revertRefusalFailureCode(reason: CodingRuntimeRevertRefusal): RevertFailureCode {
  return REVERT_REFUSAL_FAILURE_CODES[reason];
}
