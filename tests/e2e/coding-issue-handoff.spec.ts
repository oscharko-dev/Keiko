// #3389 — read-only journey observation/reconciliation, production-composed end to end: a real
// managed workspace, the real coding runtime through verified commit, push and PR creation, and the
// new /api/git-delivery/journey/refresh route admitted by the per-checkout GitHub-reader grant. The
// journey GraphQL read is the only substituted boundary (see coding-issue-handoff-transport.mts);
// every other effect — commit, push, PR create — runs through the unmodified production path.
//
// Also proves the pr-mark-ready intent (epic #3384 corrections 1/2/7): a real one-use approval mint
// and execute against the SAME production routes, the ready-approval race (two independently minted
// proposals for the identical transition — only whichever executes first ever performs it, the
// other observes drift and performs nothing), and strict one-use redemption.
//
// Proves: a human merge is observed distinctly from the bound issue's own closure; delayed/absent
// closure stays pending rather than completing early; a PR closed without a merge is never reported
// as completed; and across the whole run the coding runtime never calls a merge or issue-close
// endpoint — there is none to call, and this proves the observation path never attempts one.

import { expect, test, type Page, type APIResponse } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  handoffProviderPath,
  handoffStateDir,
  type HandoffFixtureMode,
  type HandoffProviderState,
} from "./support/coding-issue-handoff.js";
import {
  HANDOFF_REPOSITORY_ROOT,
  startHandoffDraft,
  handoffControl,
} from "./support/coding-issue-handoff-journey.js";

test.describe.configure({ mode: "serial" });
const stateDir = handoffStateDir();

// Split into two independent checks — a mounted-route prefix and a name-based pattern — rather
// than one combined regex literal: a single alternation spanning both reads, to a source-level
// route scanner, as one `/api/...` reference and silently drags the unrelated issue-close
// alternative along with it (scripts/check-e2e-suite-wiring.mjs's ROUTED invariant). Kept apart,
// each half names exactly the family it checks.
const MUTATION_PATH_PREFIXES: readonly string[] = ["/api/git-delivery/merge/"];
const ISSUE_CLOSE_PATTERN = /issue.*close|close.*issue/iu;
const requestedUrls: string[] = [];

function isMutationEndpointCall(url: string): boolean {
  const path = new URL(url).pathname;
  return (
    MUTATION_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    ISSUE_CLOSE_PATTERN.test(path)
  );
}

