import { describe, expect, it } from "vitest";
import { containsPrDescriptionMarker } from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { hasIssueClosingDirective } from "@oscharko-dev/keiko-contracts/runtime/issue-closing-directive";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  isVerifiedCommitResult,
  type VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import type { CodingRuntimeSnapshot } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { formatServerLogLine, type ServerLogEvent } from "../observability/server-log.js";
import {
  readDraftDeliveryChecks,
  renderDraftDeliveryChecks,
  type DraftDeliveryChecks,
} from "./draftDeliveryChecks.js";
import type { VerificationCheckRecord } from "./verificationChecks.js";

const COMMITTED = "c".repeat(64);
const HEAD = "6".repeat(40);
const EVIDENCE_ID = "verification-0e7d992a0f4a1ac45761c895d6d8dd8e61c34297";

// The receipt's binding: every field a verified-commit result carries whatever its outcome.
const BINDING = {
  schemaVersion: "1",
  runId: "run-1",
  proposalId: "commit-7f3a",
  envelopeDigest: "1".repeat(64),
  runtimeAuthorityDigest: "2".repeat(64),
  workspaceDigest: "3".repeat(64),
  repositoryDigest: "4".repeat(64),
  issueBindingDigest: "8".repeat(64),
  baseSha: "5".repeat(40),
  parentSha: "5".repeat(40),
  stagedTreeDigest: COMMITTED,
  verificationEvidenceId: EVIDENCE_ID,
  messageDigest: "7".repeat(64),
  recordedAt: "2026-09-11T08:26:20.846Z",
} as const;

function receipt(overrides: Partial<VerifiedCommitResult> = {}): VerifiedCommitResult {
  return {
    ...BINDING,
    status: "succeeded",
    reason: "completed",
    headSha: HEAD,
    committedTreeDigest: COMMITTED,
    ...overrides,
  };
}

// A valid result that did not commit: the write-ahead marker's own shape, with no head.
function uncommittedReceipt(overrides: Partial<VerifiedCommitResult> = {}): VerifiedCommitResult {
  return { ...BINDING, status: "recovery-required", reason: "execution-uncertain", ...overrides };
}

// The delivery the pull request is for, bound to the receipt above.
const RECORD: DraftDeliveryRecord = {
  schemaVersion: "1",
  binding: {
    runId: BINDING.runId,
    workspaceDigest: BINDING.workspaceDigest,
    runtimeAuthorityDigest: BINDING.runtimeAuthorityDigest,
    envelopeDigest: BINDING.envelopeDigest,
    remoteDigest: BINDING.repositoryDigest,
    issueBindingDigest: BINDING.issueBindingDigest,
    issueIdDigest: "9".repeat(64),
    issueNumber: 1,
    repository: "oscharko/wegwerf-repo-final",
    remoteAlias: "origin",
    baseRef: "master",
    baseSha: BINDING.baseSha,
    headRef: "keiko/task/coding-workbench-issue-1",
    headSha: HEAD,
    verifiedCommitProposalId: BINDING.proposalId,
    recoveryId: "recovery-1",
  },
  revision: 1,
  phase: "pushed",
  reason: "completed",
  proposalId: "draft-push-1",
  proposalDigest: "a".repeat(64),
  recordedAt: "2026-09-11T08:26:35.000Z",
};

// Only the fields `localDraftDeliverySource` reads; the real store path is proven by the draft
// delivery service tests.
function snapshotWith(latest: VerifiedCommitResult | undefined): CodingRuntimeSnapshot {
  return {
    runId: BINDING.runId,
    authorityDigest: BINDING.runtimeAuthorityDigest,
    ...(latest === undefined ? {} : { verifiedCommitResult: latest }),
  } as unknown as CodingRuntimeSnapshot;
}

const RECORDS: readonly VerificationCheckRecord[] = [
  {
    startedAtMs: 1,
    install: {
      state: "installed",
      lockfile: "created",
      exitCode: 0,
      durationMs: 6_100,
      egressAllowed: 15,
      egressRefused: 0,
    },
    steps: [{ kind: "build", status: "failed", exitCode: 1, durationMs: 1_240 }],
  },
  {
    startedAtMs: 2,
    stagedTreeDigest: "b".repeat(64),
    steps: [{ kind: "typecheck", status: "timed-out", exitCode: null, durationMs: 120_000 }],
  },
  {
    startedAtMs: 3,
    stagedTreeDigest: COMMITTED,
    install: { state: "current", lockfile: "present", exitCode: null, durationMs: 0 },
    steps: [{ kind: "build", status: "passed", exitCode: 0, durationMs: 867 }],
  },
];
const EVIDENCE = JSON.stringify({ schemaVersion: "1", checks: { records: RECORDS, omitted: 1 } });

