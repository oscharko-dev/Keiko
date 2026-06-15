import { describe, expect, it } from "vitest";
import {
  MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS,
  type MemoryId,
  type MemoryRecord,
  type MemoryScope,
  type MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import {
  buildInsertedEvent,
  buildUpdatedEvent,
  classifyUpdate,
  safeSummary,
  type BuildContext,
} from "./memory-audit-event-builders.js";

function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

const FIXED_NOW = 1_750_000_000_000;
const SCOPE: MemoryScope = { kind: "user", userId: brandedMemoryUserId("u-builders") };

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: brandedMemoryId("mem-builder-1"),
    schemaVersion: "1",
    scope: SCOPE,
    type: "preference",
    body: "User prefers deterministic tests.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: FIXED_NOW,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: FIXED_NOW },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function makeContext(redactString: (input: string) => string = (s) => s): BuildContext {
  let counter = 0;
  return {
    occurredAt: FIXED_NOW,
    newEventId: (): string => {
      counter += 1;
      return `evt-${String(counter)}`;
    },
    redactString,
  };
}

describe("safeSummary", () => {
  it("redacts and truncates at the audit summary contract boundary", () => {
    const secret = ["sk-", "proj", "_", "SummarySecret0123456789"].join("");
    const summary = safeSummary(
      `${secret}:${"x".repeat(MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS + 20)}`,
      (s) => s.replace(secret, "[redacted]"),
    );
    expect(summary).not.toContain(secret);
    expect(summary.length).toBe(MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS);
  });
});

describe("classifyUpdate", () => {
  it("falls back to memory:updated when status and pin state did not transition", () => {
    const record = makeRecord({ status: "accepted", pinned: false });
    expect(classifyUpdate("accepted", false, record)).toEqual({
      kind: "memory:updated",
      label: "metadata updated",
    });
    const event = buildUpdatedEvent(record, "accepted", false, makeContext());
    expect(event.kind).toBe("memory:updated");
    expect(event.summary).toContain("metadata updated");
  });

  it("keeps superseded bridge updates as plain memory:updated without a paired successor id", () => {
    const record = makeRecord({ status: "superseded", pinned: false });
    const event = buildUpdatedEvent(record, "accepted", false, makeContext());
    expect(event.kind).toBe("memory:updated");
    expect(event.summary).toContain("metadata updated");
  });
});

describe("buildInsertedEvent", () => {
  it("maps proposed and accepted inserts to semantic audit events", () => {
    expect(buildInsertedEvent(makeRecord({ status: "proposed" }), makeContext())?.kind).toBe(
      "memory:proposed",
    );
    expect(buildInsertedEvent(makeRecord({ status: "accepted" }), makeContext())?.kind).toBe(
      "memory:accepted",
    );
  });

  it("drops terminal-status inserts that are audited through the producing operation", () => {
    for (const status of [
      "rejected",
      "superseded",
      "archived",
      "forgotten",
      "conflicted",
      "expired",
    ] as const) {
      expect(buildInsertedEvent(makeRecord({ status }), makeContext())).toBeUndefined();
    }
  });
});
