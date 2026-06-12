// End-to-end entry-level cancellation (Issue #273 / #280).
//
// runLifecycleCancellation.test.ts covers withStage / finaliseFailureOrCancellation in ISOLATION.
// This file drives a full scripted run entry through cancellation: a stage body rejects while the
// AbortSignal is aborted, and the run must settle as "cancelled" (NOT "failed"), emit run:cancelled
// (never run:failed / stage:failed), and persist NO manifest.

import { describe, expect, it } from "vitest";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type QualityIntelligenceLocalStore,
} from "@oscharko-dev/keiko-evidence";
import { runQualityIntelligenceTestDesign } from "../runEntries.js";
import {
  CLOCK,
  ENVELOPE,
  makeAtom,
  makePlan,
  PROVENANCE,
  recordingSink,
} from "./fixtures/runEntryFixtures.js";

// A store that, on the FIRST record attempt (the succeeded manifest in the finalize stage), aborts
// the run signal and throws — mimicking a persist call interrupted by a mid-flight cancellation. The
// inner store is left untouched so any later record (there must be NONE for a cancelled run) is
// observable as a leaked manifest.
function abortingOnRecordStore(controller: AbortController): {
  store: QualityIntelligenceLocalStore;
  recordedRunIds: () => readonly string[];
} {
  const inner = createInMemoryQualityIntelligenceLocalStore();
  const store: QualityIntelligenceLocalStore = {
    record: (): string => {
      controller.abort();
      throw new Error("gateway aborted: socket hang up");
    },
    load: (runId) => inner.load(runId),
    list: () => inner.list(),
    location: (runId) => inner.location(runId),
    delete: (runId) => inner.delete(runId),
  };
  return { store, recordedRunIds: () => inner.list() };
}

describe("scripted QI entry — end-to-end cancellation", () => {
  it("settles cancelled (not failed) and persists NO manifest when a stage rejects while aborted", async () => {
    const cap = recordingSink();
    const controller = new AbortController();
    const { store, recordedRunIds } = abortingOnRecordStore(controller);

    const summary = await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-cancel"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1"), makeAtom("atom-2")],
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK, signal: controller.signal },
    );

    // The mid-flight abort must classify the run as cancelled, never failed.
    expect(summary.status).toBe("cancelled");
    expect(cap.kinds()).toContain("run:cancelled");
    expect(cap.kinds()).not.toContain("run:failed");
    // A cancellation is not a stage failure.
    expect(cap.kinds()).not.toContain("stage:failed");
    // No manifest was persisted for a cancelled run (the cancelled finaliser does not persist, and
    // the only record attempt — the succeeded one — threw before writing).
    expect(recordedRunIds()).toEqual([]);
    expect(summary.evidence).toBeUndefined();
  });

  it("classifies cancelled when the signal is already aborted before the run starts", async () => {
    const cap = recordingSink();
    const controller = new AbortController();
    controller.abort();
    const store = createInMemoryQualityIntelligenceLocalStore();

    const summary = await runQualityIntelligenceTestDesign(
      {
        plan: makePlan("qi-run-td-precancel"),
        envelopes: [ENVELOPE],
        atoms: [makeAtom("atom-1")],
        provenanceRefs: PROVENANCE,
      },
      { sink: cap.sink, evidenceStore: store, clock: CLOCK, signal: controller.signal },
    );

    expect(summary.status).toBe("cancelled");
    expect(cap.kinds()).toContain("run:cancelled");
    expect(cap.kinds()).not.toContain("run:failed");
    // Nothing persisted.
    expect(store.list()).toEqual([]);
  });
});
