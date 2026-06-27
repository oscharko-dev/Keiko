// Coverage for content-free task-workspace lifecycle evidence (Issue #445, D4). Proves the event is
// validated against the contract's content-free allowlist, redaction is applied before persistence,
// and an evidence-store failure is swallowed (best-effort).

import { describe, expect, it } from "vitest";
import { validateWorkspaceEvent } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  appendWorkspaceLifecycleEvidence,
  buildWorkspaceEvent,
  WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
  type WorkspaceLifecycleEvidenceRecord,
} from "./evidence.js";

function capturingStore(): { store: EvidenceStore; puts: { id: string; json: string }[] } {
  const puts: { id: string; json: string }[] = [];
  const store: EvidenceStore = {
    put: (id: string, json: string): string => {
      puts.push({ id, json });
      return `/evidence/${id}.json`;
    },
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
  return { store, puts };
}

function record(taskId: string): WorkspaceLifecycleEvidenceRecord {
  return {
    kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
    schemaVersion: "1",
    recordedAt: 1_700_000_000_000,
    operation: "provision",
    outcome: "provisioned",
    attempt: 1,
    durationMs: 0,
    worktreeCount: 0,
    event: buildWorkspaceEvent({
      eventId: "evt-1",
      workspaceId: "ws_1",
      taskId,
      type: "provisioned",
      at: "2026-06-26T00:00:00.000Z",
      correlationId: "ws_1",
      fromState: "provisioning",
      toState: "active",
    }),
  };
}

describe("buildWorkspaceEvent", () => {
  it("produces a contract-valid content-free event", () => {
    const event = record("t1").event;
    expect(validateWorkspaceEvent(event).ok).toBe(true);
  });

  it("throws when the event would be invalid", () => {
    expect(() =>
      buildWorkspaceEvent({
        eventId: "evt-1",
        workspaceId: "ws_1",
        taskId: "t1",
        type: "not-a-real-type" as never,
        at: "2026-06-26T00:00:00.000Z",
        correlationId: "ws_1",
      }),
    ).toThrow();
  });
});

describe("appendWorkspaceLifecycleEvidence", () => {
  it("persists under the event id and applies the redactor before serializing", () => {
    const { store, puts } = capturingStore();
    const location = appendWorkspaceLifecycleEvidence(store, record("SECRET"), (s) =>
      s.replace("SECRET", "[R]"),
    );
    expect(location).toBe("/evidence/evt-1.json");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.id).toBe("evt-1");
    expect(puts[0]?.json).toContain("[R]");
    expect(puts[0]?.json).not.toContain("SECRET");
  });

  it("swallows an evidence-store error and never throws (best-effort)", () => {
    const failing: EvidenceStore = {
      put: (): string => {
        throw new Error("disk full");
      },
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    };
    expect(appendWorkspaceLifecycleEvidence(failing, record("t1"), (s) => s)).toBeUndefined();
  });
});
