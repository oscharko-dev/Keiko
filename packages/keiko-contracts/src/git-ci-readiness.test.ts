import { describe, expect, it } from "vitest";
import {
  isGitCiReadinessEvidenceRef,
  isReadinessSnapshot,
  type ReadinessSnapshot,
} from "./git-ci-readiness.js";

const COUNTS = { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 };
const SNAPSHOT: ReadinessSnapshot = {
  schemaVersion: "1",
  runId: "run-1",
  remoteDigest: "a".repeat(64),
  repository: "owner/repo",
  prNumber: 17,
  baseRef: "dev",
  baseSha: "b".repeat(40),
  headRef: "feature/issue-1",
  headSha: "c".repeat(40),
  requirementsVersion: "1",
  requirementsDigest: "d".repeat(64),
  strictBaseRequired: true,
  observedAt: "2026-09-05T00:00:00.000Z",
  expiresAt: "2026-09-05T00:01:00.000Z",
  evidenceRef: "ci-observation-1",
  complete: true,
  state: "technical-ready",
  reason: "required-checks-passed",
  requiredChecks: COUNTS,
  advisoryChecks: COUNTS,
  pullRequest: { status: "open", isDraft: true, conflict: "clear", baseCurrency: "current" },
  humanReview: {
    visibility: "unknown",
    requiredCount: 2,
    approvedCount: null,
    changesRequestedCount: null,
  },
};
describe("exact-revision CI readiness evidence", () => {
  it("shares the bounded evidence-reference vocabulary with qualification receipts", () => {
    expect(isGitCiReadinessEvidenceRef("ci-observation-1")).toBe(true);
    expect(isGitCiReadinessEvidenceRef("contains spaces")).toBe(false);
  });
  it("keeps technical readiness independent from draftness and human review visibility", () => {
    expect(isReadinessSnapshot(SNAPSHOT)).toBe(true);
    expect(SNAPSHOT).not.toHaveProperty("mergeAllowed");
    expect(SNAPSHOT).not.toHaveProperty("descriptionFresh");
  });
  it.each([
    { complete: false },
    { requirementsDigest: null },
    { reason: "required-checks-pending" },
    { requiredChecks: { ...COUNTS, passed: 0, failed: 1 } },
    { pullRequest: { ...SNAPSHOT.pullRequest, conflict: "conflicting" } },
    { pullRequest: { ...SNAPSHOT.pullRequest, status: "closed" } },
    { pullRequest: { ...SNAPSHOT.pullRequest, baseCurrency: "behind" } },
  ])("rejects an unjustified ready claim %#", (change) => {
    expect(isReadinessSnapshot({ ...SNAPSHOT, ...change })).toBe(false);
  });
  it("permits behind-base readiness only when the observed strict-base policy does not require an update", () => {
    expect(
      isReadinessSnapshot({
        ...SNAPSHOT,
        strictBaseRequired: false,
        pullRequest: { ...SNAPSHOT.pullRequest, baseCurrency: "behind" },
      }),
    ).toBe(true);
  });
  it.each([
    { expiresAt: SNAPSHOT.observedAt },
    { expiresAt: "2026-09-05T00:01:00.001Z" },
    { observedAt: "invalid" },
    { expiresAt: "2026-02-30T00:00:00.000Z" },
    { headSha: "HEAD" },
    { baseRef: "../dev" },
    { repository: "https://github.com/owner/repo" },
    { prNumber: 0 },
    { remoteDigest: "secret" },
    { body: "untrusted" },
    { schemaVersion: "2" },
    { requiredChecks: { ...COUNTS, total: 2 } },
    { humanReview: { ...SNAPSHOT.humanReview, visibility: "complete" } },
    { pullRequest: { ...SNAPSHOT.pullRequest, status: { toString: (): string => "open" } } },
  ])("rejects malformed, stale, extra or coerced fields %#", (change) => {
    expect(isReadinessSnapshot({ ...SNAPSHOT, ...change })).toBe(false);
  });
  it("rejects fields inherited instead of present in the serialized evidence", () => {
    const { headSha, ...rest } = SNAPSHOT;
    expect(isReadinessSnapshot(Object.assign(Object.create({ headSha }) as object, rest))).toBe(
      false,
    );
  });
});

import { isGitCiCheckCounts as sourceCheckCounts } from "./git-ci-readiness.js";
import { isGitCiCheckCounts as publicCheckCounts } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";

describe("G1 owning second count observations", () => {
  for (const [name, check] of [
    ["source", sourceCheckCounts],
    ["public", publicCheckCounts],
  ] as const) {
    it(`${name} preserves stable and changing admitted integer observations`, () => {
      for (const changed of [false, true]) {
        let passedReads = 0;
        let failedReads = 0;
        const counts = { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 };
        Object.defineProperty(counts, "passed", {
          enumerable: true,
          get: (): number => {
            passedReads += 1;
            return changed && passedReads > 1 ? 0 : 1;
          },
        });
        Object.defineProperty(counts, "failed", {
          enumerable: true,
          get: (): number => {
            failedReads += 1;
            return changed && failedReads > 1 ? 1 : 0;
          },
        });
        expect(check(counts)).toBe(true);
        expect(passedReads).toBe(2);
        expect(failedReads).toBe(2);
      }
    });
    it(`${name} refuses fractional second observations even when their sum matches`, () => {
      let passedReads = 0;
      let failedReads = 0;
      const counts = { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 };
      Object.defineProperty(counts, "passed", {
        enumerable: true,
        get: (): number => {
          passedReads += 1;
          return passedReads === 1 ? 1 : 0.5;
        },
      });
      Object.defineProperty(counts, "failed", {
        enumerable: true,
        get: (): number => {
          failedReads += 1;
          return failedReads === 1 ? 0 : 0.5;
        },
      });
      expect(check(counts)).toBe(false);
      expect(passedReads).toBe(2);
      expect(failedReads).toBe(2);
    });
  }
});

describe("G1 consumed aggregate total observations", () => {
  for (const [name, check] of [
    ["source", sourceCheckCounts],
    ["public", publicCheckCounts],
  ] as const) {
    it(`${name} preserves healthy total phases without merging observations`, () => {
      for (const firstTotal of [0, 1_500]) {
        let reads = 0;
        const counts = {
          total: 1_500,
          passed: 300,
          failed: 300,
          pending: 300,
          blocked: 300,
          unknown: 300,
        };
        Object.defineProperty(counts, "total", {
          enumerable: true,
          get: (): number => (++reads === 1 ? firstTotal : 1_500),
        });
        expect(check(counts)).toBe(true);
        expect(reads).toBe(3);
      }
    });
    it(`${name} refuses an out-of-bound consumed total even when the sum matches`, () => {
      let reads = 0;
      const counts = {
        total: 1_500,
        passed: 1_500,
        failed: 1_500,
        pending: 1_500,
        blocked: 1_500,
        unknown: 1_500,
      };
      Object.defineProperty(counts, "total", {
        enumerable: true,
        get: (): number => (++reads === 1 ? 1_500 : 7_500),
      });
      const admitted = check(counts);
      expect(reads).toBe(3);
      expect(admitted).toBe(false);
    });
  }
});
