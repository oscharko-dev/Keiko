// Unit tests for the fetch/pull sync evidence ledger (Issue #1573, Epic #1572).
//
// Mirror the mutation-ledger guarantees: ONE date-bucketed document per UTC day, append-and-bound,
// `update ?? get+put`, leaf-level redaction, fail-closed on corruption, never throws into the caller,
// and a content-free repository identifier (hash, never the path).

import { describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  gitSyncEvidenceRunIdFor,
  gitSyncRepoIdHash,
  recordGitSyncEvidence,
  GIT_SYNC_EVIDENCE_RUNID_PREFIX,
  GIT_SYNC_EVIDENCE_SCHEMA_VERSION,
  type GitSyncEvidenceLedgerDoc,
  type GitSyncEvidenceRecord,
} from "./syncEvidence.js";

const AT = Date.UTC(2026, 5, 27, 9, 30, 0); // 2026-06-27T09:30:00Z

function record(overrides: Partial<GitSyncEvidenceRecord> = {}): GitSyncEvidenceRecord {
  return {
    schemaVersion: GIT_SYNC_EVIDENCE_SCHEMA_VERSION,
    operation: "fetch",
    outcome: "succeeded",
    repoIdHash: "0123456789abcdef01234567",
    branch: "main",
    remote: "origin",
    aheadBefore: 0,
    behindBefore: 2,
    aheadAfter: 0,
    behindAfter: 0,
    recordedAtMs: AT,
    ...overrides,
  };
}

function inMemoryStore(): { store: EvidenceStore; docs: Map<string, string> } {
  const docs = new Map<string, string>();
  return {
    docs,
    store: {
      put: (runId, json): string => {
        docs.set(runId, json);
        return runId;
      },
      list: () => [...docs.keys()],
      get: (runId) => docs.get(runId),
      delete: (runId) => docs.delete(runId),
    },
  };
}

// A store that exercises the update() serialize path instead of get+put.
function updatingStore(): { store: EvidenceStore; docs: Map<string, string> } {
  const base = inMemoryStore();
  return {
    docs: base.docs,
    store: {
      ...base.store,
      update: (runId, update): string => {
        const next = update(base.docs.get(runId));
        base.docs.set(runId, next);
        return runId;
      },
    },
  };
}

function bucket(docs: Map<string, string>, runId: string): GitSyncEvidenceLedgerDoc {
  const json = docs.get(runId);
  if (json === undefined) throw new Error("bucket missing");
  return JSON.parse(json) as GitSyncEvidenceLedgerDoc;
}

const identityRedact = (input: string): string => input;

describe("gitSyncEvidenceRunIdFor", () => {
  it("buckets by UTC date with the sync prefix", () => {
    expect(gitSyncEvidenceRunIdFor(AT)).toBe(`${GIT_SYNC_EVIDENCE_RUNID_PREFIX}2026-06-27`);
  });

  it("buckets two records on the same UTC day into the same runId", () => {
    const later = AT + 6 * 60 * 60 * 1000;
    expect(gitSyncEvidenceRunIdFor(later)).toBe(gitSyncEvidenceRunIdFor(AT));
  });

  it("buckets the next UTC day separately", () => {
    const next = AT + 24 * 60 * 60 * 1000;
    expect(gitSyncEvidenceRunIdFor(next)).not.toBe(gitSyncEvidenceRunIdFor(AT));
  });
});

describe("gitSyncRepoIdHash", () => {
  it("is the 24-char prefix of sha256Hex(root) and never the path", () => {
    const root = "/home/u/projects/secret-repo";
    const hash = gitSyncRepoIdHash(root);
    expect(hash).toBe(sha256Hex(root).slice(0, 24));
    expect(hash.length).toBe(24);
    expect(hash).not.toContain("secret-repo");
  });
});