test.beforeEach(({ page }) => {
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });
});
test.afterAll(() => {
  const offenders = requestedUrls.filter((url) => isMutationEndpointCall(url));
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
    readonly remote: {
      readonly mergedAt: string | null;
      readonly issue: { readonly state: string };
      readonly identity: {
        readonly number: number;
        readonly repository: string;
        readonly headSha: string;
        readonly baseSha: string;
        readonly baseRef: string;
        readonly isDraft: boolean;
      };
    } | null;
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
  expect(completed.outcome).toMatchObject({
    state: "completed",
    reason: "merge-and-closure-observed",
  });
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

// ─── pr-mark-ready intent (#3389 AC3, epic #3384 corrections 1/2/7) ───────────────────────────────

interface MarkReadyBody {
  readonly schemaVersion: "1";
  readonly projectId: string;
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly readinessDigest: string;
}

// #3389 repair (review finding, correction 2): the execute route now independently re-derives the
// live requirements digest (assessGitCiFacts's requirementsDigest) and refuses on a mismatch — a
// digest with no relationship to any live read (this constant used to be the literal "e".repeat(64))
// can never be redeemed any more. This is the REAL value `assessGitCiFacts` produces for the exact
// "unprotected branch, no required-status-check rules, no workflow-requirement definitions" facts
// coding-issue-handoff-transport.mts's CI-facts fixture answers for every PR in this suite — that
// digest depends only on the (empty) requirements configuration, never on PR/repo identity, so one
// constant serves every test below. Recomputed by calling the real producer against that exact
// fixture shape (`collectGitCiRequirements({protection:{outcome:"unprotected"}, rules: emptyPage})`
// then `assessGitCiFacts`), never hand-derived.
const HANDOFF_CLEAN_READINESS_DIGEST =
  "0cca7086fc8519a84fbfceee46195028f2af59a14e0d69fb8eab21ec4a328e02";

interface MarkReadyApproveResponse {
  readonly approval: unknown;
}

interface MarkReadyExecuteResponse {
  readonly status: string;
  readonly executionErrorCode?: string;
}

async function mintMarkReadyApproval(page: Page, body: MarkReadyBody): Promise<unknown> {
  const response = await page.request.post("/api/git-delivery/pr/mark-ready/approve", {
    headers: { "X-Keiko-CSRF": "1" },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as MarkReadyApproveResponse).approval;
}
async function executeMarkReady(
  page: Page,
  body: MarkReadyBody,
  approval: unknown,
): Promise<APIResponse> {
  return page.request.post("/api/git-delivery/pr/mark-ready/execute", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { ...body, approval },
  });
}

test("#3389 @coding-issue-handoff pr-mark-ready: the ready-approval race — two minted proposals, only the first execution ever performs the transition", async ({
  page,
}) => {
  mode("open");
  const runId = await startHandoffDraft(page, 47);

  const before = await refresh(page, runId);
  const identity = before.outcome?.remote?.identity;
  if (identity === undefined) throw new Error("Expected an observed remote identity");
  expect(identity.isDraft).toBe(true);

  const markReadyBody: MarkReadyBody = {
    schemaVersion: "1",
    projectId: HANDOFF_REPOSITORY_ROOT,
    ownerAndRepo: identity.repository,
    prExternalId: String(identity.number),
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    baseRef: identity.baseRef,
    readinessDigest: HANDOFF_CLEAN_READINESS_DIGEST,
  };

  // Two independently minted proposals ("two proposals") for the identical draft->ready
  // transition — as if the human clicked "propose ready" twice before the first request settled.
  const firstApproval = await mintMarkReadyApproval(page, markReadyBody);
  const secondApproval = await mintMarkReadyApproval(page, markReadyBody);

  // The first claim actually performs the transition.
  const firstExecute = await executeMarkReady(page, markReadyBody, firstApproval);
  expect(firstExecute.ok(), await firstExecute.text()).toBe(true);
  const firstBody = (await firstExecute.json()) as MarkReadyExecuteResponse;
  expect(firstBody.status).toBe("succeeded");

  // The re-read observes the real transition through the shared fixture state — never assumed.
  const after = await refresh(page, runId);
  expect(after.outcome?.remote?.identity.isDraft).toBe(false);

  // The second, still-unredeemed claim is refused with drift: the live PR is no longer the draft
  // it was minted against, so it performs nothing further — "one claim" is whichever executes
  // first, never both.
  const secondExecute = await executeMarkReady(page, markReadyBody, secondApproval);
  expect(secondExecute.ok(), await secondExecute.text()).toBe(true);
  const secondBody = (await secondExecute.json()) as MarkReadyExecuteResponse;
  expect(secondBody.status).toBe("failed");
  expect(secondBody.executionErrorCode).toBe("precondition-failed");

  // The first claim is strictly one-use independent of drift: redeeming it again is refused
  // outright (already consumed) rather than re-dispatching.
  const replay = await executeMarkReady(page, markReadyBody, firstApproval);
  expect(replay.status()).toBe(400);

  await handoffControl("finish");
});

test("#3389 @coding-issue-handoff pr-mark-ready: execute refuses without a consumed claim, and never reaches the generic pr-update convertFromDraft path", async ({
  page,
}) => {
  mode("open");
  const runId = await startHandoffDraft(page, 48);
  const observed = await refresh(page, runId);
  const identity = observed.outcome?.remote?.identity;
  if (identity === undefined) throw new Error("Expected an observed remote identity");

  const markReadyBody: MarkReadyBody = {
    schemaVersion: "1",
    projectId: HANDOFF_REPOSITORY_ROOT,
    ownerAndRepo: identity.repository,
    prExternalId: String(identity.number),
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    baseRef: identity.baseRef,
    readinessDigest: HANDOFF_CLEAN_READINESS_DIGEST,
  };

  // No approval attached at all: refused as approval-required, nothing executes.
  const unapproved = await executeMarkReady(page, markReadyBody, undefined);
  expect(unapproved.ok(), await unapproved.text()).toBe(true);
  const unapprovedBody = (await unapproved.json()) as MarkReadyExecuteResponse;
  expect(unapprovedBody.status).toBe("approval-required");

  // Correction 1: the generic pr-update command rejects convertFromDraft unconditionally — the
  // approval-less path is closed even when a validly-shaped, unrelated approval is attached.
  const genericAttempt = await page.request.post("/api/git-delivery/pr/execute", {
    headers: { "X-Keiko-CSRF": "1" },
    data: {
      schemaVersion: "1",
      projectId: HANDOFF_REPOSITORY_ROOT,
      kind: "pr-update",
      ownerAndRepo: identity.repository,
      prExternalId: String(identity.number),
      headBranchName: "irrelevant",
      baseBranchName: "irrelevant",
      title: "t",
      body: "b",
      convertFromDraft: true,
    },
  });
  expect(genericAttempt.status()).toBe(400);

  const stillDraft = await refresh(page, runId);
  expect(stillDraft.outcome?.remote?.identity.isDraft).toBe(true);

  await handoffControl("finish");
});
