// #3390 — the mark-ready-intent scenario. Drives the REAL "Issue handoff" journey card already
// mounted inside the Coding Workbench window (`CodingWorkbenchJourneyOutcome.tsx`): "Refresh
// observed status" re-reads the real GitHub facts through `/api/git-delivery/journey/refresh`, and
// "Review ready-for-review request" mints then immediately redeems the one-use pr-mark-ready
// approval (`createPrMarkReadyProposeHandler`) -- the SAME governed routes the scripted
// `coding-issue-handoff.spec.ts` sibling drives directly through the API. This module drives them
// through the UI instead, since the operator-facing control is what issue #3390's "propose ready"
// scenario qualifies. Only proposes ready: the human merge stays a separate checkpoint (issue
// #3390 AC5) -- this module never calls a merge or issue-close route.

import { expect, type Locator, type Page } from "@playwright/test";
import type { GitDeliveryExecutionErrorCode } from "@oscharko-dev/keiko-contracts";
import { isGitDeliveryExecutionErrorCode } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import {
  clickWhenActionable,
  journeyRefresher,
  raiseWorkbench,
} from "./coding-issue-journey-live.js";

const JOURNEY_REGION_NAME = "Issue handoff";
const REFRESH_BUTTON_NAME = "Refresh observed status";
const PROPOSE_BUTTON_NAME = "Review ready-for-review request";
const MARK_READY_EXECUTE_ENDPOINT = "/api/git-delivery/pr/mark-ready/execute";
/** Execution error codes (the contract's closed vocabulary) that mean the provider could not be
 * reached or did not answer in time: `GIT_PR_REJECTION_ERROR_CODE` maps rate-limited and
 * provider-unavailable rejections to network-failure, and a timed-out dispatch to timeout. */
const TRANSIENT_MARK_READY_CODES: ReadonlySet<GitDeliveryExecutionErrorCode> =
  new Set<GitDeliveryExecutionErrorCode>(["network-failure", "timeout"]);
const MARK_READY_ATTEMPTS = 3;
const MARK_READY_RETRY_PAUSE_MS = 20_000;

export interface MarkReadyVerdict {
  readonly status: string;
  readonly executionErrorCode: GitDeliveryExecutionErrorCode | undefined;
  /** The provider-rejection reason the route reports next to provider-rejected; wire value. */
  readonly rejectionReason: string | undefined;
}

/**
 * Proposes the observed draft for review through the journey card and judges the outcome by the
 * product's OWN answer to the click -- the body of the `mark-ready/execute` response -- never by the
 * control's absence. Real flow 3 of #3390 (run-53) taught why: the provider rejected the mutation,
 * the card showed its failure alert, and the control was momentarily gone while the refresh was in
 * flight, which the previous "no longer offered" check read as success; the run then failed two
 * steps later at the ready-identity reconciliation with the PR still a draft. A provider failure is
 * retried as the card instructs (refresh, then request again); every other failure ends the flow
 * here, naming the route's code and reason.
 */
export async function proposeJourneyReady(page: Page): Promise<void> {
  await raiseWorkbench(page);
  const journey = page.getByRole("region", { name: JOURNEY_REGION_NAME, exact: true });
  await expect(journey).toBeVisible({ timeout: 60_000 });
  const refresh = journey.getByRole("button", { name: REFRESH_BUTTON_NAME });
  const propose = journey.getByRole("button", { name: PROPOSE_BUTTON_NAME });
  for (let attempt = 1; ; attempt += 1) {
    await waitForProposeReadyOffer(page, propose);
    const verdict = await proposeReadyOnce(page, propose);
    if (verdict.status === "succeeded") break;
    const summary = describeMarkReadyVerdict(verdict);
    if (attempt >= MARK_READY_ATTEMPTS || !isRetryableMarkReadyVerdict(verdict)) {
      throw new Error(
        `ready-for-review request ${summary} after ${String(attempt)} attempt(s); the PR stays a draft`,
      );
    }
    process.stderr.write(
      `[lane] ready-for-review request ${summary}; refreshing and requesting again as the card instructs (attempt ${String(attempt)} of ${String(MARK_READY_ATTEMPTS)})\n`,
    );
    await page.waitForTimeout(MARK_READY_RETRY_PAUSE_MS);
  }
  await clickWhenActionable(refresh);
  // A successfully redeemed proposal converts the observed PR from draft to ready, so the control
  // is no longer offered (`canProposeJourneyReady` requires `identity.isDraft === true`).
  await expect(propose).toHaveCount(0, { timeout: 60_000 });
}

