import { describe, expect, it } from "vitest";

import {
  CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
  GOVERNED_ACTION_UNGRANTABLE_KINDS,
  isCodeTaskGrantId,
  isCodeTaskGrantScope,
  isCodeTaskIdempotencyKey,
  isCodeTaskPolicyVersion,
  isCodeTaskQuestionId,
  isCodeTaskRunId,
  isCodeTaskTaskId,
  isCodeTaskWorkspaceId,
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

describe("governed action review-defect regressions (#2386)", () => {
  it("rejects an allowed decision carrying a grant on a structurally ungrantable action kind", () => {
    for (const actionKind of [
      "delivery",
      "authority-widening",
      "dependency-operation",
      "external-file-apply-back",
    ] as const) {
      const result = validateGovernedActionV1({ ...allowedAction(), actionKind });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts an allowed decision on a grantable action kind", () => {
    expect(validateGovernedActionV1({ ...allowedAction(), actionKind: "workspace-edit" }).ok).toBe(
      true,
    );
  });

  it("rejects a smuggled extra key inside grant.value and question.value", () => {
    const smuggledGrant = validateGovernedActionV1({
      ...allowedAction(),
      grant: {
        outcome: "known",
        value: { grantId: "grt-1", grantScope: "task", leaked: "payload" },
      },
    });
    expect(smuggledGrant.ok).toBe(false);
    const smuggledQuestion = validateGovernedActionV1({
      ...allowedAction(),
      decision: "approval-required",
      grant: { outcome: "absent" },
      question: {
        outcome: "known",
        value: { questionId: "que_1", expectedRevision: 1, leaked: "payload" },
      },
    });
    expect(smuggledQuestion.ok).toBe(false);
  });

  it("rejects a secret-shaped or free-text failure reason and accepts a bounded reason code", () => {
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        state: "failed",
        failure: { outcome: "known", value: "ghp_AbCdEf0123456789AbCdEf0123456789AbCd" },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        state: "failed",
        failure: { outcome: "known", value: "Some free text with spaces." },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        state: "failed",
        failure: { outcome: "known", value: "verification-command-failed" },
      }).ok,
    ).toBe(true);
  });
});

