// Tests for the memory audit handler (#214). Each test wires the handler to a real
// in-memory evidence store and the BFF redactor, dispatches a synthesised vault
// MemoryEvent, and asserts the redacted MemoryAuditEvent persisted to the date-bucketed
// manifest.

import { describe, expect, it } from "vitest";
import {
  createInMemoryEvidenceStore,
  createAuditRedactor,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryEvent, MemoryTombstone } from "@oscharko-dev/keiko-memory-vault";
import {
  auditRunIdFor,
  createMemoryAuditHandler,
  createNoopMemoryAuditHandler,
  recordMemoryAudit,
} from "./memory-audit-handler.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = brandedMemoryId("mem-test-1");
  const userId = brandedMemoryUserId("u-1");
  const now = 1_750_000_000_000; // fixed instant, well in range of valid Date
  return {
    id,
    schemaVersion: "1",
    scope: { kind: "user", userId },
    type: "preference",
    body: "User prefers strict typescript mode.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "proposed",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function readEvents(store: EvidenceStore, nowMs: number): readonly MemoryAuditEvent[] {
  const runId = auditRunIdFor(nowMs);
  const json = store.get(runId);
  if (json === undefined) {
    return [];
  }
  return JSON.parse(json) as MemoryAuditEvent[];
}

// Counter-based event-id factory keeps the test deterministic without coupling to
// randomUUID's output.
function makeIdFactory(): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `evt-${String(counter)}`;
  };
}

// Identity redactor for tests that do not exercise redaction. Tests that exercise it
// build a real audit redactor on top.
function identityRedact(s: string): string {
  return s;
}

const FIXED_NOW = 1_750_000_000_000;

// ── auditRunIdFor ─────────────────────────────────────────────────────────────

describe("auditRunIdFor", () => {
  it("formats the runId as memory-audit-YYYY-MM-DD in UTC", () => {
    // 2025-06-15T13:00:00.000Z
    expect(auditRunIdFor(1_750_000_800_000)).toBe("memory-audit-2025-06-15");
  });
});

// ── createMemoryAuditHandler ─────────────────────────────────────────────────

