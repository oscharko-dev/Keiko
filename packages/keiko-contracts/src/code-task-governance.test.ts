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
import { withPollutedPrototype } from "./code-task-pollution-test-support.js";

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

  // KEIKO-0755: GovernedActionV1.grant / .question are typed as CodeTaskKnownOrAbsentFact — an
  // "unknown" or "unavailable" outcome must be a compile error at the producer, not merely a
  // runtime rejection. Widening the field back to CodeTaskFact makes the directive unused, which
  // fails typecheck.
  it("rejects an unknown grant outcome at compile time (KEIKO-0755)", () => {
    const action: GovernedActionV1 = {
      ...allowedAction(),
      // @ts-expect-error grant must be CodeTaskKnownOrAbsentFact — "unknown" is not permitted.
      grant: { outcome: "unknown" },
    };
    // The runtime validator also rejects (defence-in-depth for a deserialised producer that
    // slipped past the compile-time gate via a JSON parse or `as` cast).
    expect(validateGovernedActionV1(action).ok).toBe(false);
  });

  it("rejects an unavailable question outcome at compile time (KEIKO-0755)", () => {
    const action: GovernedActionV1 = {
      ...allowedAction(),
      decision: "approval-required",
      grant: { outcome: "absent" },
      // @ts-expect-error question must be CodeTaskKnownOrAbsentFact — "unavailable" is not permitted.
      question: { outcome: "unavailable" },
    };
    expect(validateGovernedActionV1(action).ok).toBe(false);
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
    // Round 3 (#2899): the absent branch now collects instead of early-returning, so an own
    // "value" key (itself outside this branch's allowed-key set) is reported both generically, via
    // unknownKeys, and specifically, via the dedicated message -- consistent with the "report every
    // violation" position this whole audit series has taken (see the KEIKO-0302 comments above).
    expect(validateGovernedActionV1({ ...base, grant: { outcome: "absent", value: 1 } })).toEqual({
      ok: false,
      errors: ["grant.value is not allowed", "grant must not carry a value"],
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
    // Round 3 (#2899): same collect-not-early-return shape as the grant case above.
    expect(
      validateGovernedActionV1({ ...approval, question: { outcome: "absent", value: 1 } }),
    ).toEqual({
      ok: false,
      errors: ["question.value is not allowed", "question must not carry a value"],
    });
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
    // KEIKO-0626: a `known` failure fact is only consistent with a failed / recovery-required
    // state. Use "failed" for the known-outcome cases so they exercise the failure-fact validator
    // without also tripping the new state/outcome invariant.
    const withFailure = (failure: unknown): unknown => ({
      ...execution(),
      state: "failed",
      failure,
    });
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
    // KEIKO-0626: absent/unavailable/unknown are only consistent with a non-failure state
    // (default fixture is "running"), so run these cases without the state override.
    const withFailureRunning = (failure: unknown): unknown => ({ ...execution(), failure });
    for (const outcome of ["absent", "unavailable", "unknown"] as const) {
      expect(validateCodeTaskExecutionV1(withFailureRunning({ outcome }))).toMatchObject({
        ok: true,
      });
      // Round 3 (#2899): collects instead of early-returning, same shape as the grant/question
      // cases above -- an own "value" key is reported both generically (unknownKeys) and
      // specifically (the dedicated message).
      expect(validateCodeTaskExecutionV1(withFailureRunning({ outcome, value: "x" }))).toEqual({
        ok: false,
        errors: [
          "failure.value is not allowed",
          `failure must not carry a value for outcome ${outcome}`,
        ],
      });
    }
    expect(validateCodeTaskExecutionV1(withFailureRunning({ outcome: "exploded" }))).toEqual({
      ok: false,
      errors: ["failure.outcome must be known, absent, unavailable, or unknown"],
    });
  });

  // KEIKO-0626: the state and failure outcome must correlate — a "running" state may not carry a
  // known failure; a "failed" or "recovery-required" state may not carry a non-known failure.
  it("rejects state/failure combinations that violate the correlation invariant (KEIKO-0626)", () => {
    const badKnownWhileRunning = validateCodeTaskExecutionV1({
      ...execution(),
      state: "running",
      failure: { outcome: "known", value: "budget-exceeded" },
    });
    expect(badKnownWhileRunning.ok).toBe(false);
    if (!badKnownWhileRunning.ok) {
      expect(
        badKnownWhileRunning.errors.some((error) => error.includes("outcome=known is only valid")),
      ).toBe(true);
    }
    const badAbsentWhileFailed = validateCodeTaskExecutionV1({
      ...execution(),
      state: "failed",
      failure: { outcome: "absent" },
    });
    expect(badAbsentWhileFailed.ok).toBe(false);
    if (!badAbsentWhileFailed.ok) {
      expect(
        badAbsentWhileFailed.errors.some((error) =>
          error.includes("is invalid when state is failed"),
        ),
      ).toBe(true);
    }
    // recovery-required state also requires a known failure.
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        state: "recovery-required",
        failure: { outcome: "absent" },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskExecutionV1({
        ...execution(),
        state: "recovery-required",
        failure: { outcome: "known", value: "budget-exceeded" },
      }).ok,
    ).toBe(true);
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

// Round 3 (#2899): grantRefFactErrors, questionRefFactErrors, and executionFailureFactErrors each
// had an early-return that a test asserting only ok === false cannot distinguish from collect-both
// -- both fail for a fixture with just one problem. Only a fixture with TWO independent problems,
// and an assertion that BOTH specific messages appear, actually pins collect over early-return.
// Proved red-then-green against a temporary early-return sabotage of each branch (see the commit
// this test shipped in for the measurement).
describe("grant/question/failure facts collect every violation instead of stopping at the first (round 3, #2899)", () => {
  it("reports both the disallowed value and the unrelated extra key on an absent grant and question", () => {
    // grantRefFactErrors only runs on the "allowed" decision's grant field (a "denied" decision's
    // grant routes through the stricter isAbsent/absentErrors instead, which requires an exact
    // one-key { outcome: "absent" } and has no "known"/"absent"-with-value branch of its own).
    const grantResult = validateGovernedActionV1({
      ...allowedAction(),
      grant: { outcome: "absent", value: 1, promptText: "leak me" },
    });
    expect(grantResult.ok).toBe(false);
    if (!grantResult.ok) {
      expect(grantResult.errors.some((error) => error.includes("must not carry a value"))).toBe(
        true,
      );
      expect(grantResult.errors.some((error) => error.includes("promptText"))).toBe(true);
    }

    const questionResult = validateGovernedActionV1({
      ...allowedAction(),
      decision: "approval-required",
      grant: { outcome: "absent" },
      question: { outcome: "absent", value: 1, promptText: "leak me" },
    });
    expect(questionResult.ok).toBe(false);
    if (!questionResult.ok) {
      expect(questionResult.errors.some((error) => error.includes("must not carry a value"))).toBe(
        true,
      );
      expect(questionResult.errors.some((error) => error.includes("promptText"))).toBe(true);
    }
  });

  it("reports both the wrapper's extra key and the inner object's invalid fields together", () => {
    const grantResult = validateGovernedActionV1({
      ...allowedAction(),
      grant: {
        outcome: "known",
        value: { grantId: "", grantScope: "forever" },
        promptText: "leak me",
      },
    });
    expect(grantResult.ok).toBe(false);
    if (!grantResult.ok) {
      expect(grantResult.errors.some((error) => error.includes("grant.promptText"))).toBe(true);
      expect(grantResult.errors.some((error) => error.includes("grant.value.grantId"))).toBe(true);
      expect(grantResult.errors.some((error) => error.includes("grant.value.grantScope"))).toBe(
        true,
      );
    }

    const questionResult = validateGovernedActionV1({
      ...allowedAction(),
      decision: "approval-required",
      grant: { outcome: "absent" },
      question: {
        outcome: "known",
        value: { questionId: "bad id", expectedRevision: -1 },
        promptText: "leak me",
      },
    });
    expect(questionResult.ok).toBe(false);
    if (!questionResult.ok) {
      expect(questionResult.errors.some((error) => error.includes("question.promptText"))).toBe(
        true,
      );
      expect(
        questionResult.errors.some((error) => error.includes("question.value.questionId")),
      ).toBe(true);
      expect(
        questionResult.errors.some((error) => error.includes("question.value.expectedRevision")),
      ).toBe(true);
    }
  });

  it("reports both the invalid value and the unrelated extra key on a known failure outcome", () => {
    const withFailure = (failure: unknown): unknown => ({ ...execution(), failure });
    const result = validateCodeTaskExecutionV1(
      withFailure({ outcome: "known", value: "Not Kebab!", promptText: "leak me" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.includes("bounded content-free reason code")),
      ).toBe(true);
      expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
    }
  });

  it("reports both the disallowed value and the unrelated extra key on a non-known failure outcome", () => {
    const withFailure = (failure: unknown): unknown => ({ ...execution(), failure });
    const result = validateCodeTaskExecutionV1(
      withFailure({ outcome: "absent", value: "x", promptText: "leak me" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("must not carry a value"))).toBe(true);
      expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
    }
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

// KfQ 3789776127: for...in enumerates string keys only, so a symbol-keyed property planted on
// Object.prototype is invisible to hasInheritedEnumerableProperty too. Mechanically true, and moot
// under the reading discipline this file now uses: ownField answers ownership via Object.hasOwn,
// which is defined for symbol keys exactly as it is for string keys, so a symbol-keyed inherited
// property is exactly as unreadable through ownField as a string-keyed one -- nothing here ever
// reads a symbol-named contract field in the first place, since every declared field name is a
// string. Not extending hasInheritedEnumerableProperty with a parallel
// Object.getOwnPropertySymbols-up-the-chain sweep: it is belt-and-braces, not the load-bearing
// layer, and a symbol sweep there would harden a check whose own remaining purpose is only to
// reject the common (enumerable, string-keyed) case early and cheaply.

// Codex P1 3789773829, the terminating fix -- ownField (imported from code-task-acceptance.ts) is
// the reading discipline every validator in this file now uses. withPollutedPrototype (imported
// from code-task-pollution-test-support.ts, not reimplemented here: KfQ 3789982967 found a real bug
// in this helper when it was still copy-pasted per file) mirrors code-task-acceptance.test.ts's
// identical helper; see that file's describe block of the same name for why non-enumerable
// pollution is the clean, unconfounded proof of ownField's own contribution. Proved red-then-green
// against a temporary ownField sabotage in the commit this test shipped in.
describe("ownField makes an inherited field unreadable regardless of descriptor shape (Codex P1 3789773829)", () => {
  it("rejects a grant's inherited non-enumerable value on the known branch", () => {
    const payload = { ...allowedAction(), grant: { outcome: "known" } }; // no own "value"
    const result = withPollutedPrototype(
      "value",
      { value: { grantId: "grt-1", grantScope: "task" }, enumerable: false },
      () => validateGovernedActionV1(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a governed action's inherited non-enumerable decision discriminator", () => {
    // Polluted to "allowed" specifically, matching allowedAction()'s already-legitimate grant
    // (known) and question (absent) shape: a weaker fixture (e.g. polluting to "denied") would
    // reject via the grant/question shape mismatch regardless of whether the decision read is
    // correct, proving nothing about ownField specifically (caught empirically before this test
    // shipped -- both a correct and a sabotaged ownField rejected it via that path, uninformative).
    const { decision: _decision, ...withoutDecision } = allowedAction();
    void _decision;
    const result = withPollutedPrototype("decision", { value: "allowed", enumerable: false }, () =>
      validateGovernedActionV1(withoutDecision),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a code-task execution failure's inherited non-enumerable value on the known branch", () => {
    const payload = { ...execution(), failure: { outcome: "known" } }; // no own "value"
    const result = withPollutedPrototype(
      "value",
      { value: "budget-exceeded", enumerable: false },
      () => validateCodeTaskExecutionV1(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("still accepts legitimate input once Object.prototype is restored", () => {
    expect(validateGovernedActionV1(allowedAction())).toMatchObject({ ok: true });
    expect(validateCodeTaskExecutionV1(execution())).toMatchObject({ ok: true });
  });
});

// KfQ 3789983129 (the mirror risk of ownField itself, on the same PR as the ownField rewrite): a
// check whose FALSE branch is "reject" is safe under ownField -- undefined never matches a required
// literal, so it correctly falls through to an error. A check whose FALSE branch is "nothing to
// verify here, skip" is not: undefined-via-inheritance and undefined-via-legitimate-non-applicability
// are indistinguishable to a naive equality check. allowedGrantExclusionErrors had exactly this
// shape: `ownField(grant, "outcome") !== "known"` returning [] treated "outcome cannot be read as
// this grant's own property" identically to "this grant is genuinely not known, nothing to
// exclude-check". Verified by construction before fixing (not by reading): grantRefFactErrors, run
// separately on the same grant object, already rejects this exact shape with its own "grant.outcome
// must be known or absent" message, so validateGovernedActionV1's overall ok:false was never
// actually wrong for this payload -- but allowedGrantExclusionErrors's OWN contribution to that
// result was [], which is what this test pins directly (its specific message), not the overall
// ok:false a sibling check would produce regardless of whether this function does its job.
describe("allowedGrantExclusionErrors rejects an unverifiable outcome instead of skipping (KfQ 3789983129)", () => {
  it("reports the exclusion-specific message even though grantRefFactErrors also rejects the same input", () => {
    const legit = allowedAction();
    const grant = { value: { grantId: "grt-1", grantScope: "task" } }; // no own "outcome"
    const payload = { ...legit, actionKind: "workspace-edit", grant };
    const result = withPollutedPrototype("outcome", { value: "known", enumerable: false }, () =>
      validateGovernedActionV1(payload),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) =>
          error.includes("its own property to evaluate the exclusion rule"),
        ),
      ).toBe(true);
    }
  });
});

// KfQ 3789983164 -- refuted, verified by construction (not by reading). The claim: an inherited
// `decision` is "treated as missing" inside governedActionRefErrors, so the generic fallback runs
// and specific validation is bypassed. governedActionRefErrors is called from EXACTLY one place,
// unconditionally gated: `if (!isOneOf(ownField(value, "decision"), GOVERNED_ACTION_DECISIONS))
// errors.push(...) else errors.push(...governedActionRefErrors(value))`. ownField is a pure
// function of (record, key) with no mutation of `value` between the caller's check and this
// function's own internal `ownField(value, "decision")` read, so by the time
// governedActionRefErrors runs, decision is ALREADY guaranteed to be an own, valid
// GOVERNED_ACTION_DECISIONS member -- the same guarantee validateRuntimeGovernanceRequestV1's
// "operation" and validateRuntimeGovernanceOutcomeV1's "status" have in code-task-run-control.ts,
// which use the identical gate-then-call shape. Built the exact fixture the finding describes
// (decision present ONLY via non-enumerable prototype pollution, allowedAction() otherwise intact)
// and confirmed the result: `{"ok":false,"errors":["decision is invalid"]}` -- the top-level gate
// rejects before governedActionRefErrors is ever invoked; "the generic fallback runs" never
// happens. This is different from 3789983129 above: that function DOES get called with the
// unverifiable value and DOES silently return []; this one is never called with it at all.
describe("governedActionRefErrors's decision read is unreachable-with-undefined (KfQ 3789983164, refuted)", () => {
  it("rejects via the top-level gate, never reaching governedActionRefErrors's fallback", () => {
    const { decision: _decision, ...withoutDecision } = allowedAction();
    void _decision;
    const result = withPollutedPrototype("decision", { value: "allowed", enumerable: false }, () =>
      validateGovernedActionV1(withoutDecision),
    );
    expect(result).toEqual({ ok: false, errors: ["decision is invalid"] });
  });
});
