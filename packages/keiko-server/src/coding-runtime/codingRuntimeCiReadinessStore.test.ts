import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDraftRun,
  readySnapshot,
  AT,
  COMMIT,
} from "../gitDelivery/ciObservationTest/_support.js";
import { createCodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(): {
  readonly db: DatabaseSync;
  readonly snapshots: ReturnType<typeof createDraftRun>;
  readonly ci: ReturnType<typeof createCodingRuntimeCiReadinessStore>;
} {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const snapshots = createDraftRun(db);
  return { db, snapshots, ci: createCodingRuntimeCiReadinessStore(db, snapshots) };
}
describe("CI readiness in the existing runtime snapshot row", () => {
  it("round-trips bounded readiness after reopening the owning store", () => {
    const test = fixture();
    expect(test.ci.get("run-1")).toBeUndefined();
    expect(test.ci.complete(test.ci.begin("run-1"), readySnapshot())).toBe(true);
    const reopened = createCodingRuntimeCiReadinessStore(
      test.db,
      createCodingRuntimeSnapshotStore(test.db),
    );
    expect(reopened.get("run-1")).toEqual(readySnapshot());
  });
  it("preserves prior dated readiness during a newer observation and rejects late completion", () => {
    const test = fixture();
    const first = test.ci.begin("run-1");
    expect(test.ci.complete(first, readySnapshot())).toBe(true);
    const second = test.ci.begin("run-1");
    expect(test.ci.get("run-1")).toEqual(readySnapshot());
    expect(test.ci.complete(first, readySnapshot())).toBe(false);
    const third = test.ci.begin("run-1");
    expect(test.ci.complete(second, readySnapshot())).toBe(false);
    expect(test.ci.complete(third, readySnapshot())).toBe(true);
    expect(test.ci.complete(third, { ...readySnapshot(), evidenceRef: "replay" })).toBe(false);
  });
  it("invalidates readiness and pending observations when a repair starts", () => {
    const test = fixture();
    expect(test.ci.complete(test.ci.begin("run-1"), readySnapshot())).toBe(true);
    const pending = test.ci.begin("run-1");
    expect(test.ci.invalidate("run-1")).toBe(true);
    expect(test.ci.get("run-1")).toBeUndefined();
    expect(test.ci.complete(pending, readySnapshot())).toBe(false);
  });
  it("does not complete an observation after stop or restore authority through reopening", () => {
    const test = fixture();
    const ticket = test.ci.begin("run-1");
    const current = test.snapshots.get("run-1");
    if (!current) throw new Error("missing fixture snapshot");
    test.snapshots.transition("run-1", {
      state: "cancelled",
      revision: current.revision + 1,
      updatedAt: AT,
    });
    expect(test.ci.complete(ticket, readySnapshot())).toBe(false);
    expect(() => test.ci.begin("run-1")).toThrow("live confirmed draft");
    expect(() =>
      createCodingRuntimeCiReadinessStore(test.db, createCodingRuntimeSnapshotStore(test.db)).begin(
        "run-1",
      ),
    ).toThrow();
  });
  it.each([
    { remoteDigest: "b".repeat(64) },
    { prNumber: 18 },
    { headSha: "4".repeat(40) },
    { repository: "other/repository" },
    { runId: "run-2" },
  ])("rejects readiness for a different delivery target %#", (change) => {
    const test = fixture();
    expect(test.ci.complete(test.ci.begin("run-1"), { ...readySnapshot(), ...change })).toBe(false);
    expect(test.ci.get("run-1")).toBeUndefined();
  });
  it("allows newly observed base movement while binding the same published head", () => {
    const test = fixture();
    const result = { ...readySnapshot(), baseSha: "5".repeat(40) };
    expect(test.ci.complete(test.ci.begin("run-1"), result)).toBe(true);
    expect(test.ci.get("run-1")?.baseSha).toBe(result.baseSha);
  });
  it("rejects completion after a new delivery proposal and hides the old-head result", () => {
    const test = fixture();
    const ticket = test.ci.begin("run-1");
    expect(test.ci.complete(ticket, readySnapshot())).toBe(true);
    const draft = test.snapshots.get("run-1")?.draftDelivery;
    if (draft === undefined) throw new Error("Missing fixture draft");
    const nextHead = "4".repeat(40);
    test.snapshots.recordVerifiedCommit({
      ...COMMIT,
      proposalId: "commit-2",
      headSha: nextHead,
      parentSha: draft.binding.headSha,
    });
    test.snapshots.recordDraftDelivery(
      {
        ...draft,
        revision: draft.revision + 1,
        phase: "push-proposed",
        reason: "approval-required",
        binding: { ...draft.binding, headSha: nextHead, verifiedCommitProposalId: "commit-2" },
      },
      draft.revision,
    );
    expect(test.ci.get("run-1")).toBeUndefined();
    expect(test.ci.complete(ticket, readySnapshot())).toBe(false);
  });
  it("enforces closed stored schema and finite observation capacity", () => {
    const test = fixture();
    expect(() =>
      test.ci.complete(test.ci.begin("run-1"), {
        ...readySnapshot(),
        body: "untrusted",
      } as ReturnType<typeof readySnapshot>),
    ).toThrow("Invalid CI");
    test.db
      .prepare(
        "UPDATE coding_runtime_snapshots SET ci_observation_revision=1000000 WHERE run_id='run-1'",
      )
      .run();
    expect(() => test.ci.begin("run-1")).toThrow("capacity");
  });
});
