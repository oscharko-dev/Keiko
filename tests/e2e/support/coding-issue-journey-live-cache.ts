// #3390 — reuses a single real drive-to-draft-PR result across every scenario `test()` in ONE
// Playwright process (e.g. `KEIKO_QUALIFICATION_SCENARIOS=issue-to-pr-autonomous-delivery,
// ci-repair-loop,description-auto-draft-and-apply,mark-ready-intent` run together), instead of
// opening a new real branch/PR against the controlled repository for every downstream scenario
// that needs one. The live run's state lives server-side, so a fresh `page` can reattach to it
// after re-pairing -- the same reload continuity `coding-issue-intake.spec.ts` already relies on.

import type { Page } from "@playwright/test";
import {
  driveIssueToDraftPullRequest,
  openLiveWorkbench,
  type DeliveredPullRequest,
  type DriveToDraftPrInput,
} from "./coding-issue-journey-live.js";

const cache = new Map<DriveToDraftPrInput["mode"], DeliveredPullRequest>();

export async function driveOrReuseDraftPullRequest(
  page: Page,
  input: DriveToDraftPrInput,
): Promise<DeliveredPullRequest> {
  const cached = cache.get(input.mode);
  if (cached !== undefined) {
    await openLiveWorkbench(page, input.repositoryRoot);
    return cached;
  }
  const delivered = await driveIssueToDraftPullRequest(page, input);
  cache.set(input.mode, delivered);
  return delivered;
}