function listed(records = RECORDS, omitted = 0): DraftDeliveryChecks {
  return {
    status: "listed",
    evidenceId: EVIDENCE_ID,
    headSha: HEAD,
    committedTreeDigest: COMMITTED,
    history: { records, omitted },
  };
}

interface ReadInput {
  readonly snapshot?: CodingRuntimeSnapshot | undefined;
  readonly lineage?: VerifiedCommitResult | undefined;
  readonly get: (id: string) => string | undefined;
}

function read(input: ReadInput): {
  readonly checks: DraftDeliveryChecks;
  readonly log: readonly ServerLogEvent[];
} {
  const log: ServerLogEvent[] = [];
  const checks = readDraftDeliveryChecks({
    snapshots: {
      get: () => input.snapshot,
      getLastSuccessfulVerifiedCommit: () => input.lineage,
    },
    evidenceStore: { get: input.get },
    record: RECORD,
    correlationId: "draft-checks-fixture",
    activityLog: {
      write: (event): void => {
        log.push(event);
      },
    },
  });
  return { checks, log };
}

const onlyEvidence = (id: string): string | undefined =>
  id === EVIDENCE_ID ? EVIDENCE : undefined;

describe("reading the delivered commit's checks (F57)", () => {
  it("lists the history the commit proof's evidence carries and logs its size", () => {
    const { checks, log } = read({ snapshot: snapshotWith(receipt()), get: onlyEvidence });
    expect(checks).toEqual(listed(RECORDS, 1));
    expect(log).toEqual([
      {
        category: "process",
        op: "git.draft-checks",
        correlationId: "draft-checks-fixture",
        extra: {
          runId: "run-1",
          state: "listed",
          verificationEvidenceId: EVIDENCE_ID,
          recordCount: 3,
          omittedCount: 1,
        },
      },
    ]);
  });
  it("lists the delivered commit's checks when a later proposal is the latest result", () => {
    const later = uncommittedReceipt({
      proposalId: "commit-later",
      verificationEvidenceId: "verification-later",
    });
    expect(isVerifiedCommitResult(later)).toBe(true);
    const { checks } = read({
      snapshot: snapshotWith(later),
      lineage: receipt(),
      get: onlyEvidence,
    });
    expect(checks).toEqual(listed(RECORDS, 1));
  });
  it("never lists the checks of a commit this delivery does not carry", () => {
    const other = receipt({ proposalId: "commit-other", headSha: "d".repeat(40) });
    expect(isVerifiedCommitResult(other)).toBe(true);
    const { checks } = read({ snapshot: snapshotWith(other), get: () => EVIDENCE });
    expect(checks).toEqual({ status: "unavailable", reason: "receipt-missing" });
  });
  it("treats a valid receipt that did not commit as having no checks to list", () => {
    const pending = uncommittedReceipt();
    expect(isVerifiedCommitResult(pending)).toBe(true);
    const { checks, log } = read({ snapshot: snapshotWith(pending), get: () => EVIDENCE });
    expect(checks).toEqual({ status: "unavailable", reason: "receipt-missing" });
    expect(log[0]).toMatchObject({
      level: "warn",
      extra: { state: "unavailable", reason: "receipt-missing" },
    });
    expect(log[0]).not.toHaveProperty("errorKind");
  });
  it("reports a run the store no longer holds as having no receipt", () => {
    const { checks } = read({ snapshot: undefined, lineage: receipt(), get: () => EVIDENCE });
    expect(checks).toEqual({ status: "unavailable", reason: "receipt-missing" });
  });
  it.each([
    ["missing evidence", undefined, "evidence-missing"],
    ["evidence without a history", JSON.stringify({ commands: [] }), "evidence-invalid"],
  ] as const)("reports %s as unavailable", (_label, stored, reason) => {
    const { checks, log } = read({ snapshot: snapshotWith(receipt()), get: () => stored });
    expect(checks).toEqual({ status: "unavailable", reason });
    expect(log[0]).toMatchObject({ level: "warn", extra: { state: "unavailable", reason } });
  });
  it("logs an evidence store that throws as an internal error, body-free", () => {
    const { checks, log } = read({
      snapshot: snapshotWith(receipt()),
      get: () => {
        throw new Error("/private/evidence/dir unreadable token=sk-private-secret");
      },
    });
    expect(checks).toEqual({ status: "unavailable", reason: "evidence-unreadable" });
    expect(log[0]).toMatchObject({
      level: "warn",
      errorKind: "internal",
      extra: { state: "unavailable", reason: "evidence-unreadable", errorClass: "Error" },
    });
    const encoded = log.map((event) => formatServerLogLine(event)).join("\n");
    expect(encoded).not.toContain("/private/evidence");
    expect(encoded).not.toContain("sk-private");
  });
});

