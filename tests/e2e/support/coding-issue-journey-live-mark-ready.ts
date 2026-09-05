// #3390 — the mark-ready-intent scenario. Drives the REAL "Issue handoff" journey card already
// mounted inside the Coding Workbench window (`CodingWorkbenchJourneyOutcome.tsx`): "Refresh
// observed status" re-reads the real GitHub facts through `/api/git-delivery/journey/refresh`, and
// "Review ready-for-review request" mints then immediately redeems the one-use pr-mark-ready
// approval (`createPrMarkReadyProposeHandler`) -- the SAME governed routes the scripted
// `coding-issue-handoff.spec.ts` sibling drives directly through the API. This module drives them
// through the UI instead, since the operator-facing control is what issue #3390's "propose ready"
// scenario qualifies. Only proposes ready: the human merge stays a separate checkpoint (issue
// #3390 AC5) -- this module never calls a merge or issue-close route.

import { expect, type Page } from "@playwright/test";

const JOURNEY_REGION_NAME = "Issue handoff";
const REFRESH_BUTTON_NAME = "Refresh observed status";
const PROPOSE_BUTTON_NAME = "Review ready-for-review request";

export async function proposeJourneyReady(page: Page): Promise<void> {
  const journey = page.getByRole("region", { name: JOURNEY_REGION_NAME, exact: true });
  await expect(journey).toBeVisible({ timeout: 60_000 });
  const refresh = journey.getByRole("button", { name: REFRESH_BUTTON_NAME });
  const propose = journey.getByRole("button", { name: PROPOSE_BUTTON_NAME });
  await expect
    .poll(
      async () => {
        await refresh.click();
        const rendered = (await propose.count()) > 0;
        return rendered && (await propose.isEnabled().catch(() => false));
      },
      {
        timeout: 10 * 60_000,
        message: "expected the ready-for-review control to become available",
      },
    )
    .toBe(true);
  await propose.click();
  await refresh.click();
  // A successfully redeemed proposal converts the observed PR from draft to ready, so the control
  // is no longer offered (`canProposeJourneyReady` requires `identity.isDraft === true`).
  await expect(propose).toHaveCount(0, { timeout: 30_000 });
}
