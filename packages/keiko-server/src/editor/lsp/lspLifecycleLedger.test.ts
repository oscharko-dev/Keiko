import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";

import {
  _resetLspLifecycleLedgerForTests,
  listLspLifecycleEvents,
  recordLspLifecycleEvent,
} from "./lspLifecycleLedger.js";

function event(overrides: Partial<LspLifecycleEvent> = {}): LspLifecycleEvent {
  return {
    schemaVersion: "1",
    managerId: "mgr-1",
    status: "READY",
    timestampMs: 1_000,
    pendingRequestCount: 0,
    restartCount: 0,
    stderrBytesSeen: 0,
    ...overrides,
  };
}

describe("lspLifecycleLedger", () => {
  beforeEach(() => {
    _resetLspLifecycleLedgerForTests();
  });
  afterEach(() => {
    _resetLspLifecycleLedgerForTests();
  });

  it("records an event and returns the stored copy", () => {
    const stored = recordLspLifecycleEvent(event({ status: "STARTING" }));

    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("STARTING");
    expect(listLspLifecycleEvents()).toHaveLength(1);
  });

  it("preserves chronological order (newest last)", () => {
    recordLspLifecycleEvent(event({ status: "STARTING", timestampMs: 1 }));
    recordLspLifecycleEvent(event({ status: "INITIALIZING", timestampMs: 2 }));
    recordLspLifecycleEvent(event({ status: "READY", timestampMs: 3 }));

    expect(listLspLifecycleEvents().map((entry) => entry.status)).toEqual([
      "STARTING",
      "INITIALIZING",
      "READY",
    ]);
  });

  it("caps the ledger at 200 entries with FIFO eviction", () => {
    for (let i = 0; i < 250; i += 1) {
      recordLspLifecycleEvent(event({ timestampMs: i }));
    }
    const events = listLspLifecycleEvents();

    expect(events).toHaveLength(200);
    expect(events[0]?.timestampMs).toBe(50);
    expect(events[199]?.timestampMs).toBe(249);
  });

  it("applies the redactor to string leaves before storing", () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    recordLspLifecycleEvent(event({ managerId: secret }));

    const stored = listLspLifecycleEvents()[0];
    expect(stored?.managerId).not.toBe(secret);
    expect(JSON.stringify(listLspLifecycleEvents())).not.toContain(secret);
  });

  it("returns the error code when present", () => {
    recordLspLifecycleEvent(event({ status: "CRASHED", errorCode: "CRASHED" }));

    expect(listLspLifecycleEvents()[0]?.errorCode).toBe("CRASHED");
  });

  it("returns an empty list before any event is recorded", () => {
    expect(listLspLifecycleEvents()).toEqual([]);
  });

  it("resets to empty for tests", () => {
    recordLspLifecycleEvent(event());
    _resetLspLifecycleLedgerForTests();

    expect(listLspLifecycleEvents()).toEqual([]);
  });
});
