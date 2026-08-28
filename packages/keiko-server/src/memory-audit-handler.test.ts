// Tests for the memory audit handler (#214). Each test wires the handler to a real
// in-memory evidence store and the BFF redactor, dispatches a synthesised vault
// MemoryEvent, and asserts the redacted MemoryAuditEvent persisted to the date-bucketed
// manifest.

import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryEvidenceStore,
  createAuditRedactor,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/memory";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
  MemoryWorkspaceId,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryEvent, MemoryTombstone } from "@oscharko-dev/keiko-memory-vault";
import {
  auditRunIdFor,
  createMemoryAuditHandler,
  createNoopMemoryAuditHandler,
  recordMemoryAudit,
  recordMemoryAudits,
  createMemoryAuditDeleteCommitHandler,
  verifyMemoryAuditHashChain,
  type RecordMemoryAuditOptions,
} from "./memory-audit-handler.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

function brandedMemoryWorkspaceId(value: string): MemoryWorkspaceId {
  const u: unknown = value;
  return u as MemoryWorkspaceId;
}

// The real security-layer redactor with no extra literals. Tests must never stand in an identity
// function here: `recordMemoryAudit(s)` requires a redactor precisely because an identity default was
// a fail-open on the evidence-redaction boundary, and a fixture that reinstates one would stop
// exercising the production shape.
const TEST_AUDIT_REDACT: (input: string) => string = createAuditRedactor({}, {});

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
    expect(verifyMemoryAuditHashChain(store.get(auditRunIdFor(FIXED_NOW)) ?? "[]")).toEqual({
      ok: true,
    });
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
    expect(verifyMemoryAuditHashChain(store.get(auditRunIdFor(FIXED_NOW)) ?? "[]")).toEqual({
      ok: true,
    });
  });

  it("keeps audit hashes independent of runtime locale collation", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale collation must not participate in canonical hashes");
    });
    try {
      const store = createInMemoryEvidenceStore();
      const handler = createMemoryAuditHandler({
        evidenceStore: store,
        redactString: identityRedact,
        now: () => FIXED_NOW,
        newEventId: makeIdFactory(),
      });
      handler({ kind: "memory:inserted", record: makeRecord({ status: "accepted" }) });

      expect(verifyMemoryAuditHashChain(store.get(auditRunIdFor(FIXED_NOW)) ?? "[]")).toEqual({
        ok: true,
      });
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("detects tampering in the persisted audit hash chain", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    handler({ kind: "memory:inserted", record: makeRecord({ status: "proposed" }) });
    const runId = auditRunIdFor(FIXED_NOW);
    const persisted = JSON.parse(store.get(runId) ?? "[]") as Record<string, unknown>[];
    persisted[0] = { ...persisted[0], summary: "tampered summary" };

    expect(verifyMemoryAuditHashChain(JSON.stringify(persisted))).toEqual({
      ok: false,
      error: "audit hash chain eventHash mismatch",
    });
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
      scope: { kind: "user", userId: brandedMemoryUserId("u-1") },
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

  it("reports a bridge persistence failure with the SAME date-bucket runId as its correlationId", () => {
    // ADR-0173 D5 / g12: the vault-bridge path (createMemoryAuditHandler) reports through the
    // diagnostic sink, not onPersistError, so its failure must carry the SAME runId the append
    // targeted rather than a disconnected `randomUUID()`. Before the fix this was a random UUID.
    const throwingStore: EvidenceStore = {
      put: (): string => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      get: (): string | undefined => undefined,
      list: (): readonly string[] => [],
      location: (runId: string): string => runId,
      delete: (): void => undefined,
    };
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    const handler = createMemoryAuditHandler({
      evidenceStore: throwingStore,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
      diagnostics,
    });

    expect(() => {
      handler({ kind: "memory:inserted", record: makeRecord({ status: "proposed" }) });
    }).not.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("memory-audit-handler.bridge");
    expect(records[0]?.correlationId).toBe(auditRunIdFor(FIXED_NOW));
  });

  it("preserves a corrupt audit manifest instead of resetting it", () => {
    const store = createInMemoryEvidenceStore();
    const runId = auditRunIdFor(FIXED_NOW);
    const corruptJson = "{not valid json";
    store.put(runId, corruptJson);
    const errors: unknown[] = [];
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
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
    expect(store.get(runId)).toBe(corruptJson);
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
    // Tag the record id with the secret; summaries must not include raw ids.
    const id = brandedMemoryId(`mem-${secret}-tail`);
    const record = makeRecord({ id, status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).not.toContain(secret);
  });

  it("redacts a Bearer token in the audit summary when the real audit redactor is wired", () => {
    const store = createInMemoryEvidenceStore();
    // Fragmented literal so this source file does not contain a contiguous Bearer token.
    const bearerToken = ["Bearer", " ", "AAAA-BBBB-fake-token-1234567890"].join("");
    const secret = "AAAA-BBBB-fake-token-1234567890";
    const redact = createAuditRedactor({ additionalSecrets: [secret] }, {});
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: redact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    // Embed the Bearer token in the record id; summaries must not include raw ids.
    const id = brandedMemoryId(bearerToken);
    const record = makeRecord({ id, status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).not.toContain(secret);
  });

  it("redacts an api_key= assignment pattern in the audit summary", () => {
    const store = createInMemoryEvidenceStore();
    // Fragmented literal — source file must not contain the pattern contiguously.
    const secretValue = ["super-secret-value-", "1234"].join("");
    const apiKeyId = ["api_key=", secretValue].join("");
    const redact = createAuditRedactor({ additionalSecrets: [secretValue] }, {});
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: redact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    // Embed the api_key= assignment in the record id; summaries must not include raw ids.
    const id = brandedMemoryId(apiKeyId);
    const record = makeRecord({ id, status: "proposed" });
    handler({ kind: "memory:inserted", record });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).not.toContain(secretValue);
  });

  it("masks persisted scope coordinates at the audit boundary", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const record = makeRecord({
      scope: {
        kind: "workspace",
        workspaceId: brandedMemoryWorkspaceId("/private/workspaces/keiko-prod"),
      },
      status: "proposed",
    });
    handler({ kind: "memory:inserted", record });
    const json = store.get(auditRunIdFor(FIXED_NOW));
    expect(json ?? "").not.toContain("/private/workspaces/keiko-prod");
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

  it("emits memory:forgotten for a hard delete without a tombstone", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const record = makeRecord({ status: "accepted" });
    handler({ kind: "memory:inserted", record });
    handler({
      kind: "memory:deleted",
      memoryId: record.id,
      scope: record.scope,
      tombstoned: false,
    });
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(2);
    const second = events[1];
    expect(second?.kind).toBe("memory:forgotten");
    if (second?.kind === "memory:forgotten") {
      expect(second.memoryId).toBe(record.id);
      expect(second.tombstoned).toBe(false);
    }
  });

  it("buckets an event using the same captured timestamp as occurredAt", () => {
    const store = createInMemoryEvidenceStore();
    const beforeMidnight = Date.UTC(2025, 5, 15, 23, 59, 59, 999);
    const afterMidnight = beforeMidnight + 1;
    let calls = 0;
    const handler = createMemoryAuditHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => {
        calls += 1;
        return calls === 1 ? beforeMidnight : afterMidnight;
      },
      newEventId: makeIdFactory(),
    });
    handler({ kind: "memory:inserted", record: makeRecord({ status: "proposed" }) });
    const persisted = readEvents(store, beforeMidnight);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.occurredAt).toBe(beforeMidnight);
    expect(store.get(auditRunIdFor(afterMidnight))).toBeUndefined();
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
    recordMemoryAudit(
      { evidenceStore: store, redactString: TEST_AUDIT_REDACT, now: () => FIXED_NOW },
      event,
    );
    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("memory:retrieved");
  });

  it("buckets direct-emitted events by event.occurredAt", () => {
    const store = createInMemoryEvidenceStore();
    const beforeMidnight = Date.UTC(2025, 5, 15, 23, 59, 59, 999);
    const afterMidnight = beforeMidnight + 1;
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: "evt-retrieved-1",
      occurredAt: beforeMidnight,
      initiatorSurface: "workflow",
      summary: "retrieval returned 3 records",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      matchedMemoryIds: [brandedMemoryId("mem-test-1")],
    };
    recordMemoryAudit(
      { evidenceStore: store, redactString: TEST_AUDIT_REDACT, now: () => afterMidnight },
      event,
    );
    const events = readEvents(store, beforeMidnight);
    expect(events).toHaveLength(1);
    expect(store.get(auditRunIdFor(afterMidnight))).toBeUndefined();
  });

  it("throws when a required direct audit append fails", () => {
    const store: EvidenceStore = {
      put: () => {
        throw new Error("audit store unavailable");
      },
      get: () => undefined,
      list: () => [],
      delete: () => undefined,
    };
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: "evt-required-1",
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: "retrieval returned 1 record",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      matchedMemoryIds: [brandedMemoryId("mem-test-1")],
    };

    expect(() => {
      recordMemoryAudit(
        { evidenceStore: store, redactString: TEST_AUDIT_REDACT, required: true },
        event,
      );
    }).toThrow("audit store unavailable");
  });
});

