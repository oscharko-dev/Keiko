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
import { clickWhenActionable, raiseWorkbench } from "./coding-issue-journey-live.js";

const JOURNEY_REGION_NAME = "Issue handoff";
const REFRESH_BUTTON_NAME = "Refresh observed status";
const PROPOSE_BUTTON_NAME = "Review ready-for-review request";

export async function proposeJourneyReady(page: Page): Promise<void> {
  await raiseWorkbench(page);
  const journey = page.getByRole("region", { name: JOURNEY_REGION_NAME, exact: true });
  await expect(journey).toBeVisible({ timeout: 60_000 });
  const refresh = journey.getByRole("button", { name: REFRESH_BUTTON_NAME });
  const propose = journey.getByRole("button", { name: PROPOSE_BUTTON_NAME });
  await waitForProposeReadyOffer(page, refresh, propose);
  await propose.click();
  await clickWhenActionable(refresh);
  // A successfully redeemed proposal converts the observed PR from draft to ready, so the control
  // is no longer offered (`canProposeJourneyReady` requires `identity.isDraft === true`).
  await expect(propose).toHaveCount(0, { timeout: 60_000 });
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
 * territory. The click now lives outside the matcher, is only attempted when actionable, and runs
 * at a fixed fifteen-second cadence.
 *
 * `isEnabled()` is no longer wrapped in a catch: swallowing a strict-mode or detachment error into
 * "not ready yet" reported a structural break ten minutes later as a plain availability timeout.
 */
async function waitForProposeReadyOffer(
  page: Page,
  refresh: Locator,
  propose: Locator,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if ((await propose.count()) > 0 && (await propose.isEnabled())) return;
    if (Date.now() > deadline) {
      throw new Error("expected the ready-for-review control to become available");
    }
    await clickWhenActionable(refresh);
    await page.waitForTimeout(15_000);
  }
}
