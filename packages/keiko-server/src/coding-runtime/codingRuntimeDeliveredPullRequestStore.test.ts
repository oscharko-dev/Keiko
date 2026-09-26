import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AT, DIGEST, createDraftRun } from "../gitDelivery/ciObservationTest/_support.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

// #3390: the post-delivery handoff admission (ready-for-review, merge) rests on this one durable
// fact once the run-bound authority has ended with the run. The fixture is the SAME shared
// draft-run producer the CI observation tests use, so the record under test is written by the real
// store path, never restated here.
describe("delivered pull request lookup", () => {
  let db: DatabaseSync;
  let snapshots: CodingRuntimeSnapshotStore;
  const SCOPE = { remoteDigest: DIGEST, prNumber: 17 };

  function settle(): void {
    const current = snapshots.get("run-1");
    if (current === undefined) throw new Error("fixture run is missing");
    snapshots.transition("run-1", {
      state: "succeeded",
      revision: current.revision + 1,
      updatedAt: AT,
      terminalAt: AT,
    });
  }

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    snapshots = createDraftRun(db);
  });
  afterEach(() => {
    db.close();
  });

  it("answers nothing while the delivering run is still running", () => {
    expect(snapshots.deliveredPullRequests?.current(SCOPE)).toBeUndefined();
  });

  it("names the settled run, its envelope and the delivered head once the run has succeeded", () => {
    settle();
    const delivery = snapshots.get("run-1")?.draftDelivery;
    if (delivery === undefined) throw new Error("fixture delivery is missing");
    expect(snapshots.deliveredPullRequests?.current(SCOPE)).toEqual({
      runId: "run-1",
      envelopeDigest: delivery.binding.envelopeDigest,
      headSha: delivery.binding.headSha,
    });
  });

  it("answers nothing for a pull request or repository no settled run delivered", () => {
    settle();
    expect(snapshots.deliveredPullRequests?.current({ ...SCOPE, prNumber: 18 })).toBeUndefined();
    expect(
      snapshots.deliveredPullRequests?.current({ ...SCOPE, remoteDigest: "b".repeat(64) }),
    ).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the malformed pull request number %s", (prNumber) => {
    settle();
    expect(snapshots.deliveredPullRequests?.current({ ...SCOPE, prNumber })).toBeUndefined();
  });
});
