// Sizing of the Reviewer's diff budget (Issue #4136) and the dry-run estimate.
//
// The review task must fit OpenCode's first-prompt bound (`REVIEW_TASK_MAX_BYTES`, 64 KiB); a
// larger task is refused (`task-too-large`), never truncated. The rules file is read from the base
// commit only after the package is built, so the budget reserves room for the largest admitted
// rules file and the fixed task framing. The gateway estimator counts at least one token per 3.5
// UTF-8 bytes plus a structural overhead of two, so a package of at most `B` estimated tokens has
// at most `3.5 * (B - 2)` bytes: the budget is the largest `B` whose byte ceiling fits the room.

import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  REVIEW_RULES_FILE_MAX_BYTES,
  REVIEW_RUN_MAX_CANDIDATE_REPORTS,
  type ReviewRunEstimate,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { COUNTER_CHECK_INSTRUCTION } from "../counter-check/prompt.js";
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TASK_MAX_BYTES,
  renderReviewTask,
} from "../runtime/reviewPrompt.js";

/** The estimator's most UTF-8 bytes per counted token (`TOKEN_BASE_BYTES_PER_TOKEN_DIVISOR`). */
export const REVIEW_ESTIMATOR_MAX_BYTES_PER_TOKEN = 3.5;
const ESTIMATOR_STRUCTURAL_TOKENS = 2;
const OVERHEAD_NONCE = "000000000000";
/** A typical rendered diff line (line number, marker and code) for the dry-run estimate. */
const ESTIMATE_DIFF_LINE = `${"0".repeat(5)} +${"x".repeat(56)}\n`;
/** Model turns a counter-check typically spends (read, search, read, verdict). */
const ESTIMATE_COUNTER_CHECK_TURNS = 4;
const ESTIMATE_CANDIDATE_BYTES = 2048;

/** The fixed bytes of a review task around its diff package, with the largest rules file. */
function reviewTaskOverheadBytes(baseSha: string, headSha: string): number {
  const task = renderReviewTask({
    baseSha,
    headSha,
    rules: { outcome: "loaded", text: "r".repeat(REVIEW_RULES_FILE_MAX_BYTES) },
    diffPackageText: "",
    nonce: OVERHEAD_NONCE,
  });
  if (!task.ok) throw new RangeError("review task framing exceeds the first-prompt bound");
  return task.byteCount;
}

/** The largest diff package token budget whose byte ceiling fits the review task's free room. */
export function reviewDiffBudgetTokens(baseSha: string, headSha: string): number {
  const room = REVIEW_TASK_MAX_BYTES - reviewTaskOverheadBytes(baseSha, headSha);
  return (
    Math.max(0, Math.floor(room / REVIEW_ESTIMATOR_MAX_BYTES_PER_TOKEN)) +
    ESTIMATOR_STRUCTURAL_TOKENS
  );
}

/**
 * The dry-run estimate from the gateway estimator: the Reviewer's system prompt plus the changed
 * lines as typical diff lines (bounded by the package budget), and the Counter-checker's instruction,
 * a candidate and its reads over a typical number of turns for the most candidates a run may file.
 */
export function estimateReviewRun(
  changedLines: number,
  diffBudgetTokens: number,
  medianDurationMs: number | null,
): ReviewRunEstimate {
  const perLine = countContextTokens(ESTIMATE_DIFF_LINE) - ESTIMATOR_STRUCTURAL_TOKENS;
  const diffTokens = Math.min(diffBudgetTokens, Math.max(0, changedLines) * perLine);
  const counterCheckTask = countContextTokens(
    `${COUNTER_CHECK_INSTRUCTION}${"c".repeat(ESTIMATE_CANDIDATE_BYTES)}`,
  );
  return {
    changedLines,
    estimatedInputTokens: {
      reviewer: countContextTokens(REVIEW_SYSTEM_PROMPT) + diffTokens,
      counterChecker:
        REVIEW_RUN_MAX_CANDIDATE_REPORTS * ESTIMATE_COUNTER_CHECK_TURNS * counterCheckTask,
    },
    estimatedDurationMs: medianDurationMs,
  };
}