// Mutation robustness (#2386): pin the exact fail-closed error vocabulary so a mutated message,
// emptied error list, or weakened predicate cannot slip through as "still rejected somehow".
describe("governance validator mutation robustness (#2386)", () => {
  it("pins every branded-id predicate on both sides of the boundary", () => {
    const opaque = [
      isCodeTaskTaskId,
      isCodeTaskRunId,
      isCodeTaskWorkspaceId,
      isCodeTaskGrantId,
      isCodeTaskIdempotencyKey,
    ];
    for (const predicate of opaque) {
      expect(predicate("run-1")).toBe(true);
      expect(predicate("A".repeat(128))).toBe(true);
      expect(predicate("")).toBe(false);
      expect(predicate("A".repeat(129))).toBe(false);
      expect(predicate(" leading-space")).toBe(false);
      expect(predicate(7)).toBe(false);
      expect(predicate(undefined)).toBe(false);
    }
    expect(isCodeTaskQuestionId("que_1")).toBe(true);
    expect(isCodeTaskQuestionId("run-1")).toBe(false);
    expect(isCodeTaskQuestionId(7)).toBe(false);
    expect(isCodeTaskPolicyVersion("policy-v1")).toBe(true);
    expect(isCodeTaskPolicyVersion("")).toBe(false);
    expect(isCodeTaskPolicyVersion(7)).toBe(false);
    expect(isCodeTaskGrantScope("once")).toBe(true);
    expect(isCodeTaskGrantScope("task")).toBe(true);
    expect(isCodeTaskGrantScope("forever")).toBe(false);
  });

  it("reports the exact envelope violation vocabulary on a governed action", () => {
    const invalid = validateGovernedActionV1({
      ...allowedAction(),
      kind: "other",
      schemaVersion: 2,
      taskId: "",
      runId: 7,
      workspaceId: undefined,
      stateRevision: -1,
      actionKind: "reboot",
      extra: true,
    });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        "governedAction.extra is not allowed",
        "kind must be governed-action",
        "schemaVersion must be the literal 1",
        "taskId is invalid",
        "runId is invalid",
        "workspaceId is invalid",
        "stateRevision must be a non-negative integer",
        "actionKind is invalid",
        "grant is not permitted on a structurally ungrantable action kind",
      ],
    });
    expect(validateGovernedActionV1({ ...allowedAction(), decision: "later" })).toEqual({
      ok: false,
      errors: ["decision is invalid"],
    });
    expect(validateGovernedActionV1("nope")).toEqual({
      ok: false,
      errors: ["governed action must be an object"],
    });
  });

  it("reports the exact grant and question fact vocabulary per decision", () => {
    const base = allowedAction();
    expect(validateGovernedActionV1({ ...base, grant: null })).toEqual({
      ok: false,
      errors: ["grant must be a tagged fact object"],
    });
    expect(validateGovernedActionV1({ ...base, grant: { outcome: "absent", value: 1 } })).toEqual({
      ok: false,
      errors: ["grant must not carry a value"],
    });
    expect(validateGovernedActionV1({ ...base, grant: { outcome: "maybe" } })).toEqual({
      ok: false,
      errors: ["grant.outcome must be known or absent"],
    });
    expect(validateGovernedActionV1({ ...base, grant: { outcome: "known", value: 1 } })).toEqual({
      ok: false,
      errors: ["grant.value must be an object"],
    });
    expect(
      validateGovernedActionV1({
        ...base,
        grant: { outcome: "known", value: { grantId: "", grantScope: "forever", smuggled: 1 } },
      }),
    ).toEqual({
      ok: false,
      errors: [
        "grant.value.smuggled is not allowed",
        "grant.value.grantId is invalid",
        "grant.value.grantScope is invalid",
      ],
    });
    expect(
      validateGovernedActionV1({ ...base, question: { outcome: "known", value: {} } }),
    ).toEqual({
      ok: false,
      errors: ['question must be an explicit { outcome: "absent" } fact'],
    });

    const approval = {
      ...base,
      decision: "approval-required",
      grant: { outcome: "absent" },
      question: { outcome: "known", value: { questionId: "que_1", expectedRevision: 2 } },
    };
    expect(validateGovernedActionV1(approval)).toMatchObject({ ok: true });
    expect(validateGovernedActionV1({ ...approval, question: null })).toEqual({
      ok: false,
      errors: ["question must be a tagged fact object"],
    });
    expect(
      validateGovernedActionV1({ ...approval, question: { outcome: "absent", value: 1 } }),
    ).toEqual({ ok: false, errors: ["question must not carry a value"] });
    expect(validateGovernedActionV1({ ...approval, question: { outcome: "maybe" } })).toEqual({
      ok: false,
      errors: ["question.outcome must be known or absent"],
    });
    expect(
      validateGovernedActionV1({ ...approval, question: { outcome: "known", value: 1 } }),
    ).toEqual({ ok: false, errors: ["question.value must be an object"] });
    expect(
      validateGovernedActionV1({
        ...approval,
        question: {
          outcome: "known",
          value: { questionId: "bad", expectedRevision: -1, smuggled: 1 },
        },
      }),
    ).toEqual({
      ok: false,
      errors: [
        "question.value.smuggled is not allowed",
        "question.value.questionId is invalid",
        "question.value.expectedRevision must be a non-negative integer",
      ],
    });
    expect(
      validateGovernedActionV1({ ...approval, grant: { outcome: "known", value: {} } }),
    ).toEqual({
      ok: false,
      errors: ['grant must be an explicit { outcome: "absent" } fact'],
    });

    const denied = {
      ...base,
      decision: "denied",
      grant: { outcome: "absent" },
      question: { outcome: "absent" },
    };
    expect(validateGovernedActionV1(denied)).toMatchObject({ ok: true });
    expect(validateGovernedActionV1({ ...denied, grant: { outcome: "known" } })).toEqual({
      ok: false,
      errors: ['grant must be an explicit { outcome: "absent" } fact'],
    });
  });

  // KEIKO-0302 follow-on: grantRefFactErrors/questionRefFactErrors validated the INNER
  // grant.value/question.value object's own keys, but never the outer fact wrapper's — so a
  // well-formed known fact padded with an extra field (e.g. free text riding alongside a valid
  // grant) validated and was returned verbatim. Content-free is the entire point of this contract
  // family (see the module header).
  it("rejects a grant or question fact wrapper padded with an extra field", () => {
    const base = allowedAction();
    expect(
      validateGovernedActionV1({
        ...base,
        grant: {
          outcome: "known",
          value: { grantId: "grt-1", grantScope: "task" },
          promptText: "leak me",
        },
      }).ok,
    ).toBe(false);
    expect(
      validateGovernedActionV1({
        ...base,
        decision: "denied",
        grant: { outcome: "absent", promptText: "leak me" },
        question: { outcome: "absent" },
      }).ok,
    ).toBe(false);

    const approval = {
      ...base,
      decision: "approval-required" as const,
      grant: { outcome: "absent" as const },
    };
    expect(
      validateGovernedActionV1({
        ...approval,
        question: {
          outcome: "known",
          value: { questionId: "que_1", expectedRevision: 2 },
          promptText: "leak me",
        },
      }).ok,
    ).toBe(false);
    expect(
      validateGovernedActionV1({
        ...base,
        decision: "denied",
        grant: { outcome: "absent" },
        question: { outcome: "absent", promptText: "leak me" },
      }).ok,
    ).toBe(false);
  });

  it("reports the exact execution projection vocabulary", () => {
    expect(validateCodeTaskExecutionV1(null)).toEqual({
      ok: false,
      errors: ["code-task execution must be an object"],
    });
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        kind: "other",
        schemaVersion: 2,
        taskId: 7,
        runId: "",
        workspaceId: null,
        smuggled: true,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "codeTaskExecution.smuggled is not allowed",
        "kind must be code-task-execution",
        "schemaVersion must be the literal 1",
        "taskId is invalid",
        "runId is invalid",
        "workspaceId is invalid",
      ],
    });
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        requestedMode: "yolo",
        effectiveMode: 7,
        deploymentCeiling: null,
        state: "sleeping",
      }),
    ).toEqual({
      ok: false,
      errors: [
        "requestedMode is invalid",
        "effectiveMode is invalid",
        "deploymentCeiling is invalid",
        "state is invalid",
      ],
    });
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        stateRevision: -1,
        runEpoch: 1.5,
        objectiveDigest: "xyz",
        authorityEnvelopeDigest: 7,
        updatedAt: "yesterday",
      }),
    ).toEqual({
      ok: false,
      errors: [
        "stateRevision must be a non-negative integer",
        "runEpoch must be a non-negative integer",
        "objectiveDigest must be a sha256 digest",
        "authorityEnvelopeDigest must be a sha256 digest",
        "updatedAt must be an ISO-8601 UTC instant",
      ],
    });
  });

  it("pins the four failure-fact outcomes and their value exclusions", () => {
    const withFailure = (failure: unknown): unknown => ({ ...execution(), failure });
    expect(validateCodeTaskExecutionV1(withFailure(null))).toEqual({
      ok: false,
      errors: ["failure must be a tagged fact object"],
    });
    expect(
      validateCodeTaskExecutionV1(withFailure({ outcome: "known", value: "budget-exceeded" })),
    ).toMatchObject({ ok: true });
    expect(
      validateCodeTaskExecutionV1(withFailure({ outcome: "known", value: "Not Kebab!" })),
    ).toEqual({
      ok: false,
      errors: ["failure.value must be a bounded content-free reason code"],
    });
    for (const outcome of ["absent", "unavailable", "unknown"] as const) {
      expect(validateCodeTaskExecutionV1(withFailure({ outcome }))).toMatchObject({ ok: true });
      expect(validateCodeTaskExecutionV1(withFailure({ outcome, value: "x" }))).toEqual({
        ok: false,
        errors: [`failure must not carry a value for outcome ${outcome}`],
      });
    }
    expect(validateCodeTaskExecutionV1(withFailure({ outcome: "exploded" }))).toEqual({
      ok: false,
      errors: ["failure.outcome must be known, absent, unavailable, or unknown"],
    });
  });

  // KEIKO-0302 follow-on: same gap as the grant/question facts above, in this module's third
  // tagged-fact validator.
  it("rejects a failure fact wrapper padded with an extra field", () => {
    const withFailure = (failure: unknown): unknown => ({ ...execution(), failure });
    expect(
      validateCodeTaskExecutionV1(
        withFailure({ outcome: "known", value: "budget-exceeded", promptText: "leak me" }),
      ).ok,
    ).toBe(false);
    expect(
      validateCodeTaskExecutionV1(withFailure({ outcome: "absent", promptText: "leak me" })).ok,
    ).toBe(false);
  });
});

