import { describe, expect, it } from "vitest";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  MAINTENANCE_MUTATION_FIXTURE_CASES as CASES,
  MAINTENANCE_NODE_REVIEW as NODE,
  MAINTENANCE_CLUSTER_REVIEW as CLUSTER,
  maintenanceMutationFixture,
} from "../../../tests/support/jira-maintenance-mutation-fixture.js";
import {
  executeJiraMaintenanceMutation as execute,
  isJiraMaintenanceMutation,
} from "./jira-managed-maintenance-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  maintenanceReceiptFits,
  parseMaintenanceInput,
} from "./jira-maintenance-mutation-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

describe("one-effect reviewed maintenance operations", () => {
  it.each(CASES)("retains $name context but never confirms completed effects", async (selected) => {
    const native = maintenanceMutationFixture(selected);
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: selected.receipt,
    });
    expect(native.snapshot()).toMatchObject({ effects: 1 });
    const writeIndex = native.calls.findIndex((call) => call.method !== "GET");
    expect(native.calls[writeIndex]).toMatchObject({
      path: selected.path,
      method: selected.method,
      body: undefined,
    });
    expect(native.calls.slice(writeIndex + 1).every((call) => call.method === "GET")).toBe(true);
    expect(native.calls.slice(writeIndex + 1).some((call) => call.path === "myself")).toBe(true);
  });
  it.each(CASES)("preflights $name through reads only", async (selected) => {
    const native = maintenanceMutationFixture(selected);
    expect(await execute(selected.name, selected.args, native.request, true)).toEqual({
      ok: true,
      receipt: {},
    });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(CASES)(
    "preserves lost ACK for $name without replay or guessed job IDs",
    async (selected) => {
      const native = maintenanceMutationFixture(selected);
      native.controls.lostAck = true;
      const result = await execute(selected.name, selected.args, native.request);
      expect(result).toMatchObject({
        ok: false,
        reason: "timeout",
        receipt: { userKey: "synthetic-actor" },
      });
      expect(result.receipt).not.toHaveProperty("reindexRequestIds");
      expect(native.snapshot()).toMatchObject({ effects: 1 });
      expect(native.calls.at(-1)).toMatchObject({ path: selected.path, method: selected.method });
    },
  );
  it.each(CASES)("retains $name receipt when post-ACK access is denied", async (selected) => {
    const native = maintenanceMutationFixture(selected);
    native.controls.denyReadback = true;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "permission-denied",
      receipt: selected.receipt,
    });
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it.each(CASES)("refuses changed actor before $name dispatch", async (selected) => {
    const native = maintenanceMutationFixture(selected);
    native.controls.actorChangesBefore = true;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it.each(CASES)(
    "preserves native refusal for $name without a second request",
    async (selected) => {
      const native = maintenanceMutationFixture(selected);
      native.controls.reject = true;
      expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
        ok: false,
        reason: "conflict",
        receipt: { userKey: "synthetic-actor" },
      });
      expect(native.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
      expect(native.snapshot()).toMatchObject({ effects: 0 });
    },
  );
  it("retains original post-ACK programming cause and frozen known request IDs", async () => {
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.throwReadback = true;
    try {
      await execute(selected.name, selected.args, native.request);
      expect.fail("Expected acknowledged mutation error");
    } catch (error) {
      expect(error).toBeInstanceOf(JiraAcknowledgedMutationError);
      if (!(error instanceof JiraAcknowledgedMutationError)) throw error;
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.receipt).toEqual(selected.receipt);
      expect(
        Object.isFrozen(Object.getOwnPropertyDescriptor(error.receipt, "reindexRequestIds")?.value),
      ).toBe(true);
    }
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it("does not claim completion from matching latest reindex or all COMPLETE request rows", async () => {
    for (const selected of [CASES[8], CASES[10]]) {
      const native = maintenanceMutationFixture(selected);
      expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
        ok: false,
        reason: "unavailable",
      });
      expect(native.snapshot()).toMatchObject({ effects: 1 });
    }
  });
  it("refuses direct reindex input aliases, arbitrary modes, omitted flags and JQL before reads", async () => {
    const selected = CASES[8];
    for (const patch of [
      { type: "BACKGROUND_PREFFERED" },
      { type: "plugin-mode" },
      { indexComments: "false" },
      { indexComments: undefined },
      { jql: "project = SYN" },
    ]) {
      const native = maintenanceMutationFixture(selected);
      const args: Record<string, CatalogJsonValue> = { ...selected.args };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete args[key];
        else args[key] = value;
      }
      expect(await execute(selected.name, args, native.request)).toMatchObject({
        ok: false,
        reason: "field-validation",
      });
      expect(native.calls).toHaveLength(0);
    }
  });
});

