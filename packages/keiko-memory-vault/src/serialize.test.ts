import { describe, expect, it } from "vitest";
import type {
  MemoryId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  MEMORY_TAGS_MAX_COUNT,
  MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES,
} from "@oscharko-dev/keiko-contracts/memory";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMemoryVault } from "./vault.js";
import { insertMemoryRow, updateMemoryRow } from "./memories.js";
import { MEMORY_DB_FILENAME } from "./paths.js";
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
  it("throws schema-mismatch when tags JSON parses to something non-array", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      tags_json: JSON.stringify({ not: "an array" }),
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(MemoryStorageError);
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(/array of strings/i);
  });

  it("throws schema-mismatch when tags JSON contains non-string entries", () => {
    const row: MemoryRow = {
      ...memoryRecordToRow(baseRecord(), cipher),
      tags_json: JSON.stringify(["ok", 123, null, "fine"]),
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(MemoryStorageError);
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(/array of strings/i);
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

describe("stored Memory contract admission (#3918)", () => {
  it.each([
    ["schema_version", "2"],
    ["type", "private-type-canary"],
    ["status", "private-status-canary"],
    ["sensitivity", "private-sensitivity-canary"],
    ["source_kind", "private-source-canary"],
    ["confidence", 2],
    ["captured_at", -1],
    ["created_at", -1],
    ["updated_at", 1],
    ["scope_coordinate", ""],
  ])("refuses the independently malformed %s field", (column, value) => {
    const row = { ...memoryRecordToRow(baseRecord(), cipher), [column]: value };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(
      expect.objectContaining({ code: "schema-mismatch" }),
    );
  });

  it.each([
    { kind: "string-list", items: [12] },
    { kind: "string-list" },
    { kind: "key-value", entries: [{ key: "ok", value: 12 }] },
    { kind: "private-payload-kind-canary", items: [] },
  ])("refuses correctly sealed malformed structured payload %#", (payload) => {
    const row = {
      ...memoryRecordToRow(baseRecord(), cipher),
      payload_json: cipher.sealString(JSON.stringify(payload)),
    };
    expect(() => rowToMemoryRecord(row, cipher)).toThrow(
      expect.objectContaining({ code: "schema-mismatch" }),
    );
  });

  it("preserves legacy plaintext, exact pinned and ignored optional-column semantics", () => {
    const record = { ...baseRecord(), scope: { kind: "global" } } satisfies MemoryRecord;
    const row = {
      ...memoryRecordToRow(record, cipher),
      body: record.body,
      tags_json: JSON.stringify(record.tags),
      pinned: 2,
      scope_coordinate: "ignored-global-coordinate",
      model_provider: "partial-provider",
      model_id: null,
      model_revision: "ignored-partial-revision",
      retention_policy_key: null,
      retention_retain_until: -1,
      retention_notes: "ignored-orphan-note",
    };
    const decoded = rowToMemoryRecord(row, cipher);
    expect(decoded).toEqual(record);
    expect(decoded.provenance).not.toHaveProperty("modelIdentity");
    expect(decoded).not.toHaveProperty("retentionHint");
    expect(rowToMemoryRecord({ ...row, pinned: 1 }, cipher).pinned).toBe(true);
    expect(
      rowToMemoryRecord({ ...row, model_provider: null, model_id: "partial-model" }, cipher),
    ).not.toHaveProperty("provenance.modelIdentity");
  });

  it.each([
    ["schema_version", "2"],
    ["type", "private-type-canary"],
    ["status", "private-status-canary"],
    ["source_kind", "private-source-canary"],
    ["sensitivity", "private-sensitivity-canary"],
  ])("refuses a single %s mutation after actual writer close and vault reopen", (column, value) => {
    const memoryDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-admission-"));
    const open = (): ReturnType<typeof createMemoryVault> =>
      createMemoryVault({ memoryDir, cipher, redactString: (text) => text });
    try {
      const writer = open();
      try {
        writer.insertMemory(baseRecord());
        expect(writer.getMemory(baseRecord().id)).toEqual(baseRecord());
        expect(writer.listMemoriesByScope(baseRecord().scope)).toEqual([baseRecord()]);
      } finally {
        writer.close();
      }
      const database = new DatabaseSync(join(memoryDir, MEMORY_DB_FILENAME));
      try {
        database
          .prepare(`UPDATE memories SET ${column} = ? WHERE id = ?`)
          .run(value, baseRecord().id);
      } finally {
        database.close();
      }
      const reopened = open();
      try {
        expect(() => reopened.getMemory(baseRecord().id)).toThrow(
          expect.objectContaining({ code: "internal" }),
        );
        expect(() => reopened.listMemoriesByScope(baseRecord().scope)).toThrow(
          /m-1 is unreadable/u,
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});

describe("physical Memory write snapshot (#3918)", () => {
  it("refuses an empty post-redaction body before invoking encryption", () => {
    let sealed = 0;
    const countingCipher = {
      ...cipher,
      sealString(text: string): string {
        sealed += 1;
        return cipher.sealString(text);
      },
    };
    expect(() => memoryRecordToRow({ ...baseRecord(), body: "" }, countingCipher)).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    expect(sealed).toBe(0);
  });

  it("captures scope exactly once before deriving its two SQL columns", () => {
    let reads = 0;
    const record = baseRecord();
    Object.defineProperty(record, "scope", {
      get: () => {
        reads += 1;
        return reads === 1 ? { kind: "user", userId: "u-1" } : { kind: "global" };
      },
    });
    const row = memoryRecordToRow(record, cipher);
    expect(reads).toBe(1);
    expect(row.scope_kind).toBe("user");
    expect(row.scope_coordinate).toBe("u-1");
  });

  it.each(["own", "inherited"])("does not execute %s payload toJSON", (placement) => {
    let calls = 0;
    const payload = { kind: "string-list", items: ["safe"] } as const;
    const foreign = {
      toJSON: (): object => {
        calls += 1;
        return { kind: "invalid" };
      },
    };
    if (placement === "own") Object.defineProperty(payload, "toJSON", { value: foreign.toJSON });
    else Object.setPrototypeOf(payload, foreign);
    const row = memoryRecordToRow({ ...baseRecord(), payload }, cipher);
    expect(calls).toBe(0);
    expect(rowToMemoryRecord(row, cipher).payload).toEqual({
      kind: "string-list",
      items: ["safe"],
    });
  });

  it("does not execute array toJSON on tags or key-value entries", () => {
    let calls = 0;
    const tags = ["safe"];
    const entries = [{ key: "safe", value: "value" }];
    const changed = (): readonly string[] => {
      calls += 1;
      return ["injected"];
    };
    Object.defineProperty(tags, "toJSON", { value: changed });
    Object.defineProperty(entries, "toJSON", { value: changed });
    const record: MemoryRecord = { ...baseRecord(), tags, payload: { kind: "key-value", entries } };
    const back = rowToMemoryRecord(memoryRecordToRow(record, cipher), cipher);
    expect(back.tags).toEqual(["safe"]);
    expect(back.payload).toEqual({ kind: "key-value", entries: [{ key: "safe", value: "value" }] });
    expect(calls).toBe(0);
  });

  it("does not invoke an entry's toJSON hook", () => {
    let calls = 0;
    const entry = {
      key: "safe",
      value: "value",
      toJSON: (): object => {
        calls += 1;
        return { key: "injected", value: "injected" };
      },
    };
    const payload = { kind: "key-value", entries: [entry] } as const;
    const back = rowToMemoryRecord(memoryRecordToRow({ ...baseRecord(), payload }, cipher), cipher);
    expect(back.payload).toEqual({ kind: "key-value", entries: [{ key: "safe", value: "value" }] });
    expect(calls).toBe(0);
  });

  it("refuses negative validity and incomplete optional metadata before sealing", () => {
    for (const record of [
      { ...baseRecord(), validity: { validFrom: 1, validUntil: -1 } },
      {
        ...baseRecord(),
        provenance: { ...baseRecord().provenance, modelIdentity: { provider: "ok", modelId: "" } },
      },
      { ...baseRecord(), retentionHint: { policyKey: "" } },
    ]) {
      expect(() => memoryRecordToRow(record, cipher)).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
    }
  });

  it("uses the canonical tag and payload entry bounds without truncating", () => {
    expect(() =>
      memoryRecordToRow(
        { ...baseRecord(), tags: Array.from({ length: MEMORY_TAGS_MAX_COUNT + 1 }, () => "safe") },
        cipher,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      memoryRecordToRow(
        {
          ...baseRecord(),
          payload: {
            kind: "string-list",
            items: Array.from({ length: MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES + 1 }, () => "safe"),
          },
        },
        cipher,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  it("returns the same immutable admitted record used by INSERT and UPDATE", () => {
    const memoryDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-snapshot-"));
    const vault = createMemoryVault({ memoryDir, cipher, redactString: (text) => text });
    const database = new DatabaseSync(join(memoryDir, MEMORY_DB_FILENAME));
    const record = baseRecord();
    try {
      const inserted = insertMemoryRow(database, record, cipher);
      expect(inserted).toEqual(record);
      expect(Object.isFrozen(inserted)).toBe(true);
      expect(Object.isFrozen(inserted.provenance)).toBe(true);
      expect(Object.isFrozen(inserted.tags)).toBe(true);
      const updated = updateMemoryRow(database, { ...record, body: "updated" }, cipher);
      expect(updated.body).toBe("updated");
      expect(Object.isFrozen(updated)).toBe(true);
      expect(vault.getMemory(record.id)).toEqual(updated);
      Reflect.set(record.validity, "validUntil", -1);
      expect(vault.getMemory(record.id)).toEqual(updated);
    } finally {
      database.close();
      vault.close();
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});

describe("captured row values survive later foreign callbacks", () => {
  it("binds captured validity and metadata before an actual cipher callback mutates input", () => {
    const record = baseRecord();
    const validity = { ...record.validity, validUntil: record.createdAt + 10 };
    const withMetadata = {
      ...record,
      validity,
      retentionHint: { policyKey: "keep", retainUntil: record.createdAt + 20 },
      provenance: {
        ...record.provenance,
        modelIdentity: { provider: "local", modelId: "fixture" },
      },
    };
    const mutatingCipher = {
      ...cipher,
      sealString(text: string): string {
        validity.validUntil = -1;
        withMetadata.retentionHint.policyKey = "changed";
        withMetadata.provenance.modelIdentity.modelId = "changed";
        return cipher.sealString(text);
      },
    };
    const row = memoryRecordToRow(withMetadata, mutatingCipher);
    expect(row.valid_until).toBe(record.createdAt + 10);
    expect(row.retention_policy_key).toBe("keep");
    expect(row.model_id).toBe("fixture");
  });

  it("admits the canonical array boundaries without dropping an element", () => {
    const tags = Array.from(
      { length: MEMORY_TAGS_MAX_COUNT },
      (_, index) => `tag-${String(index)}`,
    );
    const items = Array.from({ length: MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES }, () => "safe");
    const row = memoryRecordToRow(
      { ...baseRecord(), tags, payload: { kind: "string-list", items } },
      cipher,
    );
    const back = rowToMemoryRecord(row, cipher);
    expect(back.tags).toEqual(tags);
    expect(back.payload).toEqual({ kind: "string-list", items });
  });
});

describe("physical admission excludes later cipher and SQL failures", () => {
  it("preserves the cipher exception and never labels cipher or SQL failure a physical refusal", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-physical-error-"));
    const vault = createMemoryVault({ memoryDir: dir, cipher, redactString: (value) => value });
    const database = new DatabaseSync(join(dir, MEMORY_DB_FILENAME));
    const lines: object[] = [];
    const admission = {
      sink: {
        write: (event: object): void => {
          lines.push(event);
        },
      },
      method: "insert" as const,
      context: { correlationId: "technical-error-request" },
    };
    const failure = new TypeError("fixture cipher failure");
    const throwingCipher = {
      ...cipher,
      sealString: (): never => {
        throw failure;
      },
    };
    try {
      let received: unknown;
      try {
        insertMemoryRow(database, baseRecord(), throwingCipher, admission);
      } catch (error) {
        received = error;
      }
      expect(received).toBe(failure);
      expect(lines).toEqual([]);
      insertMemoryRow(database, baseRecord(), cipher, admission);
      expect(() => insertMemoryRow(database, baseRecord(), cipher, admission)).toThrow();
      expect(() =>
        updateMemoryRow(database, { ...baseRecord(), id: "missing" as MemoryId }, cipher, {
          ...admission,
          method: "update",
        }),
      ).toThrow(expect.objectContaining({ code: "not-found" }));
      expect(lines).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toMatchObject({
        count: 1,
      });
    } finally {
      database.close();
      vault.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("reads each captured body and metadata value once without consulting record toJSON", () => {
  const record = baseRecord();
  let bodyReads = 0;
  let confidenceReads = 0;
  Object.defineProperty(record, "body", {
    get: (): string => {
      bodyReads += 1;
      return bodyReads === 1 ? "captured body" : "later body";
    },
  });
  Object.defineProperty(record.provenance, "confidence", {
    get: (): number => {
      confidenceReads += 1;
      return confidenceReads === 1 ? 0.75 : -1;
    },
  });
  Object.defineProperty(record, "toJSON", {
    get: (): never => {
      throw new TypeError("Foreign record serializer must not run");
    },
  });
  const row = memoryRecordToRow(record, cipher);
  expect(bodyReads).toBe(1);
  expect(confidenceReads).toBe(1);
  expect(cipher.openString(row.body)).toBe("captured body");
  expect(row.confidence).toBe(0.75);
});