// KfQ Critical on code-task-acceptance.ts's identical unknownKeys (this file mirrors it):
// Object.keys sees only OWN enumerable properties. A value shaped via Object.create(secretHolder)
// can carry every required field as an OWN property -- so its own-key shape is indistinguishable
// from a legitimate input -- while one extra field rides the prototype chain, invisible to
// Object.keys, Object.getOwnPropertyNames, and even an exact-own-property-count check (which is
// what isAbsent's Object.keys(value).length === 1 amounts to). isRecord now rejects any
// non-default prototype outright, and every own-key scan in this file additionally checks
// non-enumerable and symbol-keyed own properties.
describe("prototype-based extra-field smuggling (KfQ Critical)", () => {
  it("rejects a governed action with an extra field reachable only through the prototype", () => {
    const legitimate = allowedAction();
    const hostile = Object.create({ secretApiKey: "sk-leak-me" }) as Record<string, unknown>;
    Object.assign(hostile, legitimate);
    expect(Object.keys(hostile)).toEqual(Object.keys(legitimate));
    expect(hostile.secretApiKey).toBe("sk-leak-me");
    expect(validateGovernedActionV1(hostile).ok).toBe(false);
  });

  it("rejects a code-task execution with an extra field reachable only through the prototype", () => {
    const legitimate = execution();
    const hostile = Object.create({ secretApiKey: "sk-leak-me" }) as Record<string, unknown>;
    Object.assign(hostile, legitimate);
    expect(Object.keys(hostile)).toEqual(Object.keys(legitimate));
    expect(validateCodeTaskExecutionV1(hostile).ok).toBe(false);
  });

  it("rejects an absent-outcome question fact with a non-enumerable or symbol-keyed extra (isAbsent)", () => {
    // isAbsent's own check used to be Object.keys(value).length === 1 -- an own-ENUMERABLE-count
    // assertion that a non-enumerable or symbol-keyed extra field defeats even with the correct,
    // default prototype (isRecord's prototype check does not apply here, unlike the other cases in
    // this block -- this one specifically exercises isAbsent's own getOwnPropertyNames/symbol scan).
    const withHidden: Record<string, unknown> = { outcome: "absent" };
    Object.defineProperty(withHidden, "leaked", { value: "secret", enumerable: false });
    expect(Object.keys(withHidden)).toEqual(["outcome"]); // enumerable-only view looks complete
    const hiddenResult = validateGovernedActionV1({
      ...allowedAction(),
      decision: "denied",
      grant: { outcome: "absent" },
      question: withHidden,
    });
    expect(hiddenResult.ok).toBe(false);

    const withSymbol = { outcome: "absent", [Symbol("leaked")]: "secret" };
    const symbolResult = validateGovernedActionV1({
      ...allowedAction(),
      decision: "denied",
      grant: { outcome: "absent" },
      question: withSymbol,
    });
    expect(symbolResult.ok).toBe(false);
  });

  it("rejects the degenerate Object.create(valid) case with nothing own at all", () => {
    expect(validateGovernedActionV1(Object.create(allowedAction())).ok).toBe(false);
    expect(validateCodeTaskExecutionV1(Object.create(execution())).ok).toBe(false);
  });

  it("rejects a non-enumerable own extra field and a symbol-keyed own extra field", () => {
    const withHidden: Record<string, unknown> = { ...allowedAction() };
    Object.defineProperty(withHidden, "hiddenSecret", { value: "leak", enumerable: false });
    expect(validateGovernedActionV1(withHidden).ok).toBe(false);

    const withSymbol: Record<string, unknown> = { ...execution(), [Symbol("secret")]: "leak" };
    expect(validateCodeTaskExecutionV1(withSymbol).ok).toBe(false);
  });

  it("still accepts ordinary plain-object input", () => {
    expect(validateGovernedActionV1(allowedAction())).toMatchObject({ ok: true });
    expect(validateCodeTaskExecutionV1(execution())).toMatchObject({ ok: true });
  });
});
