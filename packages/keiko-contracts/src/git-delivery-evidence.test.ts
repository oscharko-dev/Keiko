// Unit tests for the governed Git mutation evidence contract (Issue #474, Epic #470).
// Proves: the AC1 outcome-class + AC3 disposition vocabularies are closed and total; the
// recovery-disposition derivations are exhaustive and correctly classify retryable / user-fixable /
// policy-forbidden; the audit-packet builder counts every record by class and disposition; and the
// structural guards fail closed on malformed records (the on-read tamper gate).

import { describe, expect, it } from "vitest";
import {
  GIT_DELIVERY_AUDIT_PACKET_KNOWN_LIMITATIONS,
  GIT_DELIVERY_BLOCK_REASONS,
  GIT_DELIVERY_EVIDENCE_LIFECYCLE_PHASES,
  GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES,
  GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
  GIT_DELIVERY_EXECUTION_ERROR_CODES,
  GIT_DELIVERY_RECOVERY_DISPOSITIONS,
  buildGitDeliveryAuditPacket,
  gitDeliveryRecoveryDispositionForBlockReason,
  gitDeliveryRecoveryDispositionForExecutionError,
  isGitDeliveryAuditPacket,
  isGitDeliveryEvidenceOutcomeClass,
  isGitDeliveryEvidenceRecord,
  isGitDeliveryRecoveryDisposition,
  isGitDeliveryRecoveryMetadata,
  type GitDeliveryEvidenceOutcomeClass,
  type GitDeliveryEvidenceRecord,
  type GitDeliveryRecoveryDisposition,
} from "./index.js";

