import { describe, expect, it } from "vitest";
import {
  ANONYMIZATION_UNLOCK_CASE as CASE,
  ANONYMIZATION_UNLOCK_TASK as TASK,
  anonymizationUnlockFixture,
} from "../../../tests/support/jira-anonymization-unlock-fixture.js";
import {
  executeJiraAnonymizationUnlock as execute,
  isJiraAnonymizationUnlock,
} from "./jira-managed-anonymization-unlock.js";
import { jiraAnonymizationTaskInput } from "./jira-anonymization-unlock-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

describe("human-attested stale anonymization unlock", () => {
  it("previews the exact current task without private input or any DELETE", async () => {
    const f = anonymizationUnlockFixture();
    expect(await execute(f.args, f.request, undefined, true)).toEqual({
      ok: true,
      receipt: CASE.receipt,
    });
    expect(f.reads).toEqual(["myself", "user/anonymization/progress"]);
    expect(f.effects).toEqual([]);
  });
  it("rechecks the current global task immediately before its one private call and never confirms ACK", async () => {
    const f = anonymizationUnlockFixture();
    expect(await execute(f.args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: CASE.receipt,
    });
    expect(f.reads).toEqual([
      "myself",
      "user/anonymization/progress",
      "myself",
      "user/anonymization/progress",
    ]);
    expect(f.effects).toEqual(["native-actor"]);
  });
  it.each([
    { executingNode: "another-node" },
    { userKey: "another-target" },
    { submittedTime: "later-native-time" },
    { currentProgress: 1 },
    { status: "COMPLETED" },
    { operations: ["ANOTHER_HANDLER"] },
    { isRerun: true },
    { errors: { GENERAL: { errorMessages: ["New diagnostic"] } } },
    { startTime: "started-now" },
  ])("refuses task drift on the immediate final read %#", async (delta) => {
    const f = anonymizationUnlockFixture();
    f.onProgress((index) => {
      if (index === 2) Object.assign(f.progress, delta);
    });
    expect(await execute(f.args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(f.effects).toEqual([]);
  });
  it("does not equate missing native facts, unknown progress or absent/null changes", async () => {
    const f = anonymizationUnlockFixture();
    delete f.progress.executingNode;
    expect(await execute(f.args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(f.effects).toEqual([]);
    const second = anonymizationUnlockFixture();
    delete second.progress.startTime;
    expect(await execute(second.args, second.request, second.ports)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(second.effects).toEqual([]);
  });
  it.each([
    "ownerShutdownConfirmation",
    "shutdownConfirmed",
    "nodeOffline",
    "taskId",
    "password",
    "headers",
    "url",
  ])("rejects model-supplied %s before reads", async (key) => {
    const f = anonymizationUnlockFixture();
    expect(await execute({ ...f.args, [key]: true }, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(f.reads).toEqual([]);
    expect(f.effects).toEqual([]);
  });
  it("requires the actual protected port rather than trusting native OFFLINE or a reviewed node name", async () => {
    const f = anonymizationUnlockFixture();
    expect(await execute(f.args, f.request, undefined)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(f.effects).toEqual([]);
  });
  it.each([
    { ok: false, reason: "not-found", httpStatus: 404 },
    { ok: false, reason: "conflict", httpStatus: 409 },
    { ok: false, reason: "timeout" },
    { ok: false, reason: "permission-denied", httpStatus: 403 },
    { ok: false, reason: "effect-denied" },
  ] as const)("keeps known identity without inventing removal or retrying %#", async (outcome) => {
    const f = anonymizationUnlockFixture();
    f.setOutcome(outcome);
    expect(await execute(f.args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: outcome.reason,
      receipt: CASE.receipt,
    });
    expect(f.effects).toHaveLength(1);
  });
  it("retains uncertainty for any acknowledged 2xx even if transport projection failed", async () => {
    const f = anonymizationUnlockFixture();
    f.setOutcome({ ok: false, reason: "malformed-payload", httpStatus: 202 });
    expect(await execute(f.args, f.request, f.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: CASE.receipt,
    });
    expect(f.effects).toHaveLength(1);
  });
  it("retains the complete reviewed task receipt after an acknowledged private-port error", async () => {
    const f = anonymizationUnlockFixture();
    const privateFailure = new JiraAcknowledgedMutationError(
      new TypeError("Synthetic post-ACK failure"),
      { actorUserKey: "native-actor", userKey: "native-actor", username: "Native Actor" },
    );
    const ports: typeof f.ports = {
      ...f.ports,
      unlock: async (actor) => {
        await f.ports.unlock(actor);
        throw privateFailure;
      },
    };
    const effect = execute(f.args, f.request, ports);
    await expect(effect).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    await expect(effect).rejects.not.toBe(privateFailure);
    await expect(effect).rejects.toHaveProperty("receipt", CASE.receipt);
    await expect(effect).rejects.toHaveProperty("cause", privateFailure);
    expect(f.effects).toEqual(["native-actor"]);
    expect(f.reads).toEqual([
      "myself",
      "user/anonymization/progress",
      "myself",
      "user/anonymization/progress",
    ]);
  });
  it("propagates private programmer defects instead of manufacturing native status", async () => {
    const f = anonymizationUnlockFixture();
    const defect = new TypeError("Synthetic private port defect");
    await expect(
      execute(f.args, f.request, {
        ...f.ports,
        unlock: () => Promise.reject(defect),
      }),
    ).rejects.toBe(defect);
    expect(f.effects).toEqual([]);
  });
  it("shares the exact typed diagnostic roundtrip and preserves empty/null/false/zero", () => {
    expect(jiraAnonymizationTaskInput(TASK)).toEqual(TASK);
    const diagnostics = {
      ...TASK,
      errors: [
        { operation: "GENERAL", messages: [""], fields: [{ field: "target", message: "" }] },
      ],
    };
    expect(jiraAnonymizationTaskInput(diagnostics)).toEqual(diagnostics);
    expect(
      jiraAnonymizationTaskInput({
        ...TASK,
        errors: [
          {
            operation: "GENERAL",
            fields: [
              { field: "x", message: "a" },
              { field: "x", message: "b" },
            ],
          },
        ],
      }),
    ).toBeUndefined();
    expect(jiraAnonymizationTaskInput({ ...TASK, taskId: "37" })).toBeUndefined();
    expect(jiraAnonymizationTaskInput({ ...TASK, currentProgress: null })).toBeUndefined();
    expect(isJiraAnonymizationUnlock(CASE.name)).toBe(true);
    expect(isJiraAnonymizationUnlock("jira.unlock-anonymization")).toBe(false);
  });
});
