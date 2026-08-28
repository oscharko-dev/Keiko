import { describe, expect, it } from "vitest";
import type {
  AuxiliaryCapabilityRequestV1,
  CodeTaskSha256Digest,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  validateAuxiliaryCapabilityOutcomeV1,
  validateAuxiliaryCapabilityRequestV1,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import {
  createServerApprovedSkillCatalog,
  type SkillCatalog,
  type SkillCatalogEntryInput,
} from "./skillCatalog.js";
import {
  createSkillInvocationPort,
  type SkillAuthorityReevaluator,
  type SkillInvocationPortDeps,
  type SkillReevaluationDecision,
} from "./skillInvocationPort.js";

const FIXED_NOW = new Date("2026-07-07T12:00:00.000Z");
const RESULT_DIGEST = "a".repeat(64) as unknown as CodeTaskSha256Digest;
const SKILL_ID = "skl_docs-search@1";

function skillRequest(
  skillId: string,
  invocation: "explicit" | "implicit",
): AuxiliaryCapabilityRequestV1 {
  const result = validateAuxiliaryCapabilityRequestV1({
    taskId: "task-1",
    runId: "run-1986",
    workspaceId: "ws-1",
    stateRevision: 1,
    idempotencyKey: "idem-1",
    schemaVersion: 1,
    capability: "skill",
    skillId,
    invocation,
  });
  if (!result.ok) throw new Error(`invalid fixture: ${result.errors.join(", ")}`);
  return result.value;
}

function catalogWith(implicitAllowed: boolean): SkillCatalog {
  const entries: readonly SkillCatalogEntryInput[] = [
    { skillId: SKILL_ID, implicitAllowed, category: "public-research" },
  ];
  return createServerApprovedSkillCatalog(entries);
}

function reevaluatorOf(decision: SkillReevaluationDecision): SkillAuthorityReevaluator {
  return { reevaluate: (): SkillReevaluationDecision => decision };
}

interface Harness {
  readonly deps: SkillInvocationPortDeps;
  readonly events: readonly CodingWorkbenchRuntimeEvent[];
}

function harness(overrides: Partial<SkillInvocationPortDeps>): Harness {
  const events: CodingWorkbenchRuntimeEvent[] = [];
  const deps: SkillInvocationPortDeps = {
    catalog: overrides.catalog ?? catalogWith(true),
    reevaluator: overrides.reevaluator,
    emitEvent: (event: CodingWorkbenchRuntimeEvent): void => {
      events.push(event);
    },
    now: overrides.now ?? ((): Date => FIXED_NOW),
  };
  return { deps, events };
}

function expectDeniedEvent(
  events: readonly CodingWorkbenchRuntimeEvent[],
  invocation: "explicit" | "implicit",
  auxiliaryOutcome: "denied" | "unavailable",
): void {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error("expected one skill-invoked event");
  expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
  expect(event).toMatchObject({
    kind: "skill-invoked",
    auxiliaryOutcome,
    skillInvocation: invocation,
  });
  // Content-free: the event carries the skill id, the invocation, and the outcome only.
  expect(event.failureSummary).toBeUndefined();
}

describe("createSkillInvocationPort admission", () => {
  it("denies an unapproved skill id and emits a denied audit event", () => {
    const { deps, events } = harness({
      catalog: createServerApprovedSkillCatalog([]),
      reevaluator: reevaluatorOf({ decision: "allowed", resultDigest: RESULT_DIGEST }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(skillRequest(SKILL_ID, "explicit"));
    expect(outcome).toMatchObject({
      status: "denied",
      capability: "skill",
      reasonCode: "skill-not-approved",
    });
    expect(validateAuxiliaryCapabilityOutcomeV1(outcome).ok).toBe(true);
    // Catalog-probing must leave an audit trail, not be invisible on the transcript.
    expectDeniedEvent(events, "explicit", "denied");
  });

  it("denies an unknown version of an approved skill (exact id@version match)", () => {
    const { deps, events } = harness({
      reevaluator: reevaluatorOf({ decision: "allowed", resultDigest: RESULT_DIGEST }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(
      skillRequest("skl_docs-search@2", "explicit"),
    );
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "skill-not-approved" });
    expectDeniedEvent(events, "explicit", "denied");
  });

  it("denies an implicit invocation the skill does not permit but admits it explicitly", () => {
    const allowed = reevaluatorOf({ decision: "allowed", resultDigest: RESULT_DIGEST });
    const implicitDenied = harness({ catalog: catalogWith(false), reevaluator: allowed });
    const implicitOutcome = createSkillInvocationPort(implicitDenied.deps).invoke(
      skillRequest(SKILL_ID, "implicit"),
    );
    expect(implicitOutcome).toMatchObject({
      status: "denied",
      reasonCode: "implicit-not-permitted",
    });
    expectDeniedEvent(implicitDenied.events, "implicit", "denied");
    const explicit = harness({ catalog: catalogWith(false), reevaluator: allowed });
    const explicitOutcome = createSkillInvocationPort(explicit.deps).invoke(
      skillRequest(SKILL_ID, "explicit"),
    );
    expect(explicitOutcome).toMatchObject({ status: "accepted" });
  });

  it("denies a malformed request and a valid non-skill request without emitting", () => {
    const malformed = harness({});
    const malformedOutcome = createSkillInvocationPort(malformed.deps).invoke({
      capability: "skill",
    } as unknown as AuxiliaryCapabilityRequestV1);
    expect(malformedOutcome).toMatchObject({ status: "denied", reasonCode: "malformed-request" });
    expect(malformed.events).toHaveLength(0);
    const childRequest = validateAuxiliaryCapabilityRequestV1({
      taskId: "task-1",
      runId: "run-1986",
      workspaceId: "ws-1",
      stateRevision: 1,
      idempotencyKey: "idem-1",
      schemaVersion: 1,
      capability: "child-agent",
      childRunId: "chr_child-1",
      maxToolCalls: 2,
    });
    expect(childRequest.ok).toBe(true);
    if (!childRequest.ok) return;
    const mismatch = harness({});
    const outcome = createSkillInvocationPort(mismatch.deps).invoke(childRequest.value);
    expect(outcome).toMatchObject({
      status: "denied",
      capability: "skill",
      reasonCode: "capability-mismatch",
    });
    expect(mismatch.events).toHaveLength(0);
  });
});

describe("createSkillInvocationPort authority binding", () => {
  it("binds a denied re-evaluation to a denied outcome and never self-widens", () => {
    const { deps, events } = harness({
      reevaluator: reevaluatorOf({ decision: "denied", reasonCode: "network-denied" }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(skillRequest(SKILL_ID, "explicit"));
    expect(outcome).toMatchObject({
      status: "denied",
      capability: "skill",
      reasonCode: "network-denied",
    });
    expect(outcome.status).not.toBe("accepted");
    expect(validateAuxiliaryCapabilityOutcomeV1(outcome).ok).toBe(true);
    expectDeniedEvent(events, "explicit", "denied");
  });

  it("fails closed to unavailable when the re-evaluator is absent, unavailable, or throws", () => {
    const absent = harness({});
    const absentOutcome = createSkillInvocationPort(absent.deps).invoke(
      skillRequest(SKILL_ID, "explicit"),
    );
    expect(absentOutcome).toMatchObject({
      status: "unavailable",
      reasonCode: "reevaluator-unavailable",
    });
    const reported = harness({
      reevaluator: reevaluatorOf({ decision: "unavailable", reasonCode: "chain-degraded" }),
    });
    const reportedOutcome = createSkillInvocationPort(reported.deps).invoke(
      skillRequest(SKILL_ID, "explicit"),
    );
    expect(reportedOutcome).toMatchObject({ status: "unavailable", reasonCode: "chain-degraded" });
    const thrown = harness({
      reevaluator: {
        reevaluate: (): SkillReevaluationDecision => {
          throw new Error("boom");
        },
      },
    });
    const thrownOutcome = createSkillInvocationPort(thrown.deps).invoke(
      skillRequest(SKILL_ID, "explicit"),
    );
    expect(thrownOutcome).toMatchObject({
      status: "unavailable",
      reasonCode: "reevaluator-unavailable",
    });
    // Each admitted-but-unavailable invocation still surfaces one content-free audit event.
    expectDeniedEvent(absent.events, "explicit", "unavailable");
    expectDeniedEvent(reported.events, "explicit", "unavailable");
    expectDeniedEvent(thrown.events, "explicit", "unavailable");
  });

  it("refuses to accept an allowed decision that carries a malformed result digest", () => {
    const { deps, events } = harness({
      reevaluator: reevaluatorOf({
        decision: "allowed",
        resultDigest: "short" as unknown as CodeTaskSha256Digest,
      }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(skillRequest(SKILL_ID, "explicit"));
    expect(outcome).toMatchObject({ status: "unavailable", reasonCode: "reevaluator-unavailable" });
    expectDeniedEvent(events, "explicit", "unavailable");
  });

  it("replaces a non-content-free re-evaluator reason code with a bounded fallback", () => {
    const { deps } = harness({
      reevaluator: reevaluatorOf({
        decision: "denied",
        reasonCode: "https://evil.example/leak?token=abc",
      }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(skillRequest(SKILL_ID, "explicit"));
    expect(outcome).toMatchObject({ status: "denied", reasonCode: "reevaluation-denied" });
    expect(validateAuxiliaryCapabilityOutcomeV1(outcome).ok).toBe(true);
  });
});

describe("createSkillInvocationPort accepted event", () => {
  it("accepts an allowed invocation with a content-free digest and absent child count", () => {
    const { deps } = harness({
      reevaluator: reevaluatorOf({ decision: "allowed", resultDigest: RESULT_DIGEST }),
    });
    const outcome = createSkillInvocationPort(deps).invoke(skillRequest(SKILL_ID, "explicit"));
    expect(outcome).toMatchObject({
      status: "accepted",
      capability: "skill",
      resultDigest: { outcome: "known", value: RESULT_DIGEST },
      childResultCount: { outcome: "absent" },
    });
    expect(validateAuxiliaryCapabilityOutcomeV1(outcome).ok).toBe(true);
  });

  it("emits the same audited skill-invoked event for explicit and implicit, differing only by invocation", () => {
    const { deps, events } = harness({
      reevaluator: reevaluatorOf({ decision: "allowed", resultDigest: RESULT_DIGEST }),
    });
    const port = createSkillInvocationPort(deps);
    port.invoke(skillRequest(SKILL_ID, "explicit"));
    port.invoke(skillRequest(SKILL_ID, "implicit"));
    expect(events).toHaveLength(2);
    const [first, second] = events;
    if (first === undefined || second === undefined) throw new Error("expected two events");
    for (const event of events) {
      expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
      expect(event).toMatchObject({
        kind: "skill-invoked",
        auxiliaryOutcome: "accepted",
        skillId: SKILL_ID,
      });
    }
    expect(first.skillInvocation).toBe("explicit");
    expect(second.skillInvocation).toBe("implicit");
    expect({ ...first, eventId: "x", skillInvocation: "explicit" }).toEqual({
      ...second,
      eventId: "x",
      skillInvocation: "explicit",
    });
  });
});
