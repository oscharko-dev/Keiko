import { describe, expect, it } from "vitest";

import { CODE_TASK_GOVERNANCE_SCHEMA_VERSION } from "./code-task-governance.js";
import {
  validateRunControlSnapshotV1,
  validateRuntimeGovernanceOutcomeV1,
  validateRuntimeGovernanceRequestV1,
  type RunControlSnapshotV1,
  type RuntimeGovernanceOutcomeV1,
  type RuntimeGovernanceRequestV1,
} from "./code-task-run-control.js";

function snapshot(): RunControlSnapshotV1 {
  return {
    kind: "run-control-snapshot",
    schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
    taskId: "task-1" as RunControlSnapshotV1["taskId"],
    runId: "run-1" as RunControlSnapshotV1["runId"],
    runEpoch: 1,
    stateRevision: 2,
    idempotencyKey: "idem-1" as RunControlSnapshotV1["idempotencyKey"],
    grantRefs: [{ grantId: "grt-1" as never, grantScope: "task" }],
    recoveryRef: { outcome: "absent" },
    pendingQuestion: { outcome: "absent" },
  };
}

function decideRequest(): RuntimeGovernanceRequestV1 {
  return {
    operation: "decide",
    taskId: "task-1" as RuntimeGovernanceRequestV1["taskId"],
    runId: "run-1" as RuntimeGovernanceRequestV1["runId"],
    workspaceId: "ws-1" as RuntimeGovernanceRequestV1["workspaceId"],
    stateRevision: 2,
    idempotencyKey: "idem-1" as RuntimeGovernanceRequestV1["idempotencyKey"],
    actionKind: "vetted-command",
    requestedGrantScope: "once",
  };
}

describe("validateRunControlSnapshotV1", () => {
  it("accepts a snapshot with grants and explicit absent facts", () => {
    expect(validateRunControlSnapshotV1(snapshot())).toMatchObject({ ok: true });
  });

  it("accepts an explicit empty grant set", () => {
    expect(validateRunControlSnapshotV1({ ...snapshot(), grantRefs: [] })).toMatchObject({
      ok: true,
    });
  });

  it("rejects a negative epoch and a non-array grant set", () => {
    expect(validateRunControlSnapshotV1({ ...snapshot(), runEpoch: -1 }).ok).toBe(false);
    expect(validateRunControlSnapshotV1({ ...snapshot(), grantRefs: {} }).ok).toBe(false);
  });

  it("rejects a pending question fact that omits its tagged outcome", () => {
    expect(
      validateRunControlSnapshotV1({ ...snapshot(), pendingQuestion: { questionId: "que_1" } }).ok,
    ).toBe(false);
  });

  it("rejects a recovery ref value on an absent outcome", () => {
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        recoveryRef: { outcome: "absent", value: "handle" },
      }).ok,
    ).toBe(false);
  });
});

describe("validateRuntimeGovernanceRequestV1", () => {
  it("accepts a decide request with an action and grant scope", () => {
    expect(validateRuntimeGovernanceRequestV1(decideRequest())).toMatchObject({ ok: true });
  });

  it("accepts a lifecycle request without an action", () => {
    const { actionKind: _actionKind, requestedGrantScope: _grantScope, ...rest } = decideRequest();
    void _actionKind;
    void _grantScope;
    expect(validateRuntimeGovernanceRequestV1({ ...rest, operation: "pause" })).toMatchObject({
      ok: true,
    });
  });

  it("rejects an unknown operation", () => {
    expect(validateRuntimeGovernanceRequestV1({ ...decideRequest(), operation: "widen" }).ok).toBe(
      false,
    );
  });

  it("rejects a lifecycle request that smuggles an action field", () => {
    expect(validateRuntimeGovernanceRequestV1({ ...decideRequest(), operation: "stop" }).ok).toBe(
      false,
    );
  });

  it("rejects a decide request with an invalid action kind", () => {
    expect(
      validateRuntimeGovernanceRequestV1({ ...decideRequest(), actionKind: "mine-crypto" }).ok,
    ).toBe(false);
  });
});

describe("validateRuntimeGovernanceOutcomeV1", () => {
  it("accepts a decided outcome", () => {
    const outcome: RuntimeGovernanceOutcomeV1 = {
      kind: "runtime-governance-outcome",
      schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
      status: "decided",
      decision: "approval-required",
    };
    expect(validateRuntimeGovernanceOutcomeV1(outcome)).toMatchObject({ ok: true });
  });

  it("accepts a settled outcome with ordered lifecycle events", () => {
    const outcome: RuntimeGovernanceOutcomeV1 = {
      kind: "runtime-governance-outcome",
      schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
      status: "settled",
      events: [
        { sequence: 0, kind: "mutation-halted", stateRevision: 5 },
        { sequence: 1, kind: "paused", stateRevision: 6 },
      ],
    };
    expect(validateRuntimeGovernanceOutcomeV1(outcome)).toMatchObject({ ok: true });
  });

  it("treats a missing capability as unsupported with a bounded reason", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "unsupported",
        reasonCode: "no-pause-capability",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a decided outcome that carries lifecycle events", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "decided",
        events: [],
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "allowed",
      }).ok,
    ).toBe(false);
  });
});
