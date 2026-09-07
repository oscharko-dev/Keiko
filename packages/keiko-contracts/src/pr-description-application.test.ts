import { describe, expect, it } from "vitest";
import { isPrDescriptionApplicationStatus } from "./pr-description-application.js";

export const APPLICATION_STATUS = {
  schemaVersion: "1",
  state: "current",
  reason: "applied",
  binding: {
    repositoryId: "repo-test",
    remoteDigest: "a".repeat(64),
    repository: "owner/repo",
    prNumber: 123,
    prExternalId: "PR_kwTest",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRepository: "owner/repo",
    headRef: "feature",
    headSha: "b".repeat(40),
    isDraft: true,
    snapshotDigest: "b".repeat(64),
    draftDigest: "c".repeat(64),
    renderingVersion: "1",
    expectedBodyDigest: "d".repeat(64),
    outsideRegionDigest: "e".repeat(64),
    finalBodyDigest: "f".repeat(64),
    providerUpdatedAt: "2026-09-05T00:00:00.000Z",
  },
  observedAt: "2026-09-05T00:00:01.000Z",
  expiresAt: "2026-09-05T00:01:01.000Z",
  completeness: "complete",
  effect: "confirmed",
  concurrency: "read-check-write-verify",
} as const;

describe("PR description application status", () => {
  it("admits a closed body-free exact revision receipt", () => {
    expect(isPrDescriptionApplicationStatus(APPLICATION_STATUS)).toBe(true);
  });
  it.each([
    { body: "secret narrative" },
    { approval: "credential" },
    { state: "current", reason: "authority-denied" },
    { completeness: "partial" },
    { effect: "uncertain" },
    { expiresAt: APPLICATION_STATUS.observedAt },
    { expiresAt: "2026-09-06T00:00:00.000Z" },
    { concurrency: "atomic" },
  ])("rejects contradictory or hostile receipt %j", (patch) => {
    expect(isPrDescriptionApplicationStatus({ ...APPLICATION_STATUS, ...patch })).toBe(false);
  });
  it.each(["body", "approvalToken", "command", "url"])("rejects nested %s", (field) => {
    expect(
      isPrDescriptionApplicationStatus({
        ...APPLICATION_STATUS,
        binding: { ...APPLICATION_STATUS.binding, [field]: "hostile" },
      }),
    ).toBe(false);
  });
  it.each(["partial", "fallback"] as const)(
    "keeps %s application distinct from current",
    (state) => {
      expect(
        isPrDescriptionApplicationStatus({
          ...APPLICATION_STATUS,
          state,
          reason: `${state}-applied`,
          completeness: state,
        }),
      ).toBe(true);
    },
  );
});

it.each([
  { reason: "applied", effect: "reconciled" },
  { reason: "reconciled", effect: "confirmed" },
])("rejects contradictory successful effect provenance %j", (patch) => {
  expect(isPrDescriptionApplicationStatus({ ...APPLICATION_STATUS, ...patch })).toBe(false);
});
