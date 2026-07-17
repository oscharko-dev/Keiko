import { describe, expect, it } from "vitest";

import {
  AUXILIARY_CAPABILITIES,
  CODE_TASK_AUXILIARY_SCHEMA_VERSION,
  isCodeTaskChildRunId,
  isCodeTaskPublicDomain,
  isCodeTaskSkillId,
  validateAuxiliaryCapabilityOutcomeV1,
  validateAuxiliaryCapabilityRequestV1,
  type AuxiliaryCapabilityOutcomeV1,
  type AuxiliaryCapabilityRequestV1,
  type AuxiliaryResearchScopeV1,
} from "./code-task-auxiliary.js";

const DIGEST = "a".repeat(64);

function target(): Pick<
  AuxiliaryCapabilityRequestV1,
  "taskId" | "runId" | "workspaceId" | "stateRevision" | "idempotencyKey"
> {
  return {
    taskId: "task-1" as AuxiliaryCapabilityRequestV1["taskId"],
    runId: "run-1" as AuxiliaryCapabilityRequestV1["runId"],
    workspaceId: "ws-1" as AuxiliaryCapabilityRequestV1["workspaceId"],
    stateRevision: 2,
    idempotencyKey: "idem-1" as AuxiliaryCapabilityRequestV1["idempotencyKey"],
  };
}

function researchRequest(): Extract<AuxiliaryCapabilityRequestV1, { capability: "research" }> {
  return {
    ...target(),
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    capability: "research",
    research: {
      grantId: "grant-1" as AuxiliaryResearchScopeV1["grantId"],
      domains: ["developer.mozilla.org", "nodejs.org"],
      expiresAt: "2026-07-17T00:00:00.000Z",
      queryTextDigest: { outcome: "known", value: DIGEST },
    },
  };
}

describe("auxiliary branded-id and domain predicates", () => {
  it("accepts only well-formed skill and child-run ids", () => {
    expect(isCodeTaskSkillId("skl_docs-search@1")).toBe(true);
    expect(isCodeTaskSkillId("skl_docs-search@1.2.3")).toBe(true);
    expect(isCodeTaskSkillId("docs-search@1")).toBe(false);
    expect(isCodeTaskSkillId("skl_docs@")).toBe(false);
    expect(isCodeTaskSkillId(7)).toBe(false);
    expect(isCodeTaskChildRunId("chr_abc-1")).toBe(true);
    expect(isCodeTaskChildRunId("run-1")).toBe(false);
  });

  it("accepts public domains and rejects ip literals, loopback, and schemes", () => {
    expect(isCodeTaskPublicDomain("developer.mozilla.org")).toBe(true);
    expect(isCodeTaskPublicDomain("localhost")).toBe(false);
    expect(isCodeTaskPublicDomain("127.0.0.1")).toBe(false);
    expect(isCodeTaskPublicDomain("::1")).toBe(false);
    expect(isCodeTaskPublicDomain("169.254.169.254")).toBe(false);
    expect(isCodeTaskPublicDomain("https://example.com")).toBe(false);
    expect(isCodeTaskPublicDomain("example.com:8080")).toBe(false);
    expect(isCodeTaskPublicDomain("example")).toBe(false);
    expect(isCodeTaskPublicDomain("EXAMPLE.com")).toBe(false);
  });
});

