import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseGateArguments } from "./cli.js";
import {
  CONFIGURATION_PATHS,
  gateConfiguration,
  renderGateCost,
  settlementCounts,
  summarizeGateCost,
} from "./evidence.js";
import type { GateReviewRecord } from "./ports.js";
import { git } from "./repository.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@keiko.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@keiko.invalid",
};
const FILES = [
  "packages/keiko-server/src/review/runtime/reviewPrompt.ts",
  "packages/keiko-server/src/review/counter-check/prompt.ts",
  "packages/keiko-contracts/src/pull-request-review.ts",
  "packages/keiko-contracts/src/pull-request-review-rules.ts",
];

function args(variant: string): ReturnType<typeof parseGateArguments> {
  return parseGateArguments([
    "--set",
    "development",
    "--iteration",
    "dev-1",
    "--variant",
    variant,
    ...["--repository", "/r", "--config", "/c", "--state", "/s", "--out", "/o"],
    ...["--reviewer", "reviewer", "--counter-checker", "counter"],
  ]);
}

function record(wallTimeMs: number, settlement: GateReviewRecord["settlement"]): GateReviewRecord {
  return {
    caseKey: `pr-${String(wallTimeMs)}`,
    runId: "review",
    settlement,
    refusal: null,
    candidateCount: 1,
    presentedCount: 1,
    runtimeCleanup: "unproven",
    reviewer: { promptTokens: 1_000, completionTokens: 100, durationMs: wallTimeMs / 2 },
    counterChecker: { promptTokens: 500, completionTokens: 50, durationMs: wallTimeMs / 4 },
    wallTimeMs,
  };
}

let checkout = "";

beforeEach(() => {
  checkout = mkdtempSync(join(tmpdir(), "keiko-review-gate-checkout-"));
  git(checkout, ["init", "-q", "--template="]);
  for (const path of FILES) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), `// ${path}\n`);
  }
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "configuration"], { env: IDENTITY });
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe("gateConfiguration", () => {
  it("digests the committed review code, the variant and the pair", () => {
    const product = gateConfiguration(checkout, args("product"));
    expect(product.checkoutCommit).toBe(git(checkout, ["rev-parse", "HEAD"]));
    expect(Object.keys(product.objects)).toEqual(expect.arrayContaining([...CONFIGURATION_PATHS]));
    expect(gateConfiguration(checkout, args("product"))).toEqual(product);
    const swapped = gateConfiguration(checkout, args("roles-swapped"));
    expect(swapped.configurationDigest).not.toBe(product.configurationDigest);
    expect(swapped.promptDigest).toBe(product.promptDigest);
  });

  it("refuses to run on uncommitted review configuration", () => {
    writeFileSync(join(checkout, FILES[0] ?? ""), "// changed\n");
    expect(() => gateConfiguration(checkout, args("product"))).toThrow(/uncommitted changes/u);
  });
});

describe("summarizeGateCost and settlementCounts", () => {
  it("sums each role's tokens and durations and reports the median wall time", () => {
    const records = [
      record(4_000, { kind: "complete" }),
      record(8_000, { kind: "incomplete", reason: "deadline-exceeded" }),
      record(6_000, { kind: "complete" }),
    ];
    expect(summarizeGateCost(records)).toEqual({
      reviews: 3,
      reviewer: {
        total: { promptTokens: 3_000, completionTokens: 300, durationMs: 9_000 },
        meanPerReview: { promptTokens: 1_000, completionTokens: 100, durationMs: 3_000 },
      },
      counterChecker: {
        total: { promptTokens: 1_500, completionTokens: 150, durationMs: 4_500 },
        meanPerReview: { promptTokens: 500, completionTokens: 50, durationMs: 1_500 },
      },
      wallTimeMs: { total: 18_000, median: 6_000, max: 8_000 },
    });
    expect(settlementCounts(records)).toEqual({ complete: 2, "incomplete/deadline-exceeded": 1 });
  });

  it("reports no mean and no median for a run without reviews", () => {
    const empty = summarizeGateCost([]);
    expect(empty.reviewer.meanPerReview).toBeNull();
    expect(empty.wallTimeMs).toEqual({ total: 0, median: null, max: 0 });
    expect(
      summarizeGateCost([record(2_000, { kind: "complete" }), record(4_000, { kind: "complete" })])
        .wallTimeMs.median,
    ).toBe(3_000);
  });
});

describe("renderGateCost", () => {
  it("renders the mean cost per role, the median wall time and the sorted settlements", () => {
    const records = [
      record(4_000, { kind: "complete" }),
      record(8_000, { kind: "incomplete", reason: "deadline-exceeded" }),
    ];
    const text = renderGateCost(summarizeGateCost(records), settlementCounts(records));
    expect(text).toContain("| Reviewer | 1000 | 100 | 3 | 2000 |");
    expect(text).toContain("| Counter-checker | 500 | 50 | 2 | 1000 |");
    expect(text).toContain("Median wall time per review: 6 s.");
    expect(text.indexOf("| complete | 1 |")).toBeLessThan(
      text.indexOf("| incomplete/deadline-exceeded | 1 |"),
    );
  });

  it("renders a dash for a run without reviews", () => {
    const text = renderGateCost(summarizeGateCost([]), {});
    expect(text).toContain("| Reviewer | — | — | — | 0 |");
    expect(text).toContain("Median wall time per review: —.");
  });
});
