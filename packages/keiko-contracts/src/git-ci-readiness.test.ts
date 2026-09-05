import { describe, expect, it } from "vitest";
import { isReadinessSnapshot, type ReadinessSnapshot } from "./git-ci-readiness.js";

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
