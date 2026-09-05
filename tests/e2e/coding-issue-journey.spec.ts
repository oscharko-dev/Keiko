import { test, type Page } from "@playwright/test";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  isScenarioSelected,
  recordScenarioReceipt,
  type CodingIssueJourneyScenarioId,
} from "./support/coding-issue-journey-scenarios.js";
import {
  runCiRepairScenario,
  runDescriptionScenario,
  runGitChatNegativeScenario,
  runGitToChatScenario,
  runIssueToPrScenario,
  runMarkReadyScenario,
  type ScenarioRunResult,
} from "./support/coding-issue-journey-live-runners.js";

// Issue #3390: the real-model production-composition journey. This spec is deliberately the only
// one in `tests/e2e/` that installs NO `page.route()` interception and imports NO scripted server
// module -- `playwright.coding-issue-journey.config.ts`'s `webServer` refuses to start unless
// `tests/e2e/support/coding-issue-journey-config.ts` resolves a real Model Gateway/LiteLLM profile
// and a real controlled-repository checkout, so by construction this file can only ever run
// against the real production server (`@oscharko-dev/keiko-cli`'s `runUiCli`) driving the real
// OpenCode adapter against a real model. A scripted model, a mocked tool-result stream, or an
// alternative runtime cannot substitute here: there is no seam left for one to attach to.
//
// Every scenario `test()` below writes its own `<scenarioId>.receipt.json` + `.artifact` pair
// (`recordScenarioReceipt`) under `KEIKO_QUALIFICATION_RECEIPTS_DIR`, in the exact shape
// `scripts/check-coding-issue-journey-evidence.mjs` reads, using the SAME writer the packaged
// macOS/Windows qualification drivers already use (`scripts/lib/qualification-evidence-receipt.mjs`).
//
// Each scenario is independently selectable with `KEIKO_QUALIFICATION_SCENARIOS=<comma list>`
// (`isScenarioSelected`) so an orchestrator can run one scenario at a time within the operator's
// USD spend budget, rather than every registered scenario on every invocation.
//
// `human-merge-and-closure` is intentionally NOT among the ids this file drives: issue #3390 AC5
// requires that transition to stay a real, separate human GitHub action, and no receipt is ever
// minted for it here (see `support/coding-issue-journey-scenarios.ts`'s own comment).

test.describe.configure({ mode: "serial" });

async function observedToolCallEvents(page: Page): Promise<number> {
  return page
    .locator('[data-timeline-kind="tool"]')
    .count()
    .catch(() => 0);
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "non-error value thrown");
}

/** Runs one scenario, always recording an honest receipt (passed or failed) from what was
 * actually observed -- never fabricating a passing result when the real run did not reach the
 * asserted effect, and never silently swallowing the failure either (it is rethrown after the
 * receipt is written, so Playwright still reports the scenario red). */
async function recordOutcome(
  page: Page,
  scenarioId: CodingIssueJourneyScenarioId,
  run: () => Promise<ScenarioRunResult>,
): Promise<void> {
  const startedAt = Date.now();
  let outcome: ScenarioRunResult | undefined;
  let failure: unknown;
  try {
    outcome = await run();
  } catch (error) {
    failure = error;
  }
  recordScenarioReceipt({
    scenarioId,
    result: failure === undefined ? "passed" : "failed",
    assertions: outcome?.assertions ?? [`error:${toError(failure).message}`],
    usage: {
      spendObservability: "unknown",
      observedToolCallEvents: await observedToolCallEvents(page),
      observedRunDurationMs: Date.now() - startedAt,
    },
  });
  if (failure !== undefined) throw toError(failure);
}

const ISSUE_TO_PR_MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
const MODE_SCENARIO_IDS: Record<CodingWorkbenchMode, CodingIssueJourneyScenarioId> = {
  "governed-assist": "issue-to-pr-governed-assist",
  "supervised-coding": "issue-to-pr-supervised-coding",
  "autonomous-delivery": "issue-to-pr-autonomous-delivery",
};

for (const mode of ISSUE_TO_PR_MODES) {
  const scenarioId = MODE_SCENARIO_IDS[mode];
  test(`#3390 @coding-issue-journey a real model resolves the controlled issue to a draft PR in ${mode}`, async ({
    page,
  }) => {
    test.skip(!isScenarioSelected(scenarioId), `scenario ${scenarioId} not selected`);
    await recordOutcome(page, scenarioId, () => runIssueToPrScenario(page, mode));
  });
}

test("#3390 @coding-issue-journey ci-repair-loop observes and repairs real CI", async ({
  page,
}) => {
  test.skip(!isScenarioSelected("ci-repair-loop"), "scenario ci-repair-loop not selected");
  await recordOutcome(page, "ci-repair-loop", () => runCiRepairScenario(page));
});

test("#3390 @coding-issue-journey description-auto-draft-and-apply through the governed PR card", async ({
  page,
}) => {
  test.skip(
    !isScenarioSelected("description-auto-draft-and-apply"),
    "scenario description-auto-draft-and-apply not selected",
  );
  await recordOutcome(page, "description-auto-draft-and-apply", () => runDescriptionScenario(page));
});

test("#3390 @coding-issue-journey mark-ready-intent proposes ready without merging", async ({
  page,
}) => {
  test.skip(!isScenarioSelected("mark-ready-intent"), "scenario mark-ready-intent not selected");
  await recordOutcome(page, "mark-ready-intent", () => runMarkReadyScenario(page));
});

test("#3390 @coding-issue-journey git-to-chat-connect-refine-apply on the external PR", async ({
  page,
  request,
}) => {
  test.skip(
    !isScenarioSelected("git-to-chat-connect-refine-apply"),
    "scenario git-to-chat-connect-refine-apply not selected",
  );
  await recordOutcome(page, "git-to-chat-connect-refine-apply", () =>
    runGitToChatScenario(page, request),
  );
});

test("#3390 @coding-issue-journey git-chat-negative-effects exposes no mutating affordance", async ({
  page,
  request,
}) => {
  test.skip(
    !isScenarioSelected("git-chat-negative-effects"),
    "scenario git-chat-negative-effects not selected",
  );
  await recordOutcome(page, "git-chat-negative-effects", () =>
    runGitChatNegativeScenario(page, request),
  );
});
