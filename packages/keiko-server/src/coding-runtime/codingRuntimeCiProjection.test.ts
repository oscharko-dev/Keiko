import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { createDraftRun, readySnapshot, AT } from "../gitDelivery/ciObservationTest/_support.js";
import { createCodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { CodingRuntimeOrchestratorState } from "./codingRuntimeOrchestratorState.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(): { readonly db: DatabaseSync; readonly state: CodingRuntimeOrchestratorState } {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const snapshots = createDraftRun(db);
  const ci = createCodingRuntimeCiReadinessStore(db, snapshots);
  expect(ci.complete(ci.begin("run-1"), readySnapshot())).toBe(true);
  return {
    db,
    state: new CodingRuntimeOrchestratorState({
      eventHub: new CodingRuntimeEventHub(),
      now: (): Date => new Date(AT),
      pendingPermission: (): undefined => undefined,
      effectiveMode: (): "autonomous-delivery" => "autonomous-delivery",
    }),
  };
}
describe("CI readiness through the existing durable runtime projection", () => {
  it("restores correlated body-free readiness through the normal runtime snapshot", () => {
    const { db, state } = fixture();
    const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
    const projected = state.publicSnapshot(restored);
    expect(projected).toMatchObject({ ciReadiness: readySnapshot() });
    expect(validateCodingWorkbenchRuntimeSnapshot(projected).ok).toBe(true);
  });
  it("validates a legitimate closed readiness projection and rejects a different PR or head", () => {
    const { db, state } = fixture();
    const projected = state.publicSnapshot(createCodingRuntimeSnapshotStore(db).get("run-1"));
    const complete = { ...projected, ciReadiness: readySnapshot() };
    expect(validateCodingWorkbenchRuntimeSnapshot(complete).ok).toBe(true);
    for (const change of [
      { prNumber: 18 },
      { headSha: "4".repeat(40) },
      { runId: "run-2" },
      { body: "raw log" },
    ])
      expect(
        validateCodingWorkbenchRuntimeSnapshot({
          ...complete,
          ciReadiness: { ...readySnapshot(), ...change },
        }).ok,
      ).toBe(false);
  });
  it("retains timestamps after recovery without turning a read receipt into permission", () => {
    const { db, state } = fixture();
    const snapshots = createCodingRuntimeSnapshotStore(db);
    snapshots.markNonterminalRecoveryRequired(AT);
    const projected = state.publicSnapshot(snapshots.get("run-1"));
    expect(projected).toMatchObject({
      state: "recovery-required",
      ciReadiness: { observedAt: AT },
    });
    expect(projected.pendingPermission).toBeUndefined();
  });
});
