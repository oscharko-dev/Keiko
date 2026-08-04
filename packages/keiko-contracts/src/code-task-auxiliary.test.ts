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
    expect(isCodeTaskPublicDomain("api.localhost")).toBe(false);
    expect(isCodeTaskPublicDomain("localhost.localdomain")).toBe(false);
    expect(isCodeTaskPublicDomain("api.localhost.localdomain")).toBe(false);
    expect(isCodeTaskPublicDomain("127.0.0.1")).toBe(false);
    expect(isCodeTaskPublicDomain("::1")).toBe(false);
    expect(isCodeTaskPublicDomain("169.254.169.254")).toBe(false);
    expect(isCodeTaskPublicDomain("https://example.com")).toBe(false);
    expect(isCodeTaskPublicDomain("example.com:8080")).toBe(false);
    expect(isCodeTaskPublicDomain("example")).toBe(false);
    expect(isCodeTaskPublicDomain("EXAMPLE.com")).toBe(false);
    for (const host of [
      "api.local",
      "api.internal",
      "api.home.arpa",
      "api.test",
      "api.invalid",
      "api.example",
      "api.example.c0m",
    ]) {
      expect(isCodeTaskPublicDomain(host)).toBe(false);
    }
  });

  it("rejects non-canonical IPv4 shorthand and octal forms", () => {
    for (const host of ["127.1", "127.0.1", "0177.0.0.1", "0x7f.0.0.1", "0x7f.1"]) {
      expect(isCodeTaskPublicDomain(host)).toBe(false);
    }
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

// The validator's rejection half is the half that matters: it is the boundary an auxiliary request
// crosses before any authority is derived from it. Every guard below is asserted from its FAILING
// side, and each names the field it rejected so a denial is diagnosable without echoing content.
describe("auxiliary request rejection paths", () => {
  function errorsFor(request: unknown): readonly string[] {
    const result = validateAuxiliaryCapabilityRequestV1(request);
    return result.ok ? [] : result.errors;
  }

  it("rejects every malformed target identifier and names each one", () => {
    const errors = errorsFor({
      ...researchRequest(),
      taskId: "",
      runId: 7,
      workspaceId: null,
      stateRevision: -1,
      idempotencyKey: undefined,
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "taskId is invalid",
        "runId is invalid",
        "workspaceId is invalid",
        "stateRevision must be a non-negative integer",
        "idempotencyKey is invalid",
      ]),
    );
  });

  it("rejects a non-integer or fractional state revision", () => {
    expect(errorsFor({ ...researchRequest(), stateRevision: 1.5 })).toContain(
      "stateRevision must be a non-negative integer",
    );
  });

  it("rejects a research scope that is not an object", () => {
    expect(errorsFor({ ...researchRequest(), research: "developer.mozilla.org" })).toEqual([
      "research scope must be an object",
    ]);
  });

  it("rejects an invalid grant id and a non-UTC expiry", () => {
    const errors = errorsFor({
      ...researchRequest(),
      research: { ...researchRequest().research, grantId: 42, expiresAt: "2026-07-17T00:00:00" },
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "researchScope.grantId is invalid",
        "researchScope.expiresAt must be an ISO-8601 UTC instant",
      ]),
    );
  });

  it("rejects an unparseable expiry that still ends in Z", () => {
    expect(
      errorsFor({
        ...researchRequest(),
        research: { ...researchRequest().research, expiresAt: "not-a-date-at-allZ" },
      }),
    ).toContain("researchScope.expiresAt must be an ISO-8601 UTC instant");
  });

  it.each(["2026-04-31T00:00:00Z", "Jul 31 2026 Z", "2026-07-31 12:00:00 GMT+0000 Z"])(
    "rejects a normalized or non-canonical auxiliary expiry: %s",
    (expiresAt) => {
      expect(
        errorsFor({
          ...researchRequest(),
          research: { ...researchRequest().research, expiresAt },
        }),
      ).toContain("researchScope.expiresAt must be an ISO-8601 UTC instant");
    },
  );

  it("fails an empty domain list closed rather than reading it as unrestricted", () => {
    expect(
      errorsFor({ ...researchRequest(), research: { ...researchRequest().research, domains: [] } }),
    ).toContain("researchScope.domains must be a non-empty list of public domains");
    expect(
      errorsFor({
        ...researchRequest(),
        research: { ...researchRequest().research, domains: "developer.mozilla.org" },
      }),
    ).toContain("researchScope.domains must be a non-empty list of public domains");
  });

  it("rejects a domain list where any single entry is non-public", () => {
    expect(
      errorsFor({
        ...researchRequest(),
        research: {
          ...researchRequest().research,
          domains: ["developer.mozilla.org", "127.0.0.1"],
        },
      }),
    ).toContain("researchScope.domains must be a non-empty list of public domains");
  });

  it("rejects a query digest that is not a tagged fact", () => {
    expect(
      errorsFor({
        ...researchRequest(),
        research: { ...researchRequest().research, queryTextDigest: DIGEST },
      }),
    ).toContain("researchScope.queryTextDigest must be a tagged fact object");
  });

  it("rejects a known digest fact whose value is not a sha256", () => {
    expect(
      errorsFor({
        ...researchRequest(),
        research: {
          ...researchRequest().research,
          queryTextDigest: { outcome: "known", value: "short" },
        },
      }),
    ).toContain("researchScope.queryTextDigest.value is invalid");
  });

  it("rejects an absent-or-unknown digest fact that smuggles a value", () => {
    for (const outcome of ["unknown", "unavailable", "absent"]) {
      expect(
        errorsFor({
          ...researchRequest(),
          research: {
            ...researchRequest().research,
            queryTextDigest: { outcome, value: DIGEST },
          },
        }),
      ).toContain(`researchScope.queryTextDigest must not carry a value for outcome ${outcome}`);
    }
  });

  it("accepts every value-free outcome on the digest fact", () => {
    for (const outcome of ["unknown", "unavailable", "absent"]) {
      expect(
        validateAuxiliaryCapabilityRequestV1({
          ...researchRequest(),
          research: { ...researchRequest().research, queryTextDigest: { outcome } },
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it("rejects an outcome tag outside the closed vocabulary", () => {
    expect(
      errorsFor({
        ...researchRequest(),
        research: {
          ...researchRequest().research,
          queryTextDigest: { outcome: "redacted", value: DIGEST },
        },
      }),
    ).toContain(
      "researchScope.queryTextDigest.outcome must be known, unknown, unavailable, or absent",
    );
  });

  it("rejects a skill request with a malformed id or an unknown invocation", () => {
    const errors = errorsFor({
      ...target(),
      schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
      capability: "skill",
      skillId: "docs-search@1",
      invocation: "inferred",
    });

    expect(errors).toEqual(expect.arrayContaining(["skillId is invalid", "invocation is invalid"]));
  });

  it("rejects a child request with a malformed run id or a non-positive budget", () => {
    const errors = errorsFor({
      ...target(),
      schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
      capability: "child-agent",
      childRunId: "run-1",
      maxToolCalls: 0,
    });

    expect(errors).toEqual(
      expect.arrayContaining(["childRunId is invalid", "maxToolCalls must be a positive integer"]),
    );
  });

  it("rejects an unrecognized capability before inspecting any other field", () => {
    // The discriminant is resolved first, so a bogus capability yields exactly one error and the
    // rest of the payload is never interpreted.
    expect(errorsFor({ ...target(), schemaVersion: 1, capability: "shell" })).toEqual([
      "capability must be research, skill, or child-agent",
    ]);
  });

  it("rejects a non-object request and a wrong schema version", () => {
    expect(errorsFor("research")).toEqual(["auxiliary request must be an object"]);
    expect(errorsFor({ ...researchRequest(), schemaVersion: 2 })).toContain(
      "schemaVersion must be the literal 1",
    );
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(errorsFor({ ...researchRequest(), envelope: { widened: true } })).toEqual(
      expect.arrayContaining([expect.stringContaining("auxiliaryRequest")]),
    );
  });
});
