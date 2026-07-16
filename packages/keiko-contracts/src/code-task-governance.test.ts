import { describe, expect, it } from "vitest";

import {
  CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
  GOVERNED_ACTION_UNGRANTABLE_KINDS,
  isGovernedActionGrantable,
  resolveCodeTaskGrantScope,
  validateCodeTaskExecutionV1,
  validateGovernedActionV1,
  type CodeTaskExecutionV1,
  type GovernedActionActionKind,
  type GovernedActionV1,
} from "./code-task-governance.js";

const DIGEST = "a".repeat(64);
const INSTANT = "2026-07-16T00:00:00.000Z";

function allowedAction(): GovernedActionV1 {
  return {
    kind: "governed-action",
    schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
    taskId: "task-1" as GovernedActionV1["taskId"],
    runId: "run-1" as GovernedActionV1["runId"],
    workspaceId: "ws-1" as GovernedActionV1["workspaceId"],
    stateRevision: 3,
    actionKind: "workspace-edit",
    decision: "allowed",
    grant: { outcome: "known", value: { grantId: "grt-1" as never, grantScope: "task" } },
    question: { outcome: "absent" },
  };
}

function execution(): CodeTaskExecutionV1 {
  return {
    kind: "code-task-execution",
    schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
    taskId: "task-1" as CodeTaskExecutionV1["taskId"],
    runId: "run-1" as CodeTaskExecutionV1["runId"],
    workspaceId: "ws-1" as CodeTaskExecutionV1["workspaceId"],
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    state: "running",
    stateRevision: 2,
    runEpoch: 1,
    objectiveDigest: DIGEST,
    authorityEnvelopeDigest: DIGEST,
    updatedAt: INSTANT,
    failure: { outcome: "absent" },
  };
}

describe("code-task grant scope", () => {
  it("defaults an absent scope to the safe 'once' posture", () => {
    expect(resolveCodeTaskGrantScope(undefined)).toEqual({ ok: true, value: "once" });
  });

  it("accepts the two recognized scopes", () => {
    expect(resolveCodeTaskGrantScope("once")).toEqual({ ok: true, value: "once" });
    expect(resolveCodeTaskGrantScope("task")).toEqual({ ok: true, value: "task" });
  });

  it.each([["forever"], [""], ["ONCE"], [null], [1], [{}]])(
    "fails closed on the unrecognized scope %p instead of downgrading",
    (candidate) => {
      expect(resolveCodeTaskGrantScope(candidate).ok).toBe(false);
    },
  );
});

describe("governed action ungrantable set", () => {
  it.each(GOVERNED_ACTION_UNGRANTABLE_KINDS.map((kind) => [kind] as const))(
    "marks %s as structurally ungrantable",
    (kind) => {
      expect(isGovernedActionGrantable(kind)).toBe(false);
    },
  );

  it.each([["workspace-read"], ["workspace-edit"], ["vetted-command"], ["read-only-research"]])(
    "marks the routine kind %s as grantable",
    (kind) => {
      expect(isGovernedActionGrantable(kind as GovernedActionActionKind)).toBe(true);
    },
  );
});

describe("validateGovernedActionV1", () => {
  it("accepts a well-formed allowed decision carrying a task grant", () => {
    expect(validateGovernedActionV1(allowedAction())).toMatchObject({ ok: true });
  });

  it("rejects an unknown decision", () => {
    expect(validateGovernedActionV1({ ...allowedAction(), decision: "mystery" }).ok).toBe(false);
  });

  it("rejects a grant reference on a denied decision", () => {
    expect(validateGovernedActionV1({ ...allowedAction(), decision: "denied" }).ok).toBe(false);
  });

  it("rejects an allowed decision that carries a pending question instead of a grant", () => {
    expect(
      validateGovernedActionV1({
        ...allowedAction(),
        grant: { outcome: "absent" },
        question: { outcome: "known", value: { questionId: "que_1", expectedRevision: 1 } },
      }).ok,
    ).toBe(false);
  });

  it("rejects a negative revision and an unknown extra key", () => {
    expect(validateGovernedActionV1({ ...allowedAction(), stateRevision: -1 }).ok).toBe(false);
    expect(validateGovernedActionV1({ ...allowedAction(), extra: true }).ok).toBe(false);
  });

  it("accepts an approval-required decision with a bounded question ref", () => {
    expect(
      validateGovernedActionV1({
        ...allowedAction(),
        decision: "approval-required",
        grant: { outcome: "absent" },
        question: { outcome: "known", value: { questionId: "que_x", expectedRevision: 4 } },
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("validateCodeTaskExecutionV1", () => {
  it("accepts a running projection with an absent failure fact", () => {
    expect(validateCodeTaskExecutionV1(execution())).toMatchObject({ ok: true });
  });

  it("rejects a non-digest objective and a bad instant", () => {
    expect(validateCodeTaskExecutionV1({ ...execution(), objectiveDigest: "short" }).ok).toBe(
      false,
    );
    expect(validateCodeTaskExecutionV1({ ...execution(), updatedAt: "yesterday" }).ok).toBe(false);
  });

  it("rejects a failure fact that carries a value on an absent outcome", () => {
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        failure: { outcome: "absent", value: "runtime-failed" },
      }).ok,
    ).toBe(false);
  });

  it("rejects an invalid mode or state", () => {
    expect(validateCodeTaskExecutionV1({ ...execution(), requestedMode: "root" }).ok).toBe(false);
    expect(validateCodeTaskExecutionV1({ ...execution(), state: "sleeping" }).ok).toBe(false);
  });
});
