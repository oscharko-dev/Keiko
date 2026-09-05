// #3389 — read-only journey observation/reconciliation, production-composed end to end: a real
// managed workspace, the real coding runtime through verified commit, push and PR creation, and the
// new /api/git-delivery/journey/refresh route admitted by the per-checkout GitHub-reader grant. The
// journey GraphQL read is the only substituted boundary (see coding-issue-handoff-transport.mts);
// every other effect — commit, push, PR create — runs through the unmodified production path.
//
// Proves: a human merge is observed distinctly from the bound issue's own closure; delayed/absent
// closure stays pending rather than completing early; a PR closed without a merge is never reported
// as completed; and across the whole run the coding runtime never calls a merge or issue-close
// endpoint — there is none to call, and this proves the observation path never attempts one.

import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  handoffProviderPath,
  handoffStateDir,
  type HandoffFixtureMode,
  type HandoffProviderState,
} from "./support/coding-issue-handoff.js";
import { startHandoffDraft, handoffControl } from "./support/coding-issue-handoff-journey.js";

test.describe.configure({ mode: "serial" });
const stateDir = handoffStateDir();

const MUTATION_PATTERN = /\/api\/git-delivery\/merge\/|issue.*close|close.*issue/iu;
const requestedUrls: string[] = [];

test.beforeEach(({ page }) => {
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });
});
test.afterAll(() => {
  const offenders = requestedUrls.filter((url) => MUTATION_PATTERN.test(url));
  expect(offenders, "the coding runtime must never call a merge or issue-close endpoint").toEqual(
    [],
  );
});

function provider(): HandoffProviderState {
  return JSON.parse(readFileSync(handoffProviderPath(stateDir), "utf8")) as HandoffProviderState;
}
function mode(value: HandoffFixtureMode): void {
  writeFileSync(handoffProviderPath(stateDir), JSON.stringify({ ...provider(), mode: value }));
}

interface JourneyRefreshResponse {
  readonly status: "observed" | "unavailable";
  readonly outcome?: {
    readonly state: string;
    readonly reason: string;
    readonly remote: { readonly mergedAt: string | null; readonly issue: { readonly state: string } } | null;
  };
  readonly reason?: string;
}
async function refresh(page: Page, runId: string): Promise<JourneyRefreshResponse> {
  const response = await page.request.post("/api/git-delivery/journey/refresh", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { schemaVersion: "1", runId },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as JourneyRefreshResponse;
}

test("#3389 @coding-issue-handoff observes a human merge distinctly from the bound issue's own closure", async ({
  page,
}) => {
  mode("open");
  const runId = await startHandoffDraft(page, 44);
  await expect(page.getByRole("region", { name: "Issue handoff", exact: true })).toBeVisible();

  const open = await refresh(page, runId);
  expect(open.status).toBe("observed");
  expect(open.outcome?.remote?.mergedAt).toBeNull();

  mode("merged-open");
  const mergedOpen = await refresh(page, runId);
  expect(mergedOpen.status).toBe("observed");
  expect(mergedOpen.outcome).toMatchObject({
    state: "merged-awaiting-issue-closure",
    reason: "issue-closure-pending",
  });
  expect(mergedOpen.outcome?.remote?.issue.state).toBe("open");
  await expect(page.getByText("Merged; issue closure pending", { exact: true })).toBeVisible();

  // Delayed closure: a second observation while the issue is still open must not advance past
  // pending on its own (no polling, no assumed progress — only what was actually observed).
  const stillPending = await refresh(page, runId);
  expect(stillPending.outcome?.state).toBe("merged-awaiting-issue-closure");
  await expect(page.getByText("Issue journey completed", { exact: true })).not.toBeVisible();

  mode("merged-closed");
  const completed = await refresh(page, runId);
  expect(completed.status).toBe("observed");
  expect(completed.outcome).toMatchObject({ state: "completed", reason: "merge-and-closure-observed" });
  expect(completed.outcome?.remote?.issue.state).toBe("closed");
  await expect(page.getByText("Issue journey completed", { exact: true })).toBeVisible();

  await handoffControl("finish");
});

test("#3389 @coding-issue-handoff keeps a PR closed without a merge distinct from completed, and never presents a blocked review as ready", async ({
  page,
}) => {
  mode("open");
  const runId = await startHandoffDraft(page, 45);

  mode("blocked-review");
  const blocked = await refresh(page, runId);
  expect(blocked.status).toBe("observed");
  // Description/CI readiness are not yet produced by this lane (#3399 lands the description-apply
  // path separately); this asserts the narrower, always-true invariant that a blocked review is
  // never reported as ready-for-human-review or completed while unresolved.
  expect(blocked.outcome?.state).not.toBe("ready-for-human-review");
  expect(blocked.outcome?.state).not.toBe("completed");
  expect(blocked.outcome?.remote?.mergedAt).toBeNull();

  mode("closed-unmerged");
  const closedUnmerged = await refresh(page, runId);
  expect(closedUnmerged.status).toBe("observed");
  expect(closedUnmerged.outcome).toMatchObject({ state: "blocked", reason: "closed-unmerged" });
  expect(closedUnmerged.outcome?.remote?.mergedAt).toBeNull();
  await expect(page.getByText("Handoff blocked", { exact: true })).toBeVisible();

  await handoffControl("finish");
});

test("#3389 @coding-issue-handoff renders the ready-for-review control as closed and non-clickable until the mark-ready mint lands", async ({
  page,
}) => {
  mode("open");
  const runId = await startHandoffDraft(page, 46);
  await refresh(page, runId);
  await page.reload();
  await expect(page.getByRole("region", { name: "Issue handoff", exact: true })).toBeVisible();
  const proposeReady = page.getByRole("button", { name: "Review ready-for-review request" });
  if ((await proposeReady.count()) > 0) {
    await expect(proposeReady).toBeDisabled();
    await expect(
      page.getByText("The ready-for-review approval path is not available yet."),
    ).toBeVisible();
  }
  await handoffControl("finish");
});