function baseRecord(overrides: Partial<GitDeliveryEvidenceRecord> = {}): GitDeliveryEvidenceRecord {
  return {
    schemaVersion: GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "gde-0000000000000000000000000000000000000000",
    actionKind: "commit",
    riskClass: "local-mutation",
    riskSeverity: 1,
    outcomeClass: "succeeded",
    phaseReached: "result",
    policyOutcome: "allowed",
    correlation: { workflowRunIdHash: "a".repeat(64), actionId: "act-1" },
    approval: { required: false },
    repoContext: {
      targetBranchName: "feature/x",
      headDetached: false,
      stagedFileCount: 1,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
    recovery: { disposition: "none" },
    recordedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("git-delivery-evidence vocabularies", () => {
  it("pins the schema version and the closed enums", () => {
    expect(GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION).toBe("1");
    expect([...GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES]).toStrictEqual([
      "succeeded",
      "blocked",
      "rejected",
      "failed",
      "recovery-required",
      "approval-required",
    ]);
    expect([...GIT_DELIVERY_RECOVERY_DISPOSITIONS]).toStrictEqual([
      "retryable",
      "user-fixable",
      "policy-forbidden",
      "none",
    ]);
    expect([...GIT_DELIVERY_EVIDENCE_LIFECYCLE_PHASES]).toStrictEqual([
      "resolve",
      "preflight",
      "preview",
      "policy",
      "execute",
      "result",
    ]);
  });

  it("guards accept members and reject non-members", () => {
    for (const cls of GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES) {
      expect(isGitDeliveryEvidenceOutcomeClass(cls)).toBe(true);
    }
    expect(isGitDeliveryEvidenceOutcomeClass("nope")).toBe(false);
    expect(isGitDeliveryRecoveryDisposition("retryable")).toBe(true);
    expect(isGitDeliveryRecoveryDisposition("maybe")).toBe(false);
  });
});

describe("recovery-disposition derivations (AC3)", () => {
  it("classifies every execution error code without a default fall-through", () => {
    const expected: Record<string, GitDeliveryRecoveryDisposition> = {
      "provider-rejected": "user-fixable",
      "network-failure": "retryable",
      conflict: "user-fixable",
      "precondition-failed": "user-fixable",
      timeout: "retryable",
      "internal-error": "retryable",
    };
    for (const code of GIT_DELIVERY_EXECUTION_ERROR_CODES) {
      expect(gitDeliveryRecoveryDispositionForExecutionError(code)).toBe(expected[code]);
    }
  });

  it("classifies every block reason and never marks a policy denial retryable", () => {
    const expected: Record<string, GitDeliveryRecoveryDisposition> = {
      "policy-pack-blocked": "policy-forbidden",
      "protected-branch": "policy-forbidden",
      "provider-capability-absent": "policy-forbidden",
      "approval-expired": "user-fixable",
      "risk-class-ceiling": "policy-forbidden",
      "no-applicable-rule": "policy-forbidden",
    };
    for (const reason of GIT_DELIVERY_BLOCK_REASONS) {
      const disposition = gitDeliveryRecoveryDispositionForBlockReason(reason);
      expect(disposition).toBe(expected[reason]);
      expect(disposition).not.toBe("retryable");
    }
  });

  it("validates recovery metadata and rejects an unknown disposition", () => {
    expect(
      isGitDeliveryRecoveryMetadata({
        disposition: "user-fixable",
        actionHint: "request-approval",
      }),
    ).toBe(true);
    expect(isGitDeliveryRecoveryMetadata({ disposition: "none" })).toBe(true);
    expect(isGitDeliveryRecoveryMetadata({ disposition: "totally-fine" })).toBe(false);
    expect(isGitDeliveryRecoveryMetadata({ disposition: "none", actionHint: "not-a-hint" })).toBe(
      false,
    );
  });
});

describe("audit packet (AC4)", () => {
  it("counts records by outcome class and recovery disposition", () => {
    const records: readonly GitDeliveryEvidenceRecord[] = [
      baseRecord({ outcomeClass: "succeeded", recovery: { disposition: "none" } }),
      baseRecord({
        evidenceId: "gde-b",
        outcomeClass: "blocked",
        recovery: { disposition: "policy-forbidden", actionHint: "adjust-policy-target" },
      }),
      baseRecord({
        evidenceId: "gde-c",
        outcomeClass: "rejected",
        recovery: { disposition: "user-fixable", actionHint: "resolve-conflicts" },
      }),
    ];
    const packet = buildGitDeliveryAuditPacket(records, 1_700_000_000_001);
    expect(packet.recordCount).toBe(3);
    expect(packet.outcomeClassCounts.succeeded).toBe(1);
    expect(packet.outcomeClassCounts.blocked).toBe(1);
    expect(packet.outcomeClassCounts.rejected).toBe(1);
    expect(packet.outcomeClassCounts.failed).toBe(0);
    expect(packet.recoveryDispositionCounts.none).toBe(1);
    expect(packet.recoveryDispositionCounts["policy-forbidden"]).toBe(1);
    expect(packet.recoveryDispositionCounts["user-fixable"]).toBe(1);
    expect(packet.recoveryDispositionCounts.retryable).toBe(0);
    expect(isGitDeliveryAuditPacket(packet)).toBe(true);
  });

  it("carries the honest known-limitations list and is empty-safe", () => {
    const packet = buildGitDeliveryAuditPacket([], 1, ["extra limitation"]);
    expect(packet.recordCount).toBe(0);
    expect(packet.knownLimitations).toContain("extra limitation");
    expect(packet.knownLimitations.length).toBe(
      GIT_DELIVERY_AUDIT_PACKET_KNOWN_LIMITATIONS.length + 1,
    );
    const allClasses = Object.values(packet.outcomeClassCounts);
    expect(allClasses.every((n) => n === 0)).toBe(true);
  });
});

describe("evidence record guard (on-read tamper gate)", () => {
  it("accepts a well-formed record", () => {
    expect(isGitDeliveryEvidenceRecord(baseRecord())).toBe(true);
  });

  it("rejects a wrong schema version", () => {
    expect(isGitDeliveryEvidenceRecord({ ...baseRecord(), schemaVersion: "2" })).toBe(false);
  });

  it("rejects an unknown outcome class", () => {
    const bad = { ...baseRecord(), outcomeClass: "exploded" as GitDeliveryEvidenceOutcomeClass };
    expect(isGitDeliveryEvidenceRecord(bad)).toBe(false);
  });

  it("rejects a missing correlation section", () => {
    const record: Record<string, unknown> = { ...baseRecord() };
    delete record.correlation;
    expect(isGitDeliveryEvidenceRecord(record)).toBe(false);
  });

  it("rejects a malformed recovery section", () => {
    expect(
      isGitDeliveryEvidenceRecord({ ...baseRecord(), recovery: { disposition: "bogus" } }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isGitDeliveryEvidenceRecord(null)).toBe(false);
    expect(isGitDeliveryEvidenceRecord("record")).toBe(false);
    expect(isGitDeliveryEvidenceRecord([baseRecord()])).toBe(false);
  });
});