/** One click on the control, answered by the execute route it mints and redeems the one-use
 * approval through. The approve/execute pair is the product's own sequence behind the control. */
async function proposeReadyOnce(page: Page, propose: Locator): Promise<MarkReadyVerdict> {
  const executed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(MARK_READY_EXECUTE_ENDPOINT),
    { timeout: 2 * 60_000 },
  );
  await propose.click();
  const response = await executed;
  if (!response.ok()) {
    return {
      status: `http-${String(response.status())}`,
      executionErrorCode: undefined,
      rejectionReason: undefined,
    };
  }
  const body = (await response.json()) as {
    readonly status?: unknown;
    readonly executionErrorCode?: unknown;
    readonly rejectionReason?: unknown;
  };
  return {
    status: typeof body.status === "string" ? body.status : "unreadable",
    executionErrorCode: isGitDeliveryExecutionErrorCode(body.executionErrorCode)
      ? body.executionErrorCode
      : undefined,
    rejectionReason: typeof body.rejectionReason === "string" ? body.rejectionReason : undefined,
  };
}

/**
 * A failed verdict is worth the card's "refresh, then request again" when nothing in it says the
 * next attempt must fail the same way: the provider was unreachable or slow (network-failure,
 * timeout), or it rejected the mutation with output the classifier could not attribute to any
 * permanent cause -- `provider-rejected` with reason `unknown`, which is exactly what real flow 3
 * of #3390 (run-53) reported and what succeeded on the next attempt. A rejection the classifier
 * DID attribute (validation-error, permission-denied, not-found) and every precondition or internal
 * failure are permanent for this head and end the flow.
 */
export function isRetryableMarkReadyVerdict(verdict: MarkReadyVerdict): boolean {
  if (verdict.status !== "failed" || verdict.executionErrorCode === undefined) return false;
  if (TRANSIENT_MARK_READY_CODES.has(verdict.executionErrorCode)) return true;
  return (
    verdict.executionErrorCode === "provider-rejected" && verdict.rejectionReason === "unknown"
  );
}

function describeMarkReadyVerdict(verdict: MarkReadyVerdict): string {
  return `${verdict.status} (${verdict.executionErrorCode ?? "no code"}/${verdict.rejectionReason ?? "no reason"})`;
}

/**
 * Waits for GitHub's own view to catch up with the pushed head, re-reading it on a deliberate,
 * slow cadence.
 *
 * The refresh used to happen INSIDE an `expect.poll` callback, which has two consequences the lane
 * cannot afford. Playwright evaluates that callback outside its retry guard, so one occluded,
 * disabled or momentarily detached refresh click ended the flow outright -- and the button IS
 * disabled while a refresh is in flight. And with the default poll intervals it fired hundreds of
 * real `journey/refresh` calls against GitHub inside ten minutes, which is secondary-rate-limit
 * territory. The click lives outside the matcher, is only attempted when actionable, and runs at
 * the shared fifteen-second cadence (`journeyRefresher`); the offer itself is re-checked every two
 * seconds so it is seen as soon as it appears rather than up to fifteen seconds later.
 *
 * `isEnabled()` is no longer wrapped in a catch: swallowing a strict-mode or detachment error into
 * "not ready yet" reported a structural break ten minutes later as a plain availability timeout.
 */
async function waitForProposeReadyOffer(page: Page, propose: Locator): Promise<void> {
  const refresher = journeyRefresher(page);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if ((await propose.count()) > 0 && (await propose.isEnabled())) return;
    if (Date.now() > deadline) {
      throw new Error("expected the ready-for-review control to become available");
    }
    await refresher.tick();
    await page.waitForTimeout(2_000);
  }
}
