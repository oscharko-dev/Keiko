import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ManagedLspActivationReasonCode,
  ManagedLspEffectiveState,
} from "@oscharko-dev/keiko-contracts";
import {
  createManagedLspActivationStore,
  emptyManagedLspWorkspaceRecord,
  managedLspActivationRecordPath,
  managedLspWorkspaceFingerprint,
  type ManagedLspIdempotencyRecord,
} from "./managedLspActivationStore.js";

// Mirrors the store's private MAX_RECORD_BYTES / MAX_EVIDENCE_RECORDS / MAX_IDEMPOTENCY_RECORDS
// bounds so tests can assert on the exact boundary without exporting internals.
const MAX_RECORD_BYTES = 1_048_576;
const MAX_EVIDENCE_RECORDS = 128;
const MAX_IDEMPOTENCY_RECORDS = 64;

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validEvidenceRecord(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    kind: "activationChange",
    action: "activate",
    outcome: "accepted",
    actorClass: "system",
    language: "python",
    priorState: "disabled" satisfies ManagedLspEffectiveState,
    effectiveState: "disabled" satisfies ManagedLspEffectiveState,
    reasonCode: "WORKSPACE_ACTIVATION_UNSET" satisfies ManagedLspActivationReasonCode,
    revision: 0,
    timestampMs: 0,
    policyResult: "allowed",
  };
}

function validIdempotencyRecord(): ManagedLspIdempotencyRecord {
  return {
    keyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    resultKind: "ok",
    changed: true,
    revision: 0,
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "allowed",
  };
}

function validRecord(fingerprint: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    workspaceFingerprint: fingerprint,
    revision: 0,
    languages: {},
    evidence: [],
    idempotency: [],
  };
}

function writeRecord(stateDir: string, root: string, record: Record<string, unknown>): void {
  writeFileSync(managedLspActivationRecordPath(stateDir, root), JSON.stringify(record), "utf8");
}

describe("managed LSP activation store bounded size guard", () => {
  it("fails closed when the on-disk record exceeds MAX_RECORD_BYTES, even though the content parses cleanly", () => {
    const stateDir = temporaryDirectory("managed-lsp-oversized");
    const root = temporaryDirectory("workspace-oversized");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    writeRecord(stateDir, root, validRecord(fingerprint));
    const store = createManagedLspActivationStore({
      stateDir,
      size: () => MAX_RECORD_BYTES + 1,
    });

    const result = store.load(root);

    expect(result.state).toBe("unavailable");
    expect(result.record).toEqual(emptyManagedLspWorkspaceRecord(root));
  });

  it("accepts a well-formed record whose size sits exactly at the MAX_RECORD_BYTES boundary", () => {
    const stateDir = temporaryDirectory("managed-lsp-at-boundary");
    const root = temporaryDirectory("workspace-at-boundary");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    writeRecord(stateDir, root, validRecord(fingerprint));
    const store = createManagedLspActivationStore({
      stateDir,
      size: () => MAX_RECORD_BYTES,
    });

    const result = store.load(root);

    expect(result.state).toBe("ready");
  });
});

describe("managed LSP activation store fine-grained parse rejection", () => {
  function expectUnavailable(
    stateDir: string,
    root: string,
    record: Record<string, unknown>,
  ): void {
    writeRecord(stateDir, root, record);
    const store = createManagedLspActivationStore({ stateDir });

    const result = store.load(root);

    expect(result.state).toBe("unavailable");
    expect(result.record).toEqual(emptyManagedLspWorkspaceRecord(root));
  }

  it("rejects a negative top-level revision", () => {
    const stateDir = temporaryDirectory("managed-lsp-negative-revision");
    const root = temporaryDirectory("workspace-negative-revision");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    expectUnavailable(stateDir, root, { ...validRecord(fingerprint), revision: -1 });
  });

  it("rejects a non-integer top-level revision", () => {
    const stateDir = temporaryDirectory("managed-lsp-fractional-revision");
    const root = temporaryDirectory("workspace-fractional-revision");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    expectUnavailable(stateDir, root, { ...validRecord(fingerprint), revision: 1.5 });
  });

  it("rejects a language entry carrying an unknown key alongside a known schema version", () => {
    const stateDir = temporaryDirectory("managed-lsp-unknown-language-key");
    const root = temporaryDirectory("workspace-unknown-language-key");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    const record = {
      ...validRecord(fingerprint),
      languages: { python: { activation: "enabled", bogusKey: "x" } },
    };
    expectUnavailable(stateDir, root, record);
  });

  it("rejects an idempotency record with an unrecognized resultKind", () => {
    const stateDir = temporaryDirectory("managed-lsp-bogus-result-kind");
    const root = temporaryDirectory("workspace-bogus-result-kind");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    const record = {
      ...validRecord(fingerprint),
      idempotency: [{ ...validIdempotencyRecord(), resultKind: "bogus" }],
    };
    expectUnavailable(stateDir, root, record);
  });

  it(`rejects an idempotency list longer than MAX_IDEMPOTENCY_RECORDS (${String(MAX_IDEMPOTENCY_RECORDS)})`, () => {
    const stateDir = temporaryDirectory("managed-lsp-too-many-idempotency");
    const root = temporaryDirectory("workspace-too-many-idempotency");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    const record = {
      ...validRecord(fingerprint),
      idempotency: Array.from({ length: MAX_IDEMPOTENCY_RECORDS + 1 }, validIdempotencyRecord),
    };
    expectUnavailable(stateDir, root, record);
  });

  it(`rejects an evidence list longer than MAX_EVIDENCE_RECORDS (${String(MAX_EVIDENCE_RECORDS)})`, () => {
    const stateDir = temporaryDirectory("managed-lsp-too-many-evidence");
    const root = temporaryDirectory("workspace-too-many-evidence");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    const record = {
      ...validRecord(fingerprint),
      evidence: Array.from({ length: MAX_EVIDENCE_RECORDS + 1 }, validEvidenceRecord),
    };
    expectUnavailable(stateDir, root, record);
  });

  it("accepts a well-formed record at exactly the idempotency and evidence bounds", () => {
    const stateDir = temporaryDirectory("managed-lsp-at-list-bounds");
    const root = temporaryDirectory("workspace-at-list-bounds");
    const fingerprint = managedLspWorkspaceFingerprint(root);
    const record: Record<string, unknown> = {
      ...validRecord(fingerprint),
      idempotency: Array.from({ length: MAX_IDEMPOTENCY_RECORDS }, validIdempotencyRecord),
      evidence: Array.from({ length: MAX_EVIDENCE_RECORDS }, validEvidenceRecord),
    };
    writeRecord(stateDir, root, record);
    const store = createManagedLspActivationStore({ stateDir });

    const result = store.load(root);

    expect(result.state).toBe("ready");
    expect(result.record.idempotency).toHaveLength(MAX_IDEMPOTENCY_RECORDS);
    expect(result.record.evidence).toHaveLength(MAX_EVIDENCE_RECORDS);
  });
});
