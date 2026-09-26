import { describe, expect, it } from "vitest";
import {
  isObservedReadyRebinding,
  isPrDescriptionApplicationStatus,
} from "./pr-description-application.js";

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

// #3390: the one identity-preserving binding change. Producer (effect layer) and consumer (durable
// receipt) both call this predicate, so the transition has exactly one definition.
describe("observed ready rebinding", () => {
  const draft = APPLICATION_STATUS.binding;
  const ready = { ...draft, isDraft: false, providerUpdatedAt: "2026-09-05T00:00:30.000Z" };
  it("admits the draft-to-ready transition that keeps every identity and content field", () => {
    expect(isObservedReadyRebinding(draft, ready)).toBe(true);
    expect(
      isObservedReadyRebinding(draft, { ...ready, providerUpdatedAt: draft.providerUpdatedAt }),
    ).toBe(true);
  });
  it.each([
    { name: "a draft that stays draft", previous: draft, next: { ...ready, isDraft: true } },
    { name: "a ready reversal", previous: ready, next: draft },
    {
      name: "a provider timestamp moving backwards",
      previous: draft,
      next: { ...ready, providerUpdatedAt: "2026-09-04T00:00:00.000Z" },
    },
    {
      name: "an unparseable provider timestamp",
      previous: draft,
      next: { ...ready, providerUpdatedAt: "later" },
    },
    { name: "a moved head", previous: draft, next: { ...ready, headSha: "c".repeat(40) } },
    { name: "a moved base", previous: draft, next: { ...ready, baseRef: "release" } },
    {
      name: "a different body",
      previous: draft,
      next: { ...ready, finalBodyDigest: "0".repeat(64) },
    },
    { name: "a different pull request", previous: draft, next: { ...ready, prNumber: 124 } },
    {
      name: "a different repository checkout",
      previous: draft,
      next: { ...ready, repositoryId: "repo-other" },
    },
  ])("rejects $name", ({ previous, next }) => {
    expect(isObservedReadyRebinding(previous, next)).toBe(false);
  });
});
