// Unit tests for the governed Git mutation evidence ledger (Issue #474, Epic #470).
// Proves: append into the date-bucketed ledger; AC5 — every persisted string leaf is redacted so no
// secret reaches disk; the per-bucket bound keeps only the most recent records; a corrupt ledger
// document fails closed (never overwritten) and the audit write never throws into the caller's path.

import { describe, expect, it, vi } from "vitest";
import { redact } from "@oscharko-dev/keiko-security";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitDeliveryEvidenceRecord } from "@oscharko-dev/keiko-contracts";
import {
  gitDeliveryEvidenceRunIdFor,
  recordGitDeliveryMutationEvidence,
  type GitDeliveryEvidenceLedgerDoc,
} from "./mutationEvidenceLedger.js";

const DAY1 = Date.UTC(2026, 5, 20, 9, 0, 0);
const DAY2 = Date.UTC(2026, 5, 21, 9, 0, 0);

// Split-string secret fixtures so the literal never appears in this source file.
const SK_FAKE = ["sk", "-live-", "ABCDEFGHIJKLMNOP1234567890"].join("");
const BEARER_FAKE = ["Bearer ", "abcdef0123456789ABCDEF0123456789abcd"].join("");

function record(overrides: Partial<GitDeliveryEvidenceRecord> = {}): GitDeliveryEvidenceRecord {
  return {
    schemaVersion: "1",
    evidenceId: "gde-fixture-0000000000000000000000000000",
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
    recordedAtMs: DAY1,
    ...overrides,
  };
}

function readDoc(
  store: ReturnType<typeof createInMemoryEvidenceStore>,
  runId: string,
): {
  readonly json: string | undefined;
  readonly doc: GitDeliveryEvidenceLedgerDoc | undefined;
} {
  const json = store.get(runId);
  return {
    json,
    doc: json === undefined ? undefined : (JSON.parse(json) as GitDeliveryEvidenceLedgerDoc),
  };
}

const redactString = (input: string): string => redact(input);

describe("recordGitDeliveryMutationEvidence — append + buckets", () => {
  it("appends a record under its UTC date-bucket run id", () => {
    const store = createInMemoryEvidenceStore();
    recordGitDeliveryMutationEvidence({ evidenceStore: store, redactString }, record());
    const runId = gitDeliveryEvidenceRunIdFor(DAY1);
    expect(runId).toBe("git-delivery-evidence-2026-06-20");
    const { doc } = readDoc(store, runId);
    expect(doc?.records).toHaveLength(1);
    expect(doc?.records[0]?.evidenceId).toBe("gde-fixture-0000000000000000000000000000");
  });

  it("buckets records from different UTC days separately", () => {
    const store = createInMemoryEvidenceStore();
    recordGitDeliveryMutationEvidence({ evidenceStore: store, redactString }, record());
    recordGitDeliveryMutationEvidence(
      { evidenceStore: store, redactString },
      record({ evidenceId: "gde-day2", recordedAtMs: DAY2 }),
    );
    expect(readDoc(store, gitDeliveryEvidenceRunIdFor(DAY1)).doc?.records).toHaveLength(1);
    expect(readDoc(store, gitDeliveryEvidenceRunIdFor(DAY2)).doc?.records).toHaveLength(1);
  });
});

describe("recordGitDeliveryMutationEvidence — AC5 no secret reaches disk", () => {
  it("redacts secret-shaped string leaves before persisting", () => {
    const store = createInMemoryEvidenceStore();
    recordGitDeliveryMutationEvidence(
      { evidenceStore: store, redactString },
      record({
        repoContext: {
          targetBranchName: `feature/${SK_FAKE}`,
          headDetached: false,
          stagedFileCount: 1,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
        correlation: { workflowRunIdHash: "a".repeat(64), actionId: BEARER_FAKE },
      }),
    );
    const { json } = readDoc(store, gitDeliveryEvidenceRunIdFor(DAY1));
    expect(json).toBeDefined();
    expect(json).not.toContain(SK_FAKE);
    expect(json).not.toContain(BEARER_FAKE);
    expect(json).toContain("[REDACTED]");
  });
});

describe("recordGitDeliveryMutationEvidence — bounded ledger", () => {
  it("keeps only the most recent records per bucket", () => {
    const store = createInMemoryEvidenceStore();
    for (let i = 0; i < 4; i += 1) {
      recordGitDeliveryMutationEvidence(
        { evidenceStore: store, redactString, maxRecordsPerBucket: 2 },
        record({ evidenceId: `gde-${String(i)}` }),
      );
    }
    const { doc } = readDoc(store, gitDeliveryEvidenceRunIdFor(DAY1));
    expect(doc?.records.map((r) => r.evidenceId)).toStrictEqual(["gde-2", "gde-3"]);
  });
});

describe("recordGitDeliveryMutationEvidence — fail-closed + never throws", () => {
  it("reports a corrupt ledger via onPersistError and preserves the artifact", () => {
    const store = createInMemoryEvidenceStore();
    const runId = gitDeliveryEvidenceRunIdFor(DAY1);
    store.put(runId, "{ this is not valid json");
    const onPersistError = vi.fn();
    expect(() => {
      recordGitDeliveryMutationEvidence(
        { evidenceStore: store, redactString, onPersistError },
        record(),
      );
    }).not.toThrow();
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(store.get(runId)).toBe("{ this is not valid json");
  });

  it("never throws even when the store update throws", () => {
    const onPersistError = vi.fn();
    const throwingStore: EvidenceStore = {
      put: (): string => {
        throw new Error("disk full");
      },
      get: (): string | undefined => undefined,
      list: (): readonly string[] => [],
      delete: (): void => {
        /* no-op */
      },
    };
    expect(() => {
      recordGitDeliveryMutationEvidence(
        { evidenceStore: throwingStore, redactString, onPersistError },
        record(),
      );
    }).not.toThrow();
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });
});