describe("createMemoryAuditDeleteCommitHandler", () => {
  it("emits one required forgotten audit event for a tombstoned delete batch", () => {
    const store = createInMemoryEvidenceStore();
    const handler = createMemoryAuditDeleteCommitHandler({
      evidenceStore: store,
      redactString: identityRedact,
      now: () => FIXED_NOW,
      newEventId: makeIdFactory(),
    });
    const tombstone: MemoryTombstone = {
      id: "t-1",
      memoryId: brandedMemoryId("mem-test-1"),
      scopeKind: "user",
      scopeCoordinate: "u-1",
      type: "preference",
      forgottenAt: FIXED_NOW,
      forgetterSurface: "memory-center",
      originalStatus: "accepted",
    };

    handler([
      {
        kind: "memory:deleted",
        memoryId: brandedMemoryId("mem-test-1"),
        scope: { kind: "user", userId: brandedMemoryUserId("u-1") },
        tombstoned: true,
      },
      { kind: "memory:tombstoned", tombstone },
    ]);

    const events = readEvents(store, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: "memory:forgotten",
        eventId: "evt-1",
        memoryId: brandedMemoryId("mem-test-1"),
        tombstoned: true,
      }),
    );
    expect(verifyMemoryAuditHashChain(store.get(auditRunIdFor(FIXED_NOW)) ?? "[]")).toEqual({
      ok: true,
    });
  });
});

