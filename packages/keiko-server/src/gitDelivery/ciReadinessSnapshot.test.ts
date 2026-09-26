import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitCiProviderFacts } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { ciReadinessIsCurrent, produceCiReadinessSnapshot } from "./ciReadinessSnapshot.js";
import { AT, DIGEST, createDraftRun, readySnapshot } from "./ciObservationTest/_support.js";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";

import { CHECK, failureFacts } from "./ciObservationTest/_providerFacts.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(): { readonly draft: DraftDeliveryRecord; readonly facts: GitCiProviderFacts } {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const draft = createDraftRun(db).get("run-1")?.draftDelivery;
  if (draft?.pullRequest === undefined) throw new Error("Missing fixture pull request");
  const page = {
    values: [],
    completeness: { complete: true, pages: 1, entries: 0, bytes: 2 },
  } as const;
  return {
    draft,
    facts: {
      status: "observed",
      identity: draft.pullRequest,
      repositoryId: 41,
      mergeable: true,
      mergeState: "clean",
      merged: false,
      protection: { outcome: "unprotected" },
      requirements: { status: "observed", requirements: [], strict: false, digest: DIGEST },
      workflowDefinitions: { status: "observed", definitions: [] },
      lists: {
        "branch-rules": page,
        "check-runs": page,
        "commit-statuses": page,
        "workflow-runs": page,
        reviews: page,
      },
    },
  };
}
function revision(snapshot = readySnapshot()): Parameters<typeof ciReadinessIsCurrent>[1] {
  return {
    runId: snapshot.runId,
    remoteDigest: snapshot.remoteDigest,
    repository: snapshot.repository,
    prNumber: snapshot.prNumber,
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    headRef: snapshot.headRef,
    headSha: snapshot.headSha,
    requirementsDigest: snapshot.requirementsDigest,
  };
}
function failedSource(
  identity: GitCiProviderFacts["identity"],
  failingName: string,
  retryId = 123,
): GitCiProviderFacts {
  const checks = ["build", "lint"].map((name, index) => ({
    ...CHECK,
    id: retryId + index,
    name,
    headSha: identity.headSha,
    conclusion: name === failingName ? "failure" : "success",
  }));
  return { ...failureFacts(checks, ["build", "lint"]), identity };
}
describe("durable exact-revision readiness producer", () => {
  it("identifies the failed required check independently of retries, counts and observation time", () => {
    const test = fixture();
    const first = produceCiReadinessSnapshot(
      test.draft,
      failedSource(test.facts.identity, "build"),
      Date.parse(AT),
    ).snapshot;
    const retry = produceCiReadinessSnapshot(
      test.draft,
      failedSource(test.facts.identity, "build", 223),
      Date.parse(AT) + 1000,
    ).snapshot;
    const different = produceCiReadinessSnapshot(
      test.draft,
      failedSource(test.facts.identity, "lint"),
      Date.parse(AT),
    ).snapshot;
    expect(first.state).toBe("failed");
    expect(first.failureSignatureDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(retry.failureSignatureDigest).toBe(first.failureSignatureDigest);
    expect(different.requiredChecks).toEqual(first.requiredChecks);
    expect(different.failureSignatureDigest).not.toBe(first.failureSignatureDigest);
    expect(different.evidenceRef).not.toBe(first.evidenceRef);
  });
  it("produces the closed contract from the existing provider assessment", () => {
    const test = fixture();
    const result = produceCiReadinessSnapshot(test.draft, test.facts, Date.parse(AT));
    expect(isReadinessSnapshot(result.snapshot)).toBe(true);
    expect(result.snapshot).toMatchObject({
      state: "technical-ready",
      complete: true,
      runId: "run-1",
      prNumber: 17,
    });
    expect(result.assessment?.checks.status).toBe("observed");
    expect(result.snapshot).not.toHaveProperty("checks");
  });
  it.each([
    { number: 18 },
    { externalId: "PR_OTHER" },
    { headRef: "other" },
    { headSha: "4".repeat(40) },
    { headRepository: "fork/repository" },
  ])("rejects provider data outside the bound draft %#", (identity) => {
    const test = fixture();
    expect(() =>
      produceCiReadinessSnapshot(
        test.draft,
        { ...test.facts, identity: { ...test.facts.identity, ...identity } },
        Date.parse(AT),
      ),
    ).toThrow("match accepted draft");
  });
  it("carries visibility failure as unknown with no inferred passing checks", () => {
    const test = fixture();
    const result = produceCiReadinessSnapshot(
      test.draft,
      { status: "unavailable", failure: { reason: "provider-forbidden", state: "unknown" } },
      Date.parse(AT),
    );
    expect(result.snapshot).toMatchObject({
      state: "unknown",
      complete: false,
      requirementsDigest: null,
    });
    expect(result.assessment).toBeUndefined();
  });
  it("binds the fresh base SHA independently from prior draft creation and description", () => {
    const test = fixture();
    const baseSha = "5".repeat(40);
    const result = produceCiReadinessSnapshot(
      test.draft,
      { ...test.facts, identity: { ...test.facts.identity, baseSha } },
      Date.parse(AT),
    );
    expect(result.snapshot.baseSha).toBe(baseSha);
    expect(
      ciReadinessIsCurrent(result.snapshot, revision(result.snapshot), Date.parse(AT) + 1),
    ).toBe(true);
    expect(
      ciReadinessIsCurrent(
        result.snapshot,
        { ...revision(result.snapshot), baseSha: test.draft.binding.baseSha },
        Date.parse(AT) + 1,
      ),
    ).toBe(false);
  });
  it("does not call an incomplete current-revision binding fresh", () => {
    const snapshot = readySnapshot();
    expect(
      ciReadinessIsCurrent(snapshot, {} as ReturnType<typeof revision>, Date.parse(AT) + 1),
    ).toBe(false);
  });
  it.each([-1, 60_000, 60_001])("rejects clock rollback or expiry at offset %i", (offset) => {
    const snapshot = readySnapshot();
    expect(ciReadinessIsCurrent(snapshot, revision(snapshot), Date.parse(AT) + offset)).toBe(false);
  });
  it("invalidates a changed required-workflow revision on the same head", () => {
    const snapshot = readySnapshot();
    expect(
      ciReadinessIsCurrent(
        snapshot,
        { ...revision(snapshot), requirementsDigest: "b".repeat(64) },
        Date.parse(AT) + 1,
      ),
    ).toBe(false);
  });
  it("overrides a still-failing reason with the exhausted repair budget's raw fact (#3384 B5-1)", () => {
    const test = fixture();
    const result = produceCiReadinessSnapshot(
      test.draft,
      failedSource(test.facts.identity, "build"),
      Date.parse(AT),
      true,
    );
    expect(result.snapshot).toMatchObject({ reason: "repair-budget-exhausted", state: "blocked" });
    // The underlying failure identity is untouched -- only the surfaced reason changes.
    expect(result.snapshot.failureSignatureDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("never overrides an already-passing reason with an exhausted repair budget", () => {
    const test = fixture();
    const result = produceCiReadinessSnapshot(test.draft, test.facts, Date.parse(AT), true);
    expect(result.snapshot).toMatchObject({
      reason: "required-checks-passed",
      state: "technical-ready",
    });
  });
  it("leaves the reason untouched when the repair budget is not exhausted", () => {
    const test = fixture();
    const result = produceCiReadinessSnapshot(
      test.draft,
      failedSource(test.facts.identity, "build"),
      Date.parse(AT),
      false,
    );
    expect(result.snapshot).toMatchObject({ reason: "required-checks-failed", state: "failed" });
  });
});