describe("native state and exact identity maintenance admission", () => {
  it.each(["/", "node%2fa", "node\\a", ".", "..", "node\nname", "node\ud800"])(
    "refuses path selector %j before any request",
    async (nodeId) => {
      const selected = CASES[0];
      const native = maintenanceMutationFixture(selected);
      expect(
        await execute(
          selected.name,
          { ...selected.args, expectedNode: { ...NODE, nodeId } },
          native.request,
        ),
      ).toMatchObject({ ok: false, reason: "field-validation" });
      expect(native.calls).toHaveLength(0);
    },
  );
  it.each([undefined, null, true])(
    "never turns unknown or live liveness %j into offline eligibility",
    async (alive) => {
      const selected = CASES[2];
      const native = maintenanceMutationFixture(selected);
      native.setNodes([{ ...NODE, alive }]);
      expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
        ok: false,
      });
      expect(native.snapshot()).toMatchObject({ effects: 0 });
    },
  );
  it("requires OFFLINE for node deletion and full current optional facts", async () => {
    const selected = CASES[1];
    const native = maintenanceMutationFixture(selected);
    native.setNodes([NODE]);
    expect(
      await execute(selected.name, { ...selected.args, expectedNode: NODE }, native.request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    const snapshot = maintenanceMutationFixture(CASES[0]);
    snapshot.setNodes([{ ...NODE, nodeBuildNumber: 113004 }]);
    expect(await execute(CASES[0].name, CASES[0].args, snapshot.request)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(snapshot.snapshot()).toMatchObject({ effects: 0 });
  });
  it("rejects malformed or duplicate nodes anywhere in the native complete list", async () => {
    for (const nodes of [
      [NODE, NODE],
      [NODE, { nodeId: "other", alive: "false" }],
    ]) {
      const selected = CASES[0];
      const native = maintenanceMutationFixture(selected);
      native.setNodes(nodes);
      expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
      });
      expect(native.snapshot()).toMatchObject({ effects: 0 });
    }
  });
  it("preserves unfamiliar observed cluster states without inventing transition eligibility", async () => {
    const selected = CASES[3];
    const native = maintenanceMutationFixture(selected);
    const expected = { ...CLUSTER, state: "FUTURE_NATIVE_CODE" };
    native.setCluster(expected);
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedClusterState: expected },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each([
    { selected: CASES[3], state: "MIXED", required: "READY_TO_RUN_UPGRADE_TASKS" },
    { selected: CASES[4], state: "RUNNING_UPGRADE_TASKS", required: "READY_TO_UPGRADE" },
    { selected: CASES[5], state: "STABLE", required: "UPGRADE_TASKS_FAILED" },
    { selected: CASES[6], state: "READY_TO_UPGRADE", required: "STABLE" },
  ])(
    "refuses a matching but illegal $selected.name pre-state $state",
    async ({ selected, state, required }) => {
      for (const check of [true, false]) {
        const native = maintenanceMutationFixture(selected);
        const expected = { ...CLUSTER, state };
        native.setCluster(expected);
        const result = await execute(
          selected.name,
          { ...selected.args, expectedClusterState: expected },
          native.request,
          check,
        );
        expect(result).toMatchObject({ ok: false, reason: "conflict" });
        if (result.ok) throw new TypeError("Expected local transition refusal");
        expect(result.detail?.messages?.join(" ")).toContain(required);
        expect(native.snapshot()).toMatchObject({ effects: 0 });
        expect(native.calls.every((call) => call.method === "GET")).toBe(true);
      }
    },
  );
  it.each([
    { state: "OFFLINE", alive: true },
    { state: "ACTIVE", alive: false },
  ])("refuses an unavailable snapshot source $state/$alive", async (state) => {
    const selected = CASES[0];
    const native = maintenanceMutationFixture(selected);
    const expected = { ...NODE, ...state };
    native.setNodes([expected]);
    expect(
      await execute(selected.name, { ...selected.args, expectedNode: expected }, native.request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each([0, 100])(
    "requires native finishTime even with progress %s or success true",
    async (currentProgress) => {
      const selected = CASES[8];
      const native = maintenanceMutationFixture(selected);
      const current = { type: "BACKGROUND", currentProgress, success: true };
      native.setReindex(current);
      expect(
        await execute(
          selected.name,
          { ...selected.args, expectedReindex: { taskState: "observed", ...current } },
          native.request,
        ),
      ).toMatchObject({ ok: false, reason: "conflict" });
      expect(native.snapshot()).toMatchObject({ effects: 0 });
      expect(native.calls.every((call) => call.method === "GET")).toBe(true);
    },
  );
  it("allows a finished failed native task without claiming the new reindex completed", async () => {
    const selected = CASES[8];
    const native = maintenanceMutationFixture(selected);
    const current = {
      type: "BACKGROUND",
      currentProgress: 0,
      success: false,
      finishTime: "2026-11-08T18:00:00Z",
    };
    native.setReindex(current);
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedReindex: { taskState: "observed", ...current } },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it("re-reads cluster eligibility before dispatch when the reviewed state becomes mixed", async () => {
    const selected = CASES[4];
    const native = maintenanceMutationFixture(selected);
    let reads = 0;
    const request: JiraMutationRequest = async (path, method, body, codec) => {
      if (path === "cluster/zdu/state" && ++reads === 2)
        native.setCluster({ ...CLUSTER, state: "MIXED" });
      return native.request(path, method, body, codec);
    };
    expect(await execute(selected.name, selected.args, request)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(reads).toBe(2);
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it("does not dispatch when the second reindex observation is now running", async () => {
    const selected = CASES[8];
    const native = maintenanceMutationFixture(selected);
    let reads = 0;
    const request: JiraMutationRequest = async (path, method, body, codec) => {
      if (path === "reindex" && ++reads === 2)
        native.setReindex({ type: "BACKGROUND", currentProgress: 1, success: false });
      return native.request(path, method, body, codec);
    };
    expect(await execute(selected.name, selected.args, request)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(reads).toBe(2);
    expect(native.snapshot()).toMatchObject({ effects: 0 });
  });
  it("does not infer a snapshot from false running after asynchronous ACK", async () => {
    const selected = CASES[7];
    const native = maintenanceMutationFixture(selected);
    const result = await execute(selected.name, selected.args, native.request);
    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { userKey: "synthetic-actor" },
    });
    expect(result.receipt).not.toHaveProperty("absolutePath");
    expect(native.calls.some((call) => call.path.includes("/export/"))).toBe(false);
  });
  it("allows only documented no-prior-task 404 and never infers absent task from unreadable payload", async () => {
    const selected = CASES[8];
    const native = maintenanceMutationFixture(selected);
    native.controls.noPriorReindex = true;
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedReindex: { taskState: "no-prior-task" } },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    const malformed = maintenanceMutationFixture(selected);
    malformed.setReindex({});
    expect(await execute(selected.name, selected.args, malformed.request)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(malformed.snapshot()).toMatchObject({ effects: 0 });
  });
  it("refuses a running upgrade without following its 303 destination", async () => {
    const selected = CASES[11];
    const native = maintenanceMutationFixture(selected);
    native.controls.upgradeRunning = true;
    expect(
      await execute(
        selected.name,
        { ...selected.args, expectedUpgrade: { upgradeState: "running" } },
        native.request,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(native.calls.map((call) => call.path)).toEqual(["myself", "upgrade"]);
  });
  it("binds exact issues before repeated numeric query IDs and refuses parent drift", async () => {
    const selected = CASES[9];
    const native = maintenanceMutationFixture(selected);
    native.controls.wrongIssue = true;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(native.snapshot()).toMatchObject({ effects: 0 });
    expect(
      parseMaintenanceInput(selected.name, {
        ...selected.args,
        expectedIssues: [...selected.args.expectedIssues, selected.args.expectedIssues[0]],
      }),
    ).toBeUndefined();
  });
});

describe("observed asynchronous request receipts", () => {
  it.each([
    { ids: [9007199254740992] },
    { ids: ["9223372036854775808"] },
    { ids: ["0"] },
    { ids: ["7", "7"] },
  ])("refuses malformed or inexact ACK IDs $ids without replay", async ({ ids }) => {
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.ackIds = ids;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "malformed-payload",
      receipt: { userKey: "synthetic-actor" },
    });
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it("retains exact int64 ACK IDs despite absent bulk rows and refuses foreign readback IDs", async () => {
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.missingRequest = true;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: selected.receipt,
    });
    const wrong = maintenanceMutationFixture(selected);
    wrong.controls.wrongRequest = true;
    expect(await execute(selected.name, selected.args, wrong.request)).toMatchObject({
      ok: false,
      reason: "malformed-payload",
      receipt: selected.receipt,
    });
    expect(wrong.snapshot()).toMatchObject({ effects: 1 });
  });
  it("still observes current state after a malformed successful queue ACK without guessing IDs", async () => {
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.malformedAck = true;
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "malformed-payload",
      receipt: { userKey: "synthetic-actor" },
    });
    const dispatch = native.calls.findIndex((call) => call.method === "POST");
    expect(native.calls.slice(dispatch + 1).map((call) => call.path)).toEqual([
      "myself",
      "reindex",
    ]);
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it("retains observed empty ACK arrays without claiming an empty pending population", async () => {
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.ackIds = [];
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { userKey: "synthetic-actor", reindexRequestIds: [] },
    });
    expect(native.calls.some((call) => call.path.startsWith("reindex/request/bulk"))).toBe(false);
  });
  it("enforces the receipt byte ceiling without truncating known request IDs", async () => {
    expect(
      maintenanceReceiptFits({
        userKey: "actor",
        reindexRequestIds: Array.from({ length: 1000 }, () => "9223372036854775807"),
      }),
    ).toBe(false);
    const selected = CASES[10];
    const native = maintenanceMutationFixture(selected);
    native.controls.ackIds = Array.from({ length: 1000 }, (_, index) =>
      String(9223372036854775807n - BigInt(index)),
    );
    expect(await execute(selected.name, selected.args, native.request)).toMatchObject({
      ok: false,
      reason: "bounds-exceeded",
      receipt: { userKey: "synthetic-actor" },
    });
    expect(native.snapshot()).toMatchObject({ effects: 1 });
  });
  it("does not recognize arbitrary administrative methods or accept raw payload selectors", async () => {
    expect(isJiraMaintenanceMutation("jira.restart-node")).toBe(false);
    const selected = CASES[11];
    const native = maintenanceMutationFixture(selected);
    expect(
      await execute(selected.name, { ...selected.args, body: { taskId: "7" } }, native.request),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
});
