// #3390 — the auto-draft-and-apply description scenario. `descriptionStatus` (issue #3401) is
// produced automatically by the server's own terminal-run hook once the live run's head is
// stable; applying it never happens through that hook (#3401 correction 1: "never applies a
// description") -- it goes through #3399's EXISTING PR preview/approve/apply flow, exactly what
// the standalone `GovernedPullRequestCard` window already drives in the scripted
// `git-change-chat-3400.spec.ts` sibling ("qualifies the governed PR Description panel"). This
// module reuses that SAME card/testids against the real created draft PR instead of a second
// description-apply surface.

import { expect, type Page } from "@playwright/test";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts";
import { runtimeSnapshot, waitWhileAnsweringApprovals } from "./coding-issue-journey-live.js";
import type { DeliveredPullRequest } from "./coding-issue-journey-live.js";

const GOVERNED_PR_WINDOW_ID = "coding-issue-journey-governed-pr";

/** Waits for the run's own terminal-run hook to record an automatic description-draft attempt
 * (issue #3401). No UI control triggers this -- it is a server-side effect of the run reaching a
 * stable head, so this only observes it. */
export async function waitForAutoDraftDescription(page: Page): Promise<WorkbenchDescriptionStatus> {
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    () => runtimeSnapshot(page),
    (value) => value.descriptionStatus !== undefined,
    {
      timeoutMs: 20 * 60_000,
      message: "expected an automatic description-draft attempt to be recorded",
    },
  );
  const status = snapshot.descriptionStatus;
  if (status === undefined) throw new Error("expected a recorded description status");
  return status;
}

/** Adds a real `governedPullRequest` window to the live desktop session, bound to the delivered
 * PR's own project + branch, mirroring `seedGovernedPrDescriptionWindow`
 * (`support/git-change-chat-3400.ts`) but appended to the ALREADY-open live session instead of a
 * fresh `addInitScript` (this window is added mid-session, after the coding window). */
export async function mountGovernedPullRequestCard(
  page: Page,
  repositoryRoot: string,
  headBranchName: string,
): Promise<void> {
  await page.evaluate(
    ({ windowId, projectPath, headBranchName }) => {
      const raw = window.localStorage.getItem("keiko.workspace.v4");
      const windows: unknown[] = raw === null ? [] : (JSON.parse(raw) as unknown[]);
      windows.push({
        id: windowId,
        type: "governedPullRequest",
        x: 60,
        y: 60,
        w: 760,
        h: 900,
        z: 30,
        cfg: { projectPath, headBranchName },
        max: false,
      });
      window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
    },
    { windowId: GOVERNED_PR_WINDOW_ID, projectPath: repositoryRoot, headBranchName },
  );
  await page.reload();
  await expect(page.locator(`[data-window-id="${GOVERNED_PR_WINDOW_ID}"]`)).toBeVisible();
}

/** Drives the real preview -> approve -> apply sequence through the governed PR card against the
 * real delivered pull request -- the SAME real GitHub PATCH the card issues in production. */
export async function applyAutoDraftDescriptionThroughPrCard(
  page: Page,
  pullRequest: DeliveredPullRequest,
): Promise<void> {
  const card = page
    .locator(`[data-window-id="${GOVERNED_PR_WINDOW_ID}"]`)
    .getByTestId("gpr-description");
  await card.getByLabel("Description repository (owner/repo)").fill(pullRequest.repository);
  await card.getByLabel("Description pull request number").fill(String(pullRequest.number));
  await card.getByTestId("gpr-description-preview-button").click();
  await expect(card.getByTestId("gpr-description-preview")).toBeVisible({ timeout: 60_000 });
  await card.getByTestId("gpr-description-approve-button").click();
  await expect(card.getByTestId("gpr-description-apply-button")).toBeEnabled();
  await card.getByTestId("gpr-description-apply-button").click();
  await expect(card.getByTestId("gpr-description-state")).toHaveAttribute("data-state", "current", {
    timeout: 60_000,
  });
}
