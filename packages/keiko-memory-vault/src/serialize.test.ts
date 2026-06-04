import { describe, expect, it } from "vitest";
import type {
  MemoryId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { memoryRecordToRow, rowToMemoryRecord, type MemoryRow } from "./serialize.js";

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
    const back = rowToMemoryRecord(memoryRecordToRow(r));
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
    const back = rowToMemoryRecord(memoryRecordToRow(r));
    expect(back).toEqual(r);
  });

  it("omits undefined optionals on the way back (no undefined-property keys)", () => {
    const r = baseRecord();
    const back = rowToMemoryRecord(memoryRecordToRow(r));
    expect(Object.prototype.hasOwnProperty.call(back, "staleReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back, "retentionHint")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back, "payload")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(back.validity, "validUntil")).toBe(false);
  });

  it("encodes pinned as 1/0 not true/false (STRICT integer column)", () => {
    const row = memoryRecordToRow({ ...baseRecord(), pinned: true });
    expect(row.pinned).toBe(1);
    expect(memoryRecordToRow({ ...baseRecord(), pinned: false }).pinned).toBe(0);
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
    expect(rowToMemoryRecord(memoryRecordToRow(r1)).scope).toEqual(r1.scope);
    expect(rowToMemoryRecord(memoryRecordToRow(r2)).scope).toEqual(r2.scope);
    expect(rowToMemoryRecord(memoryRecordToRow(r3)).scope).toEqual(r3.scope);
  });

  it("encodes global scope coordinate as empty string (canonical)", () => {
    const r: MemoryRecord = { ...baseRecord(), scope: { kind: "global" } };
    const row = memoryRecordToRow(r);
    expect(row.scope_kind).toBe("global");
    expect(row.scope_coordinate).toBe("");
  });

  it("emits NULL JSON for absent payload / retention / sidecar fields", () => {
    const row = memoryRecordToRow(baseRecord());
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
});

describe("rowToMemoryRecord — defensive parsing", () => {
  it("returns an empty tags array when the JSON parses to something non-array", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord()),
      tags_json: JSON.stringify({ not: "an array" }),
    };
    expect(rowToMemoryRecord(row).tags).toEqual([]);
  });

  it("drops non-string entries from a tags JSON array", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord()),
      tags_json: JSON.stringify(["ok", 123, null, "fine"]),
    };
    expect(rowToMemoryRecord(row).tags).toEqual(["ok", "fine"]);
  });
});
