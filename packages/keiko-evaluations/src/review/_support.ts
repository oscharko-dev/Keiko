// Test builders for the review evaluation family. Not a *.test.ts, and excluded from the build.
//
// The scripted review ports stand in for the real pipeline (composed by a higher layer): they ask
// the injected ModelPort once and parse its scripted answer as `keiko_review_report` findings with
// the child-1 validator, so the tests exercise the package's real provider selector and scripted
// model rather than a hand-fed result.

import type {
  ReviewCodeLocation,
  ReviewFindingCategory,
  ReviewFindingReport,
  ReviewFindingSeverity,
} from "@oscharko-dev/keiko-contracts";
import { validateReviewFindingReport } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import type { ReviewReplayPort, ReviewReplayPortResult } from "./replay.js";
import type { ReviewSeedPort, ReviewSeedPortResult } from "./seed-gate.js";
import type {
  ReviewHarvestDataset,
  ReviewHarvestPullRequest,
  ReviewHarvestThread,
} from "./types.js";

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);
export const DIGEST = `sha256:${"0".repeat(64)}`;

export function thread(overrides: Partial<ReviewHarvestThread> = {}): ReviewHarvestThread {
  return {
    id: "PRRT_1",
    producer: "coderabbit",
    path: "src/a.ts",
    startLine: 10,
    endLine: 12,
    fileLevel: false,
    side: "right",
    reviewedCommit: COMMIT_A,
    resolved: false,
    outdated: false,
    reply: null,
    regionChange: "unchanged",
    bodyDigest: DIGEST,
    ...overrides,
  };
}

export function pullRequest(
  number: number,
  threads: readonly ReviewHarvestThread[],
  overrides: Partial<ReviewHarvestPullRequest> = {},
): ReviewHarvestPullRequest {
  return {
    number,
    state: "merged",
    headCommit: COMMIT_B,
    baseCommit: COMMIT_A,
    reviewedBy: [...new Set(threads.map((entry) => entry.producer))],
    threads,
    ...overrides,
  };
}

export function dataset(pullRequests: readonly ReviewHarvestPullRequest[]): ReviewHarvestDataset {
  return {
    schemaVersion: 1,
    repository: "example/repo",
    rules: { regionChange: "fixture" },
    population: {
      states: ["merged", "closed"],
      pullRequestCount: pullRequests.length,
      firstPullRequest: pullRequests[0]?.number ?? null,
      lastPullRequest: pullRequests.at(-1)?.number ?? null,
    },
    excludedNoticeThreads: {
      "keiko-for-quality": 0,
      coderabbit: 0,
      codex: 0,
      qodo: 0,
      human: 0,
      other: 0,
    },
    pullRequests,
    digest: DIGEST,
  };
}

export function finding(
  location: ReviewCodeLocation,
  category: ReviewFindingCategory = "correctness",
  severity: ReviewFindingSeverity = "high",
): ReviewFindingReport {
  return {
    ...location,
    title: "Scripted finding",
    condition: "When the scripted condition holds",
    mechanism: "the scripted mechanism applies",
    consequence: "the scripted consequence follows",
    remedy: "Apply the scripted remedy",
    category,
    severity,
    evidence: [{ ...location, role: "defect" }],
  };
}

export function reviewResponse(
  findings: readonly ReviewFindingReport[],
  usage: { readonly promptTokens: number; readonly completionTokens: number } = {
    promptTokens: 100,
    completionTokens: 20,
  },
): NormalizedResponse {
  return {
    modelId: "scripted-reviewer",
    content: JSON.stringify({ findings }),
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "scripted", latencyMs: 1, costClass: "low", ...usage },
  };
}

async function askForFindings(
  model: ModelPort,
  signal: AbortSignal,
): Promise<ReviewFindingReport[]> {
  const response = await model.call(
    { modelId: "scripted-reviewer", messages: [{ role: "user", content: "Review the change." }] },
    signal,
  );
  const parsed = JSON.parse(response.content) as { readonly findings: readonly unknown[] };
  return parsed.findings.map((entry) => {
    const validation = validateReviewFindingReport(entry);
    if (!validation.ok) throw new Error("scripted finding failed contract validation");
    return validation.value;
  });
}

/** A replay port whose findings are whatever the scripted model answers. */
export function scriptedReplayPort(calls: number[] = []): ReviewReplayPort {
  return {
    reviewPullRequest: async ({
      pullRequest: target,
      model,
      signal,
    }): Promise<ReviewReplayPortResult> => {
      calls.push(target.number);
      return { settlement: { kind: "complete" }, findings: await askForFindings(model, signal) };
    },
  };
}

/** A seed port whose findings are whatever the scripted model answers, settled as given. */
export function scriptedSeedPort(
  outcome: { readonly settlement?: "complete" | "incomplete"; readonly headMoved?: boolean } = {},
): ReviewSeedPort {
  return {
    reviewSeed: async ({ model, signal }): Promise<ReviewSeedPortResult> => ({
      settlement:
        outcome.settlement === "incomplete"
          ? { kind: "incomplete", reason: "budget-exhausted" }
          : { kind: "complete" },
      headMoved: outcome.headMoved ?? false,
      findings: await askForFindings(model, signal),
    }),
  };
}