describe("createMemoryAuditHandler", () => {
  it("emits memory:proposed when the vault inserts a proposed record", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const record = makeRecord({ status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("memory:proposed");
    expect(events[0]?.eventId).toBe("evt-1");
    expect(events[0]?.occurredAt).toBe(FIXED_NOW);
  });

  it("emits memory:accepted when a proposed record transitions to accepted", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const record = makeRecord({ status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const accepted: MemoryRecord = { ...record, status: "accepted", updatedAt: FIXED_NOW + 1 };
    handler({ kind: "memory:updated", record: accepted });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe("memory:accepted");
  });

  it("emits memory:pinned and memory:unpinned on pin/unpin transitions", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const record = makeRecord({ status: "accepted", pinned: false });
    handler({ kind: "memory:inserted", record });
    handler({ kind: "memory:updated", record: { ...record, pinned: true } });
    handler({ kind: "memory:updated", record: { ...record, pinned: false } });
    const events = readEvents(store, FIXED_NOW);
    expect(events.map((e) => e.kind)).toEqual([
      "memory:accepted",
      "memory:pinned",
      "memory:unpinned",
    ]);
  });

  it("emits memory:forgotten for a tombstoned delete with the structured scope", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const tombstone: MemoryTombstone = {
      id: "tomb-1",
      memoryId: brandedMemoryId("mem-test-1"),
      scopeKind: "user",
      scopeCoordinate: "u-1",
      type: "preference",
      forgottenAt: FIXED_NOW,
      forgetterSurface: "memory-center",
    };
    handler({ kind: "memory:tombstoned", tombstone });
    // The vault pairs memory:tombstoned with memory:deleted(tombstoned:true). We only
    // want one audit event per logical deletion.
    handler({
      kind: "memory:deleted",
      memoryId: tombstone.memoryId,
      tombstoned: true,
    });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("memory:forgotten");
    const first = events[0];
    if (first?.kind === "memory:forgotten") {
      expect(first.scope.kind).toBe("user");
      expect(first.tombstoned).toBe(true);
    }
  });

  it("never throws when persistence fails", () => {
    const throwingStore: EvidenceStore = {
      put: (): string => {
        throw new Error("disk full");
      },
      get: (): string | undefined => undefined,
      list: (): readonly string[] => [],
      location: (runId: string): string => runId,
      delete: (): void => undefined,
    };
    const errors: unknown[] = [];
    const handler = createMemoryAuditHandler({
      evidenceStore: throwingStore,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
      onPersistError: (e) => {
        errors.push(e);
      },
    });
    expect(() => {
      handler({ kind: "memory:inserted", record: makeRecord({ status: "proposed" }) });
    }).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("redacts credential-shaped tokens in the summary using the audit redactor", () => {
    const store = createInMemoryEvidenceStore();
    // Fragmented literal: a real `sk-` + project-shaped key. Built piecewise so the
    // source file itself contains no contiguous credential pattern.
    const secret = ["sk-", "proj", "_", "AbCDef0123456789", "GhIjKl"].join("");
    const redact = createAuditRedactor({ additionalSecrets: [secret] }, {});
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: redact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    // Tag the record id with the secret so it lands in the summary string.
    const id = brandedMemoryId(`mem-${secret}-tail`);
    const record = makeRecord({ id, status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).not.toContain(secret);
  });

  it("never persists the raw memory body", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    // Unique fingerprint not present anywhere else (no `mem-test-1`, no `preference`).
    const fingerprint = "PRIVATE-BODY-FINGERPRINT-z9q4kx7p";
    const record = makeRecord({ body: fingerprint, status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const json = store.get(auditRunIdFor(FIXED_NOW));
    expect(json).toBeDefined();
    expect(json ?? "").not.toContain(fingerprint);
  });

  it("ignores edge and embedding events (audit scope excludes them)", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const memoryId = brandedMemoryId("mem-test-1");
    const ignored: readonly MemoryEvent[] = [
      {
        kind: "edge:inserted",
        edge: {
          id: brandedMemoryId("edge-1") as unknown as MemoryEvent extends {
            edge: { id: infer T };
          }
            ? T
            : never,
          schemaVersion: "1",
          fromMemoryId: memoryId,
          toMemoryId: memoryId,
          kind: "related",
          createdAt: FIXED_NOW,
        },
      },
      {
        kind: "edge:deleted",
        edgeId: brandedMemoryId("edge-1") as unknown as MemoryEvent extends {
          edgeId: infer T;
        }
          ? T
          : never,
      },
      {
        kind: "embedding:upserted",
        memoryId,
        provider: "openai",
        modelId: "text-embedding-3-small",
      },
    ];
    for (const event of ignored) {
      handler(event);
    }
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(0);
  });
});

// ── recordMemoryAudit ────────────────────────────────────────────────────────

describe("recordMemoryAudit", () => {
  it("appends a direct memory:retrieved event without any vault state", () => {
    const store = createInMemoryEvidenceStore();
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: "evt-retrieved-1",
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: "retrieval returned 3 records",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      matchedMemoryIds: [brandedMemoryId("mem-test-1")],
    };
    recordMemoryAudit({ evidenceStore: store, now: () => FIXED_NOW }, event);
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("memory:retrieved");
  });
});

// ── createNoopMemoryAuditHandler ─────────────────────────────────────────────

describe("createNoopMemoryAuditHandler", () => {
  it("ignores every vault event", () => {
    const handler = createNoopMemoryAuditHandler();
    expect(() => {
      handler({ kind: "memory:inserted", record: makeRecord({ status: "proposed" }) });
    }).not.toThrow();
  });
});
