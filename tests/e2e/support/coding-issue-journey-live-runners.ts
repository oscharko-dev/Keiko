// #3390 — assembles each scenario's real drive into one small, named-assertions result the spec
// file's `test()` bodies turn into a receipt (`recordScenarioReceipt`). Kept separate from the
// spec so every `test()` body stays a thin "is this scenario selected? run it, record the
// receipt" shell (AGENTS.md §6 function-size/complexity bar) instead of inlining the whole drive.

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { realpathSync } from "node:fs";
import { driveOrReuseDraftPullRequest } from "./coding-issue-journey-live-cache.js";
import type { DeliveredPullRequest } from "./coding-issue-journey-live.js";
import { waitForCiRepairOutcome } from "./coding-issue-journey-live-ci.js";
import {
  applyAutoDraftDescriptionThroughPrCard,
  mountGovernedPullRequestCard,
  waitForAutoDraftDescription,
} from "./coding-issue-journey-live-description.js";
import { proposeJourneyReady } from "./coding-issue-journey-live-mark-ready.js";
import {
  attachDisposableBranchCheckout,
  connectControlledPullRequestToChat,
  refineDescriptionOverChat,
  reviewApproveApplyGitChangeDescription,
} from "./coding-issue-journey-live-git-chat.js";
import {
  assertGitChangeChatExposesNoMutatingAffordance,
  observeBoundGitChatSessionActivity,
  observeNoForbiddenSessionRequests,
} from "./coding-issue-journey-live-git-chat-negative.js";
import {
  ciRepairAssertions,
  descriptionAssertions,
  issueToPrAssertions,
  markReadyAssertions,
} from "./coding-issue-journey-stage-assertions.js";

export interface LiveJourneyEnv {
  readonly repositoryRoot: string;
  readonly issueRef: string;
}

/** The webServer already refused to start without a real gateway and controlled repository, so
 * both variables are present whenever a scenario actually runs; narrowing here gives a precise
 * failure if that ever stops being true instead of a confusing downstream selector timeout. */
export function resolveLiveJourneyEnv(): LiveJourneyEnv {
  const repositoryRoot = process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
  const issueRef = process.env.KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE;
  expect(
    repositoryRoot,
    "KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT must be resolved by webServer",
  ).toBeTruthy();
  expect(
    issueRef,
    "KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE must name the seeded failing issue",
  ).toBeTruthy();
  if (repositoryRoot === undefined || issueRef === undefined) {
    throw new Error("coding-issue-journey: missing live journey environment");
  }
  // The server resolves the controlled checkout through the canonical workspace boundary before
  // rendering it. Preserve that same identity in the Playwright process: on macOS `/tmp` aliases
  // `/private/tmp`, and comparing the raw operator spelling with the rendered canonical root made
  // the live lane fail before its first model request despite naming the exact same checkout.
  return { repositoryRoot: realpathSync(repositoryRoot), issueRef };
}

export interface ScenarioRunResult {
  readonly assertions: readonly string[];
}

export async function runIssueToPrScenario(
  page: Page,
  mode: CodingWorkbenchMode,
): Promise<ScenarioRunResult> {
  const env = resolveLiveJourneyEnv();
  const delivered = await driveOrReuseDraftPullRequest(page, { ...env, mode });
  return { assertions: issueToPrAssertions(delivered, mode) };
}

export async function runCiRepairScenario(page: Page): Promise<ScenarioRunResult> {
  const env = resolveLiveJourneyEnv();
  await driveOrReuseDraftPullRequest(page, { ...env, mode: "autonomous-delivery" });
  const outcome = await waitForCiRepairOutcome(page);
  return { assertions: ciRepairAssertions(outcome) };
}

async function deliverForDescription(
  page: Page,
  env: LiveJourneyEnv,
): Promise<DeliveredPullRequest> {
  return driveOrReuseDraftPullRequest(page, { ...env, mode: "autonomous-delivery" });
}

export async function runDescriptionScenario(page: Page): Promise<ScenarioRunResult> {
  const env = resolveLiveJourneyEnv();
  const delivered = await deliverForDescription(page, env);
  const status = await waitForAutoDraftDescription(page);
  const retained = await mountGovernedPullRequestCard(page, env.repositoryRoot, delivered, status);
  await applyAutoDraftDescriptionThroughPrCard(page, retained);
  return { assertions: descriptionAssertions(status, retained) };
}

export async function runMarkReadyScenario(page: Page): Promise<ScenarioRunResult> {
  const env = resolveLiveJourneyEnv();
  await driveOrReuseDraftPullRequest(page, { ...env, mode: "autonomous-delivery" });
  await waitForCiRepairOutcome(page);
  await waitForAutoDraftDescription(page);
  await proposeJourneyReady(page);
  return { assertions: markReadyAssertions() };
}

const GIT_TO_CHAT_TURNS = [
  "Please make the usage section more concise.",
  "Now add a short code example showing how to call the exported function.",
];

export async function runGitToChatScenario(
  page: Page,
  request: APIRequestContext,
): Promise<ScenarioRunResult> {
  const env = resolveLiveJourneyEnv();
  const worktree = attachDisposableBranchCheckout(env.repositoryRoot, "docs/usage-section");
  let toolEventAssertion: string;
  try {
    toolEventAssertion = await observeNoForbiddenSessionRequests(page, async () => {
      const session = await connectControlledPullRequestToChat(page, request, worktree.root);
      const activity = await observeBoundGitChatSessionActivity(
        page,
        session,
        GIT_TO_CHAT_TURNS.length,
        () => refineDescriptionOverChat(page, GIT_TO_CHAT_TURNS),
      );
      await reviewApproveApplyGitChangeDescription(page);
      return activity.assertion;
    });
  } finally {
    worktree.release();
  }
  return {
    assertions: [
      "git-change-chat-connected:true",
      `refined-over-turns:${String(GIT_TO_CHAT_TURNS.length)}`,
      "governed-apply-completed:true",
      "no-forbidden-session-requests:true",
      toolEventAssertion,
    ],
  };
}

export async function runGitChatNegativeScenario(
  page: Page,
  request: APIRequestContext,
): Promise<ScenarioRunResult> {
  return { assertions: await assertGitChangeChatExposesNoMutatingAffordance(page, request) };
}
