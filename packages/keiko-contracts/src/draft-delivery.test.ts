import { describe, expect, it } from "vitest";
import { GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";
import {
  isDraftDeliveryBinding,
  isDraftDeliveryRecord,
  type DraftDeliveryBinding,
  type DraftDeliveryRecord,
} from "./draft-delivery.js";

const binding: DraftDeliveryBinding = {
  runId: "run-1",
  workspaceDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  envelopeDigest: "c".repeat(64),
  remoteDigest: "d".repeat(64),
  issueBindingDigest: "e".repeat(64),
  issueIdDigest: "f".repeat(64),
  issueNumber: 42,
  repository: "owner/repository",
  remoteAlias: "origin",
  baseRef: "main",
  baseSha: "1".repeat(40),
  headRef: "feature/issue-42",
  headSha: "2".repeat(40),
  verifiedCommitProposalId: "commit-1",
  recoveryId: "delivery-1",
};
const proposed: DraftDeliveryRecord = {
  schemaVersion: "1",
  binding,
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: "9".repeat(64),
  recordedAt: "2026-09-05T00:00:00.000Z",
};
const pullRequest = {
  number: 7,
  externalId: "PR_fixture7",
  url: "https://github.com/owner/repository/pull/7",
  repository: binding.repository,
  headRepository: binding.repository,
  headRef: binding.headRef,
  headSha: binding.headSha,
  baseRef: binding.baseRef,
  baseSha: binding.baseSha,
  state: "open",
  isDraft: true,
} as const;
const completed: DraftDeliveryRecord = {
  ...proposed,
  phase: "draft-created",
  reason: "completed",
  pullRequest,
};
const phases = [
  "push-proposed",
  "pushing",
  "pushed",
  "pr-proposed",
  "creating-pr",
  "draft-created",
  "recovery-required",
];
const phaseReasons = [
  ["push-proposed", "approval-required"],
  ["pushing", "in-flight"],
  ["pushed", "completed"],
  ["pr-proposed", "approval-required"],
  ["creating-pr", "in-flight"],
  ["draft-created", "completed"],
  ...[
    "authority-denied",
    "remote-drift",
    "issue-drift",
    "provider-failed",
    "ambiguous-remote",
    "approval-invalid",
    "payload-changed",
    "restart-reconciliation",
    "preflight-failed",
  ].map((reason) => ["recovery-required", reason]),
];

describe("closed immutable draft delivery binding", () => {
  it("admits the bounded canonical repository target", () => {
    expect(isDraftDeliveryBinding(binding)).toBe(true);
    expect(isDraftDeliveryBinding({ ...binding, issueNumber: GITHUB_ISSUE_NUMBER_MAX })).toBe(true);
  });

  it.each(Object.keys(binding))("requires own field %s", (field) => {
    const value = { ...binding };
    Reflect.deleteProperty(value, field);
    expect(isDraftDeliveryBinding(value)).toBe(false);
  });

  it.each([
    "workspaceDigest",
    "runtimeAuthorityDigest",
    "envelopeDigest",
    "remoteDigest",
    "issueBindingDigest",
    "issueIdDigest",
  ])("rejects non-sha256 %s", (field) => {
    for (const value of [
      undefined,
      null,
      1,
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "private text",
    ])
      expect(isDraftDeliveryBinding({ ...binding, [field]: value })).toBe(false);
  });

  it.each(["runId", "verifiedCommitProposalId", "recoveryId"])(
    "bounds body-free identity %s",
    (field) => {
      expect(isDraftDeliveryBinding({ ...binding, [field]: "a".repeat(128) })).toBe(true);
      for (const value of [
        undefined,
        null,
        "",
        "a".repeat(129),
        "path/to/file",
        "private text",
        "value\u202e",
      ])
        expect(isDraftDeliveryBinding({ ...binding, [field]: value })).toBe(false);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, GITHUB_ISSUE_NUMBER_MAX + 1, "42"])(
    "refuses invalid issue number %s",
    (issueNumber) => {
      expect(isDraftDeliveryBinding({ ...binding, issueNumber })).toBe(false);
    },
  );

  it.each([
    { remoteAlias: "upstream" },
    { repository: "https://github.com/owner/repository" },
    { repository: "owner/repo/extra" },
    { headRef: binding.baseRef },
    { baseRef: "refs/heads/main" },
    { headRef: "refs/heads/feature" },
    { headRef: "feature..escape" },
    { baseRef: "main\n" },
    { headSha: "not-a-sha" },
    { baseSha: "1".repeat(39) },
    { approvalToken: "fixture" },
    { message: "private text" },
    { repositoryPath: "/private/workspace" },
  ])("refuses invalid or extra target data %j", (override) => {
    expect(isDraftDeliveryBinding({ ...binding, ...override })).toBe(false);
  });

  it.each([null, undefined, true, [], "binding", 42])("refuses nonrecords %j", (value) => {
    expect(isDraftDeliveryBinding(value)).toBe(false);
    expect(isDraftDeliveryRecord(value)).toBe(false);
  });
});

describe("durable delivery phase and remote identity contract", () => {
  it.each(phaseReasons)("admits only the declared %s / %s pair", (phase, reason) => {
    expect(isDraftDeliveryRecord({ ...completed, phase, reason })).toBe(true);
    for (const other of phases.filter((candidate) => candidate !== phase)) {
      const pairDeclared = phaseReasons.some(
        ([knownPhase, knownReason]) => knownPhase === other && knownReason === reason,
      );
      expect(isDraftDeliveryRecord({ ...completed, phase: other, reason })).toBe(pairDeclared);
    }
  });

  it.each(Object.keys(proposed))("requires record field %s", (field) => {
    const value = { ...proposed };
    Reflect.deleteProperty(value, field);
    expect(isDraftDeliveryRecord(value)).toBe(false);
  });

  it.each([
    { schemaVersion: "2" },
    { revision: -1 },
    { revision: 0.5 },
    { revision: Number.NaN },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { recordedAt: "2026-02-30T00:00:00.000Z" },
    { recordedAt: "2026-09-05T00:00:00Z" },
    { recordedAt: "2026-09-05T00:00:00.000+00:00" },
    { phase: "created" },
    { phase: "__proto__" },
    { reason: "private text" },
    { proposalId: "" },
    { proposalId: "a".repeat(129) },
    { proposalDigest: "x".repeat(64) },
    { approvalToken: "fixture" },
    { title: "private text" },
    { body: "private text" },
    { recordedAt: null },
    { binding: { ...binding, extra: "fixture" } },
  ])("refuses invalid, body-bearing or authority-bearing metadata %j", (override) => {
    expect(isDraftDeliveryRecord({ ...proposed, ...override })).toBe(false);
  });

  it("admits the revision ceiling without losing integer precision", () => {
    expect(isDraftDeliveryRecord({ ...proposed, revision: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  it("requires a confirmed open draft with the exact approved head and base on completion", () => {
    expect(isDraftDeliveryRecord(completed)).toBe(true);
    expect(isDraftDeliveryRecord({ ...completed, pullRequest: undefined })).toBe(false);
    for (const override of [
      { headSha: "3".repeat(40) },
      { baseSha: "4".repeat(40) },
      { isDraft: false },
      { state: "closed" },
    ])
      expect(
        isDraftDeliveryRecord({ ...completed, pullRequest: { ...pullRequest, ...override } }),
      ).toBe(false);
  });

  it("retains last observed PR state during reconciliation without claiming it matches", () => {
    expect(
      isDraftDeliveryRecord({
        ...completed,
        phase: "recovery-required",
        reason: "remote-drift",
        pullRequest: { ...pullRequest, headSha: "3".repeat(40), state: "closed", isDraft: false },
      }),
    ).toBe(true);
    expect(isDraftDeliveryRecord(proposed)).toBe(true);
  });

  it.each([
    { repository: "other/repository", url: "https://github.com/other/repository/pull/7" },
    { headRepository: "fork/repository" },
    { baseRef: "dev" },
    { headRef: "other-feature" },
    { url: "javascript:alert(1)" },
    { url: "https://github.com/owner/repository/pull/8" },
    { url: "https://github.com.evil.invalid/owner/repository/pull/7" },
    { url: "https://github.com/owner/repository/pull/7?token=fixture" },
    { approvalToken: "fixture" },
    { externalId: "" },
    { number: 0 },
  ])("refuses foreign or contaminated remote facts even in recovery %j", (override) => {
    expect(
      isDraftDeliveryRecord({
        ...completed,
        phase: "recovery-required",
        reason: "remote-drift",
        pullRequest: { ...pullRequest, ...override },
      }),
    ).toBe(false);
  });

  it("compares repository identity case-insensitively without weakening ref equality", () => {
    expect(
      isDraftDeliveryRecord({
        ...completed,
        pullRequest: {
          ...pullRequest,
          repository: "OWNER/REPOSITORY",
          headRepository: "OWNER/Repository",
        },
      }),
    ).toBe(true);
    expect(
      isDraftDeliveryRecord({
        ...completed,
        pullRequest: { ...pullRequest, headRef: binding.headRef.toUpperCase() },
      }),
    ).toBe(false);
  });
});