describe("rendering the Checks section (F57)", () => {
  it("renders every step and a real install in order, naming where each ran", () => {
    expect(renderDraftDeliveryChecks(listed())).toEqual({
      rowCount: 4,
      markdown: [
        "## Checks",
        "",
        "Keiko ran these checks through its verification tool in the task workspace. The results come from its verification evidence, not from model output; commands run by other means are not listed.",
        "",
        "| Check | Result | Exit code | Duration | Ran on |",
        "| --- | --- | --- | --- | --- |",
        "| dependency install | installed, lockfile created; 15 registry connections, 0 refused | 0 | 6.1 s | working tree |",
        "| build | failed | 1 | 1.2 s | working tree |",
        "| type check | timed out | none | 120.0 s | earlier staged change |",
        "| build | passed | 0 | 867 ms | committed change |",
        "",
        '"Ran on" names the state each check verified: "committed change" is the exact tree of the commit named below; "earlier staged change" and "working tree" are earlier states of the work, so their results do not prove that commit.',
        "",
        `Evidence for commit 666666666666: ${EVIDENCE_ID}. Later commits on this branch are not covered here.`,
      ].join("\n"),
    });
  });
  it("says so instead of listing anything when the evidence could not be read", () => {
    expect(
      renderDraftDeliveryChecks({ status: "unavailable", reason: "evidence-missing" }),
    ).toEqual({
      rowCount: 0,
      markdown:
        "## Checks\n\nKeiko could not read its verification evidence for this commit, so no checks are listed here.",
    });
  });
  it.each([
    [1, "1 earlier verification call is not listed."],
    [5, "5 earlier verification calls are not listed."],
  ])("names %i omitted verification call(s)", (omitted, line) => {
    expect(renderDraftDeliveryChecks(listed(RECORDS, omitted)).markdown).toContain(
      `\n\n${line}\n\n`,
    );
  });
  it("renders an install that was refused, and none for one that was not needed", () => {
    const { markdown, rowCount } = renderDraftDeliveryChecks(
      listed([
        {
          startedAtMs: 1,
          install: { state: "refused", lockfile: "absent", exitCode: null, durationMs: 3 },
          steps: [],
        },
        {
          startedAtMs: 2,
          install: { state: "none", lockfile: "absent", exitCode: null, durationMs: 0 },
          steps: [],
        },
      ]),
    );
    expect(rowCount).toBe(1);
    expect(markdown).toContain(
      "| dependency install | refused, no lockfile | none | 3 ms | working tree |",
    );
  });
  it("states that no step was recorded when the history holds none", () => {
    expect(renderDraftDeliveryChecks(listed([{ startedAtMs: 1, steps: [] }]))).toMatchObject({
      rowCount: 0,
      markdown: expect.stringContaining(
        "Keiko recorded no verification step for this commit.",
      ) as unknown,
    });
  });
  it("can never render a managed-region marker or a closing directive", () => {
    const kinds = ["test", "targeted-test", "typecheck", "lint", "build"] as const;
    const statuses = [
      "passed",
      "failed",
      "skipped",
      "denied",
      "timed-out",
      "cancelled",
      "resource-exceeded",
    ] as const;
    const records: VerificationCheckRecord[] = kinds.map((kind, index) => ({
      startedAtMs: index,
      stagedTreeDigest: COMMITTED,
      steps: statuses.map((status) => ({ kind, status, exitCode: null, durationMs: 1 })),
    }));
    const { markdown, rowCount } = renderDraftDeliveryChecks(listed(records));
    expect(containsPrDescriptionMarker(markdown)).toBe(false);
    expect(hasIssueClosingDirective(markdown)).toBe(false);
    expect(rowCount).toBe(kinds.length * statuses.length);
  });
});