describe("validateAuxiliaryCapabilityRequestV1", () => {
  it("accepts a well-formed research, skill, and child-agent request", () => {
    expect(validateAuxiliaryCapabilityRequestV1(researchRequest())).toMatchObject({ ok: true });
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...target(),
        schemaVersion: 1,
        capability: "skill",
        skillId: "skl_docs-search@1",
        invocation: "explicit",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...target(),
        schemaVersion: 1,
        capability: "child-agent",
        childRunId: "chr_child-1",
        maxToolCalls: 4,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects an unknown capability", () => {
    expect(
      validateAuxiliaryCapabilityRequestV1({ ...target(), schemaVersion: 1, capability: "mutate" }),
    ).toEqual({ ok: false, errors: ["capability must be research, skill, or child-agent"] });
  });

  it("rejects a research grant with an empty domain list or a private domain", () => {
    const base = researchRequest();
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...base,
        research: { ...base.research, domains: [] },
      }),
    ).toMatchObject({
      ok: false,
      errors: ["researchScope.domains must be a non-empty list of public domains"],
    });
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...base,
        research: { ...base.research, domains: ["127.0.0.1"] },
      }),
    ).toMatchObject({
      ok: false,
      errors: ["researchScope.domains must be a non-empty list of public domains"],
    });
  });

  it("rejects a non-positive child tool budget and a smuggled extra key", () => {
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...target(),
        schemaVersion: 1,
        capability: "child-agent",
        childRunId: "chr_child-1",
        maxToolCalls: 0,
      }),
    ).toEqual({ ok: false, errors: ["maxToolCalls must be a positive integer"] });
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...target(),
        schemaVersion: 1,
        capability: "skill",
        skillId: "skl_docs-search@1",
        invocation: "explicit",
        smuggled: true,
      }),
    ).toEqual({ ok: false, errors: ["auxiliaryRequest.smuggled is not allowed"] });
  });

  it("rejects an invalid target and schema version", () => {
    expect(
      validateAuxiliaryCapabilityRequestV1({
        ...target(),
        runId: "",
        stateRevision: -1,
        schemaVersion: 2,
        capability: "skill",
        skillId: "skl_docs-search@1",
        invocation: "explicit",
      }),
    ).toEqual({
      ok: false,
      errors: [
        "schemaVersion must be the literal 1",
        "runId is invalid",
        "stateRevision must be a non-negative integer",
      ],
    });
  });
});

describe("validateAuxiliaryCapabilityOutcomeV1", () => {
  function accepted(): AuxiliaryCapabilityOutcomeV1 {
    return {
      schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
      status: "accepted",
      capability: "child-agent",
      resultDigest: { outcome: "known", value: DIGEST },
      childResultCount: { outcome: "known", value: 0 },
    };
  }

  it("accepts an accepted outcome with an explicit zero child result count", () => {
    expect(validateAuxiliaryCapabilityOutcomeV1(accepted())).toMatchObject({ ok: true });
  });

  it("accepts every rejected status with a bounded reason code", () => {
    for (const status of ["denied", "unavailable", "limit-reached", "stopped"] as const) {
      expect(
        validateAuxiliaryCapabilityOutcomeV1({
          schemaVersion: 1,
          status,
          capability: "research",
          reasonCode: "policy-denied",
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it("rejects a free-text or secret-shaped reason code", () => {
    expect(
      validateAuxiliaryCapabilityOutcomeV1({
        schemaVersion: 1,
        status: "denied",
        capability: "research",
        reasonCode: "Denied: token sk-abc123",
      }),
    ).toEqual({
      ok: false,
      errors: ["auxiliaryOutcome.reasonCode must be a bounded content-free reason code"],
    });
  });

  it("rejects an accepted outcome that carries a reason code, and a rejected one that carries a result", () => {
    expect(validateAuxiliaryCapabilityOutcomeV1({ ...accepted(), reasonCode: "x" })).toMatchObject({
      ok: false,
    });
    expect(
      validateAuxiliaryCapabilityOutcomeV1({
        schemaVersion: 1,
        status: "denied",
        capability: "research",
        reasonCode: "policy-denied",
        resultDigest: { outcome: "known", value: DIGEST },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a child result count that carries a value on an absent outcome", () => {
    expect(
      validateAuxiliaryCapabilityOutcomeV1({
        ...accepted(),
        childResultCount: { outcome: "absent", value: 1 },
      }),
    ).toMatchObject({ ok: false });
  });

  it("exposes the capability vocabulary", () => {
    expect(AUXILIARY_CAPABILITIES).toEqual(["research", "skill", "child-agent"]);
  });
});
