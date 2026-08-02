import { describe, expect, it } from "vitest";
import type { MemoryId, MemoryRecord, MemoryUserId } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "./deps.js";
import { recordAutoAcceptedMemoryCaptureDecision } from "./memory-capture-audit.js";

function promotedMemory(): MemoryRecord {
  return {
    id: "promoted-memory" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "operator" as MemoryUserId },
    type: "preference",
    body: "Body excluded from decision evidence.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 100,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 100 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 100,
    updatedAt: 250,
  };
}

describe("recordAutoAcceptedMemoryCaptureDecision", () => {
  it("records a replay promotion at the promotion time", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const deps = {
      config: undefined,
      gatewayConfig: undefined,
      env: {},
      evidenceStore,
    } as unknown as UiHandlerDeps;

    recordAutoAcceptedMemoryCaptureDecision(
      deps,
      "autonomous-delivery",
      "desktop",
      promotedMemory(),
    );

    const evidence = evidenceStore
      .list()
      .map((runId) => evidenceStore.get(runId) ?? "")
      .join("\n");
    expect(evidence).toContain('"occurredAt":250');
    expect(evidence).toContain("auto-accepted");
    expect(evidence).not.toContain("Body excluded");
  });
});
