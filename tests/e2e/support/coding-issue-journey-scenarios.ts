// #3390 — scenario selection and evidence-receipt recording for the real-model production-
// composition harness (`coding-issue-journey.spec.ts`). Shared by every scenario test so the
// selection rule and the receipt shape are defined exactly once (AGENTS.md §5).
//
// Reuses the SAME receipt writer the packaged macOS/Windows qualification drivers already use
// (`scripts/lib/qualification-evidence-receipt.mjs`, typed via its sibling `.d.mts` — see that
// file's own comment for why this is an import, not a second copy) and the SAME platform-key
// formula `scripts/check-coding-issue-journey-evidence.mjs` cross-references receipts against
// (`scripts/lib/coding-issue-journey-evidence.mjs`'s `platformKeyFor`).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { platformKeyFor } from "../../../scripts/lib/coding-issue-journey-evidence.mjs";
import { writeQualificationEvidenceReceipt } from "../../../scripts/lib/qualification-evidence-receipt.mjs";

// The `playwright-journey` scenario ids this harness can produce evidence for. The merge row is
// emitted only after the explicit governed-merge confirmation and the provider-observed merge and
// bound issue closure; the receipt cannot substitute for those observations.
export const CODING_ISSUE_JOURNEY_SCENARIO_IDS = [
  "issue-to-pr-governed-assist",
  "issue-to-pr-supervised-coding",
  "issue-to-pr-autonomous-delivery",
  "ci-repair-loop",
  "description-auto-draft-and-apply",
  "mark-ready-intent",
  "human-merge-and-closure",
  "git-to-chat-connect-refine-apply",
  "git-chat-negative-effects",
] as const;

export type CodingIssueJourneyScenarioId = (typeof CODING_ISSUE_JOURNEY_SCENARIO_IDS)[number];

/**
 * `KEIKO_QUALIFICATION_SCENARIOS=<comma list>` narrows which scenario `test()`s actually drive a
 * real (paid) journey this invocation. Unset or empty means "every scenario in this file" only
 * when no five-flow ordinal is selected; ordinal-only execution is exclusive by default.
 */
export function isScenarioSelected(
  scenarioId: CodingIssueJourneyScenarioId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.KEIKO_QUALIFICATION_SCENARIOS;
  if (raw === undefined || raw.trim().length === 0) {
    // A selected five-flow ordinal is an exclusive paid lane by default. Without this guard an
    // ordinal-only invocation completes its one governed issue flow and then starts every legacy
    // paid scenario against the PR it has just merged. Operators can still request a deliberate
    // combined run by naming the legacy scenarios explicitly.
    return env.KEIKO_QUALIFICATION_FLOW_ORDINAL === undefined;
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .includes(scenarioId);
}

/** The manifest/receipt "platform" string for the host this Playwright process runs on. Throws
 * (fails the test loudly) rather than silently recording an unrecognized platform. */
export function currentPlatformKey(): string {
  const key = platformKeyFor(process.platform, process.arch);
  if (key === undefined) {
    throw new Error(
      `coding-issue-journey: unsupported qualification platform ${process.platform}/${process.arch}`,
    );
  }
  return key;
}

/** Body-free gateway-usage counts this harness can actually observe from the browser (issue #3390:
 * "respect KEIKO_QUALIFICATION_SPEND_BUDGET_USD at least by recording gateway token usage it can
 * observe"). No client-visible route reports a dollar or token figure today (runbook Part 5), so
 * `spendObservability` stays honestly `"unknown"` -- this NEVER fabricates a spend number, only
 * records the observable proxy counts the browser actually saw. */
export interface ObservedGatewayUsage {
  readonly spendObservability: "unknown";
  readonly observedToolCallEvents: number;
  readonly observedRunDurationMs: number;
}

export interface ScenarioReceiptInput {
  readonly scenarioId: CodingIssueJourneyScenarioId;
  /** Distinguishes one flow's observation while retaining the canonical scenario identity. */
  readonly receiptKey?: string;
  readonly result: "passed" | "failed";
  readonly assertions: readonly string[];
  readonly usage: ObservedGatewayUsage;
  readonly flowBinding?: {
    readonly flowId: string;
    readonly taskRunId: string;
    readonly repository: string;
    readonly issueNumber: number;
    readonly pullRequestNumber: number;
    readonly pullRequestHeadSha: string;
    readonly mergeCommitSha?: string;
  };
}

function headCommitSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** `KEIKO_QUALIFICATION_RECEIPTS_DIR` is resolved once by the Playwright config (with a default
 * fallback) and threaded to both the launched server and this worker process -- see
 * `playwright.coding-issue-journey.config.ts`. Required here rather than re-defaulted so a
 * misconfigured invocation fails loudly instead of writing evidence somewhere unexpected. */
export function receiptsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = env.KEIKO_QUALIFICATION_RECEIPTS_DIR;
  if (dir === undefined || dir.length === 0) {
    throw new Error(
      "coding-issue-journey: KEIKO_QUALIFICATION_RECEIPTS_DIR must be resolved by the Playwright config",
    );
  }
  return dir;
}

/**
 * Records one scenario's `<scenarioId>.receipt.json` + `.artifact` pair. The artifact body is the
 * content-free evidence itself (named assertions and counts, never prompts/diffs/PR bodies/tokens
 * -- AGENTS.md §7), and its bytes are what the manifest's `receiptDigest` binds to.
 */
export function recordScenarioReceipt(input: ScenarioReceiptInput): string {
  const dir = receiptsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return writeQualificationEvidenceReceipt({
    receiptsDir: dir,
    scenarioId: input.scenarioId,
    ...(input.receiptKey === undefined ? {} : { receiptKey: input.receiptKey }),
    recordedAt: new Date().toISOString(),
    provenance: "real-model",
    receipt: {
      schemaVersion: 1,
      scenarioId: input.scenarioId,
      evidenceClass: "playwright-journey",
      sourceCommitSha: headCommitSha(),
      platformTarget: currentPlatformKey(),
      result: input.result,
      assertions: input.assertions,
      usage: input.usage,
      ...(input.flowBinding === undefined ? {} : { flowBinding: input.flowBinding }),
    },
  });
}