describe("recordMemoryAudits", () => {
  it("appends same-day events through one serialized store update", () => {
    const backing = createInMemoryEvidenceStore();
    let updateCount = 0;
    const store: EvidenceStore = {
      put: backing.put,
      get: backing.get,
      list: backing.list,
      location: backing.location,
      delete: backing.delete,
      update: (runId, update) => {
        updateCount += 1;
        return backing.update?.(runId, update) ?? backing.put(runId, update(backing.get(runId)));
      },
    };
    const event = (id: string, memoryId: string): MemoryAuditEvent => ({
      schemaVersion: "1",
      kind: "memory:workflow-omitted",
      eventId: id,
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: "Workflow omitted memory (below-threshold).",
      workflowRunId: "wr-1",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      omittedMemoryId: brandedMemoryId(memoryId),
      reason: "below-threshold",
    });

    recordMemoryAudits(
      { evidenceStore: store, redactString: TEST_AUDIT_REDACT, now: () => FIXED_NOW },
      [event("evt-1", "mem-1"), event("evt-2", "mem-2")],
    );

    expect(updateCount).toBe(1);
    const events = readEvents(store, FIXED_NOW);
    expect(events.map((entry) => entry.eventId)).toEqual(["evt-1", "evt-2"]);
  });

  // ── 0.3.0 audit item 5: the evidence-redaction boundary fails CLOSED ──────────
  //
  // `redactString` used to be optional with `?? (input) => input`. Every caller that forgot it — and
  // `{ evidenceStore: deps.evidenceStore }` was the common shape in production — persisted UNREDACTED
  // summaries into the on-disk audit ledger with nothing failing. The pin is a compile-time one on
  // purpose: the fix is that a redactor-less caller cannot exist, which no runtime assertion can show.
  //
  // Before the fix the call below type-checks, so the `@ts-expect-error` is UNUSED and
  // `npm run typecheck` fails with TS2578. After the fix the call is the error the directive expects.
  it("rejects a redactor-less caller at the type level", () => {
    const store = createInMemoryEvidenceStore();
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: "evt-no-redactor",
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: "retrieval returned 1 record",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      matchedMemoryIds: [brandedMemoryId("mem-test-1")],
    };
    // @ts-expect-error redactString is REQUIRED: no redactor must mean no unredacted write.
    const optionsWithoutRedactor: RecordMemoryAuditOptions = { evidenceStore: store };
    expect(optionsWithoutRedactor.evidenceStore).toBe(store);
    recordMemoryAudits({ ...optionsWithoutRedactor, redactString: TEST_AUDIT_REDACT }, [event]);
    expect(readEvents(store, FIXED_NOW)).toHaveLength(1);
  });

  // ── 0.3.0 audit item 4: a failed evidence write is visible in production ──────
  //
  // The default sink was `console.error("…", error)`: the RAW error object (message + stack) on a
  // channel no production assembly overrode. That made a failed audit write both invisible to
  // operators and capable of carrying the content this module exists to redact.
  it("reports a persistence failure to the diagnostic sink instead of console", () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwingStore: EvidenceStore = {
      put: () => {
        throw Object.assign(new Error("evidence dir unwritable: /Users/op/.keiko/evidence"), {
          code: "EACCES",
        });
      },
      get: () => undefined,
      list: () => [],
      delete: () => undefined,
    };
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: "evt-persist-failure",
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: "retrieval returned 1 record",
      scopes: [{ kind: "user", userId: brandedMemoryUserId("u-1") }],
      matchedMemoryIds: [brandedMemoryId("mem-test-1")],
    };

    expect(() => {
      recordMemoryAudits(
        { evidenceStore: throwingStore, redactString: TEST_AUDIT_REDACT, diagnostics },
        [event],
      );
    }).not.toThrow();

    try {
      expect(records).toHaveLength(1);
      expect(records[0]?.source).toBe("memory-audit-handler.direct");
      expect(records[0]?.operation).toBe("memory.audit.persist");
      expect(records[0]?.code).toBe("EACCES");
      expect(records[0]?.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      // ADR-0173 D5 / g12: the failure's correlationId is the SAME date-bucket runId the append
      // itself targeted, not a disconnected `randomUUID()` — an operator can join the failure back
      // to the bucket it belongs to. Before the fix this was a random UUID.
      expect(records[0]?.correlationId).toBe(auditRunIdFor(FIXED_NOW));
      // Body-free: the store's path never enters the record.
      expect(JSON.stringify(records)).not.toContain("/Users/op/.keiko/evidence");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a hostile summary out of the persisted record and caps its length", () => {
    const store = createInMemoryEvidenceStore();
    // Fragmented so this source file contains no contiguous credential pattern.
    const secret = ["sk-", "proj", "_", "AbCDef0123456789", "GhIjKl"].join("");
    const longTail = "A".repeat(4_000);
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:workflow-omitted",
      eventId: "evt-hostile",
      occurredAt: FIXED_NOW,
      initiatorSurface: "workflow",
      summary: `Workflow omitted memory using ${secret} ${longTail}`,
      workflowRunId: "wr-hostile",
      scopes: [{ kind: "user", userId: brandedMemoryUserId(secret) }],
      omittedMemoryId: brandedMemoryId("mem-hostile"),
      reason: `below-threshold ${secret}`,
    };

    recordMemoryAudits(
      {
        evidenceStore: store,
        redactString: createAuditRedactor({ additionalSecrets: [secret] }, {}),
        now: () => FIXED_NOW,
      },
      [event],
    );

    const persisted = store.get(auditRunIdFor(FIXED_NOW)) ?? "";
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
    const [written] = readEvents(store, FIXED_NOW);
    expect(written?.summary.length).toBeLessThanOrEqual(MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS);
    expect(written?.summary).not.toContain(secret);
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
