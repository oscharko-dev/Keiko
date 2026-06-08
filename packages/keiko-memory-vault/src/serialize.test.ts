import { describe, expect, it } from "vitest";
import type {
  MemoryId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { randomBytes } from "node:crypto";
import { MemoryStorageError } from "./errors.js";
import { memoryRecordToRow, rowToMemoryRecord, type MemoryRow } from "./serialize.js";
import { createMemoryContentCipher } from "./cipher.js";

const cipher = createMemoryContentCipher(randomBytes(32));

function baseRecord(): MemoryRecord {
  return {
    id: "m-1" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: ["ui", "ux"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  };
}

describe("memoryRecordToRow + rowToMemoryRecord", () => {
  it("round-trips a minimal record", () => {
    const r = baseRecord();
    const back = rowToMemoryRecord(memoryRecordToRow(r, cipher), cipher);
    expect(back).toEqual(r);
  });

  it("round-trips a maximal record (all optional fields populated)", () => {
    const r: MemoryRecord = {
      ...baseRecord(),
      payload: { kind: "string-list", items: ["a", "b"] },
      provenance: {
        sourceKind: "workflow-outcome",
        capturedAt: 1_700_000_000_000,
        confidence: 0.75,
        sensitivity: "confidential",
        captureRationale: "consolidation pass",
        modelIdentity: { provider: "openai", modelId: "gpt-5", modelRevision: "2026-01" },
      },
      validity: { validFrom: 1_700_000_000_000, validUntil: 1_800_000_000_000 },
      pinned: true,
      tags: ["compliance"],
      staleReason: "superseded by m-2",
      retentionHint: {
        policyKey: "30d",
        retainUntil: 1_750_000_000_000,
        notes: "review quarterly",
      },
    };
    const back = rowToMemoryRecord(memoryRecordToRow(r, cipher), cipher);
    expect(back).toEqual(r);
  });

  it("omits undefined optionals on the way back (no undefined-property keys)", () => {
    const r = baseRecord();
    const back = rowToMemoryRecord(memoryRecordToRow(r, cipher), cipher);
    expect(Object.prototype.hasOwnProperty.call(back, "staleReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back, "retentionHint")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back, "payload")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back.validity, "validUntil")).toBe(false);
  });

  it("encodes pinned as 1/0 not true/false (STRICT integer column)", () => {
    const row = memoryRecordToRow({ ...baseRecord(), pinned: true }, cipher);
    expect(row.pinned).toBe(1);
    expect(memoryRecordToRow({ ...baseRecord(), pinned: false }, cipher).pinned).toBe(0);
  });

  it("preserves scope kind across user/workspace/project/global", () => {
    const r1: MemoryRecord = {
      ...baseRecord(),
      scope: { kind: "workspace", workspaceId: "w-1" as WorkspaceId },
    };
    const r2: MemoryRecord = {
      ...baseRecord(),
      scope: { kind: "project", projectId: "p-1" as ProjectId },
    };
    const r3: MemoryRecord = { ...baseRecord(), scope: { kind: "global" } };
    expect(rowToMemoryRecord(memoryRecordToRow(r1, cipher), cipher).scope).toEqual(r1.scope);
    expect(rowToMemoryRecord(memoryRecordToRow(r2, cipher), cipher).scope).toEqual(r2.scope);
    expect(rowToMemoryRecord(memoryRecordToRow(r3, cipher), cipher).scope).toEqual(r3.scope);
  });

  it("encodes global scope coordinate as empty string (canonical)", () => {
    const r: MemoryRecord = { ...baseRecord(), scope: { kind: "global" } };
    const row = memoryRecordToRow(r, cipher);
    expect(row.scope_kind).toBe("global");
    expect(row.scope_coordinate).toBe("");
  });

  it("emits NULL JSON for absent payload / retention / sidecar fields", () => {
    const row = memoryRecordToRow(baseRecord(), cipher);
    expect(row.payload_json).toBeNull();
    expect(row.retention_policy_key).toBeNull();
    expect(row.retention_retain_until).toBeNull();
    expect(row.retention_notes).toBeNull();
    expect(row.stale_reason).toBeNull();
    expect(row.valid_until).toBeNull();
    expect(row.model_provider).toBeNull();
    expect(row.model_id).toBeNull();
    expect(row.model_revision).toBeNull();
  });

  it("seals the content columns and leaves metadata columns cleartext", () => {
    const r: MemoryRecord = {
      ...baseRecord(),
      body: "SECRET-BODY-MARKER",
      tags: ["SECRET-TAG-MARKER"],
      payload: { kind: "string-list", items: ["SECRET-PAYLOAD-MARKER"] },
      provenance: { ...baseRecord().provenance, captureRationale: "SECRET-RATIONALE-MARKER" },
      staleReason: "SECRET-STALE-MARKER",
    };
    const row = memoryRecordToRow(r, cipher);
    // Content columns are sealed envelopes (kv1.*) and contain none of the plaintext markers.
    expect(cipher.isSealed(row.body)).toBe(true);
    expect(cipher.isSealed(row.tags_json)).toBe(true);
    expect(cipher.isSealed(row.payload_json ?? "")).toBe(true);
    expect(cipher.isSealed(row.capture_rationale ?? "")).toBe(true);
    expect(cipher.isSealed(row.stale_reason ?? "")).toBe(true);
    const blob = JSON.stringify(row);
    for (const marker of [
      "SECRET-BODY-MARKER",
      "SECRET-TAG-MARKER",
      "SECRET-PAYLOAD-MARKER",
      "SECRET-RATIONALE-MARKER",
      "SECRET-STALE-MARKER",
    ]) {
      expect(blob).not.toContain(marker);
    }
    // Metadata columns stay cleartext so SQL indexes and the UI scope display keep working.
    expect(row.scope_kind).toBe("user");
    expect(row.scope_coordinate).toBe("u-1");
    expect(row.status).toBe("accepted");
    expect(row.sensitivity).toBe("confidential");
  });
});

describe("rowToMemoryRecord — defensive parsing", () => {
  it("returns an empty tags array when the JSON parses to something non-array", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      tags_json: JSON.stringify({ not: "an array" }),
    };
    expect(rowToMemoryRecord(row, cipher).tags).toEqual([]);
  });

  it("drops non-string entries from a tags JSON array", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      tags_json: JSON.stringify(["ok", 123, null, "fine"]),
    };
    expect(rowToMemoryRecord(row, cipher).tags).toEqual(["ok", "fine"]);
  });

  it("throws schema-mismatch when tags_json is invalid JSON", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      tags_json: "{not-json",
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(MemoryStorageError);
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(/tags JSON is invalid/i);
  });

  it("throws schema-mismatch when payload_json is invalid JSON", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      payload_json: "{not-json",
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(MemoryStorageError);
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(/payload JSON is invalid/i);
  });

  it("throws schema-mismatch when scope_kind is not recognized", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      scope_kind: "bogus",
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(MemoryStorageError);
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(/scope kind is not recognized/i);
  });
});