describe("recordGitSyncEvidence — persistence", () => {
  it("writes one record into the day bucket via get+put", () => {
    const { store, docs } = inMemoryStore();
    recordGitSyncEvidence({ evidenceStore: store, redactString: identityRedact }, record());
    const runId = gitSyncEvidenceRunIdFor(AT);
    const doc = bucket(docs, runId);
    expect(doc.schemaVersion).toBe(GIT_SYNC_EVIDENCE_SCHEMA_VERSION);
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0]?.operation).toBe("fetch");
    expect(doc.records[0]?.outcome).toBe("succeeded");
  });

  it("appends through the update() serialize path", () => {
    const { store, docs } = updatingStore();
    recordGitSyncEvidence({ evidenceStore: store, redactString: identityRedact }, record());
    recordGitSyncEvidence(
      { evidenceStore: store, redactString: identityRedact },
      record({ operation: "pull", outcome: "up-to-date" }),
    );
    const doc = bucket(docs, gitSyncEvidenceRunIdFor(AT));
    expect(doc.records).toHaveLength(2);
    expect(doc.records[1]?.operation).toBe("pull");
  });

  it("bounds the bucket to the most recent N records", () => {
    const { store, docs } = inMemoryStore();
    for (let i = 0; i < 5; i += 1) {
      recordGitSyncEvidence(
        { evidenceStore: store, redactString: identityRedact, maxRecordsPerBucket: 3 },
        record({ behindBefore: i }),
      );
    }
    const doc = bucket(docs, gitSyncEvidenceRunIdFor(AT));
    expect(doc.records).toHaveLength(3);
    // The oldest two (behindBefore 0,1) were evicted; the most recent three remain.
    expect(doc.records.map((r) => r.behindBefore)).toEqual([2, 3, 4]);
  });

  it("applies the string-leaf redactor to every record string", () => {
    const { store, docs } = inMemoryStore();
    const redact = (input: string): string => (input === "origin" ? "[redacted]" : input);
    recordGitSyncEvidence({ evidenceStore: store, redactString: redact }, record());
    const doc = bucket(docs, gitSyncEvidenceRunIdFor(AT));
    expect(doc.records[0]?.remote).toBe("[redacted]");
    expect(doc.records[0]?.branch).toBe("main");
  });
});

describe("recordGitSyncEvidence — best-effort and fail-closed", () => {
  it("never throws and reports a put failure through onPersistError", () => {
    let captured: unknown;
    const store: EvidenceStore = {
      put: () => {
        throw new Error("disk full");
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    };
    expect(() => {
      recordGitSyncEvidence(
        {
          evidenceStore: store,
          redactString: identityRedact,
          onPersistError: (error) => {
            captured = error;
          },
        },
        record(),
      );
    }).not.toThrow();
    expect(captured).toBeInstanceOf(Error);
  });

  it("fails closed on a corrupt bucket and preserves the existing artifact", () => {
    const { store, docs } = inMemoryStore();
    const runId = gitSyncEvidenceRunIdFor(AT);
    docs.set(runId, "{not-json");
    let captured: unknown;
    recordGitSyncEvidence(
      {
        evidenceStore: store,
        redactString: identityRedact,
        onPersistError: (error) => {
          captured = error;
        },
      },
      record(),
    );
    expect(captured).toBeInstanceOf(Error);
    // The corrupt artifact is untouched — not overwritten with a fresh bucket.
    expect(docs.get(runId)).toBe("{not-json");
  });

  it("fails closed on a structurally wrong bucket (records not an array)", () => {
    const { store, docs } = inMemoryStore();
    const runId = gitSyncEvidenceRunIdFor(AT);
    docs.set(runId, JSON.stringify({ schemaVersion: "1", records: "nope" }));
    let captured: unknown;
    recordGitSyncEvidence(
      {
        evidenceStore: store,
        redactString: identityRedact,
        onPersistError: (error) => {
          captured = error;
        },
      },
      record(),
    );
    expect(captured).toBeInstanceOf(Error);
    const preserved = JSON.parse(docs.get(runId) ?? "{}") as { records?: unknown };
    expect(preserved.records).toBe("nope");
  });
});
