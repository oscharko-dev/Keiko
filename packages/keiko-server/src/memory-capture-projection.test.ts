import { describe, expect, it } from "vitest";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts";
import type { UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  buildMemoryCaptureDecisionAuditEvent,
  MemoryCaptureProjectionReadError,
  projectMemoryCaptureDecisions,
  replayMemoryCaptureAuditLedger,
} from "./memory-capture-projection.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";

function userId(value: string): UserId {
  return value as UserId;
}

const OWN_SCOPE: MemoryScope = { kind: "user", userId: userId("operator-a") };

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function record(id: string, scope: MemoryScope = OWN_SCOPE): MemoryRecord {
  return {
    id: memoryId(id),
    schemaVersion: "1",
    scope,
    type: "semantic-fact",
    body: `governed excerpt for ${id}`,
    provenance: {
      sourceKind: "system-default",
      capturedAt: 100,
      confidence: 0.8,
      sensitivity: "public",
    },
    validity: { validFrom: 100 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 100,
    updatedAt: 100,
  };
}

function captureEvent(
  id: string,
  occurredAt: number,
  outcome: "captured" | "proposed" | "auto-accepted" | "rejected" = "auto-accepted",
): MemoryAuditEvent {
  return buildMemoryCaptureDecisionAuditEvent({
    eventId: `event-${id}`,
    occurredAt,
    outcome,
    scope: OWN_SCOPE,
    mode: outcome === "proposed" ? "governed-assist" : "autonomous-delivery",
    initiatorSurface: "conversation-center",
    sourceKind: "system-default",
    reason: outcome === "proposed" ? "mode-requires-approval" : "governance-auto-accepted",
    memoryId: memoryId(id),
  });
}

function forgottenEvent(id: string, occurredAt: number): MemoryAuditEvent {
  return {
    schemaVersion: "1",
    kind: "memory:forgotten",
    eventId: `forgot-${id}-${String(occurredAt)}`,
    occurredAt,
    initiatorSurface: "memory-center",
    summary: "memory forgotten",
    memoryId: memoryId(id),
    scope: OWN_SCOPE,
    tombstoned: true,
  };
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index)).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

describe("memory capture projection", () => {
  it("replays capture decisions with deterministic newest-first ordering and stable ties", () => {
    const events = [
      captureEvent("older", 100),
      captureEvent("tie-first", 200, "proposed"),
      captureEvent("tie-second", 200),
    ];
    const options = {
      since: 0,
      order: "desc" as const,
      authorizedScopes: [OWN_SCOPE],
      liveRecords: [record("older"), record("tie-first"), record("tie-second")],
    };

    const first = projectMemoryCaptureDecisions(events, options);
    const replay = projectMemoryCaptureDecisions(events, options);

    expect(first).toEqual(replay);
    expect(first.map((decision) => decision.memoryId)).toEqual([
      "tie-second",
      "tie-first",
      "older",
    ]);
    expect(first.map((decision) => decision.outcome)).toEqual([
      "auto-accepted",
      "proposed",
      "auto-accepted",
    ]);
    expect(first[0]?.provenance).toEqual({
      initiatorSurface: "conversation-center",
      sourceKind: "system-default",
    });
    expect(
      projectMemoryCaptureDecisions(events, { ...options, order: "asc" }).map(
        (decision) => decision.memoryId,
      ),
    ).toEqual(["older", "tie-first", "tie-second"]);
  });

  it("suppresses a forgotten id monotonically across every capture/forget interleaving", () => {
    const capture = captureEvent("forgotten", 100);
    const forgotten = forgottenEvent("forgotten", 200);
    const unrelated = captureEvent("kept", 150);
    const liveRecords = [record("forgotten"), record("kept")];

    for (const events of permutations([capture, forgotten, unrelated])) {
      const projected = projectMemoryCaptureDecisions(events, {
        since: 0,
        order: "desc",
        authorizedScopes: [OWN_SCOPE],
        liveRecords,
      });
      expect(projected.map((decision) => decision.memoryId)).toEqual(["kept"]);
    }
  });

  it("drops absent persisted records but keeps record-free rejections content-free", () => {
    const rejected = buildMemoryCaptureDecisionAuditEvent({
      eventId: "event-rejected",
      occurredAt: 300,
      outcome: "rejected",
      scope: OWN_SCOPE,
      mode: "autonomous-delivery",
      initiatorSurface: "conversation-center",
      sourceKind: "system-default",
      reason: "credential-shape",
    });
    const decisions = projectMemoryCaptureDecisions([captureEvent("absent", 200), rejected], {
      since: 0,
      order: "desc",
      authorizedScopes: [OWN_SCOPE],
      liveRecords: [],
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(
      expect.objectContaining({
        outcome: "rejected",
        mode: "autonomous-delivery",
        reason: "credential-shape",
      }),
    );
    expect(decisions[0]).not.toHaveProperty("memoryId");
    expect(decisions[0]).not.toHaveProperty("body");
    expect(decisions[0]).not.toHaveProperty("bodyExcerpt");
  });

  it("filters decisions by since and exact authorized scope coordinates", () => {
    const foreignScope: MemoryScope = { kind: "user", userId: userId("operator-b") };
    const foreign = buildMemoryCaptureDecisionAuditEvent({
      eventId: "event-foreign",
      occurredAt: 400,
      outcome: "auto-accepted",
      scope: foreignScope,
      mode: "supervised-coding",
      initiatorSurface: "conversation-center",
      sourceKind: "system-default",
      reason: "governance-auto-accepted",
      memoryId: memoryId("foreign"),
    });
    const decisions = projectMemoryCaptureDecisions([captureEvent("old", 100), foreign], {
      since: 200,
      order: "desc",
      authorizedScopes: [OWN_SCOPE],
      liveRecords: [record("old"), record("foreign", foreignScope)],
    });

    expect(decisions).toEqual([]);
  });

  it("replays the existing hash-chained evidence manifests", () => {
    const store = createInMemoryEvidenceStore();
    const event = captureEvent("chained", 100);
    recordMemoryAudit({ evidenceStore: store }, event);

    const replayed = replayMemoryCaptureAuditLedger(store, 0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toEqual(
      expect.objectContaining({
        eventId: event.eventId,
        kind: event.kind,
        memoryId: memoryId("chained"),
        summary: event.summary,
      }),
    );
    expect(replayed[0]).toHaveProperty("integrity.sequence", 0);
    expect(replayed[0]).not.toEqual(expect.objectContaining({ scope: OWN_SCOPE }));
  });

  it("fails closed when a relevant audit manifest is tampered", () => {
    const store = createInMemoryEvidenceStore();
    recordMemoryAudit({ evidenceStore: store }, captureEvent("tampered", 100));
    const [runId] = store.list();
    expect(runId).toBeDefined();
    const original = store.get(runId ?? "") ?? "";
    store.put(runId ?? "", original.replace("auto-accepted", "captured"));

    expect(() => replayMemoryCaptureAuditLedger(store, 0)).toThrow(
      MemoryCaptureProjectionReadError,
    );
  });
});
