import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  resolveKnowledgePodModelUsePolicy,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  validateKnowledgePodModelUsePolicy,
  type KnowledgePodModelUsePolicy,
} from "./local-knowledge-model-use-policy.js";

describe("Knowledge Pod model-use policy", () => {
  it("defaults legacy pods to a sealed local posture", () => {
    expect(resolveKnowledgePodModelUsePolicy(undefined)).toEqual({
      source: "legacy-default",
      mode: "sealed-local",
      operations: {
        externalEmbeddings: "deny",
        localEmbeddings: "allow",
        externalReranking: "deny",
        localReranking: "allow",
        answerSynthesis: "deny",
        rawContentRelease: "deny",
        evidencePersistence: "allow",
      },
    });
  });

  it("provides explicit sealed and standard policy helpers", () => {
    expect(
      resolveKnowledgePodModelUsePolicy(sealedLocalPodModelUsePolicy()).operations,
    ).toMatchObject({
      externalEmbeddings: "deny",
      externalReranking: "deny",
      answerSynthesis: "deny",
      rawContentRelease: "deny",
    });
    expect(resolveKnowledgePodModelUsePolicy(standardPodModelUsePolicy()).operations).toMatchObject(
      {
        externalEmbeddings: "allow",
        externalReranking: "allow",
        answerSynthesis: "allow",
        rawContentRelease: "allow",
      },
    );
  });

  it("resolves custom inherit decisions from the selected mode", () => {
    const policy: KnowledgePodModelUsePolicy = {
      schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
      mode: "custom",
      operations: {
        externalEmbeddings: "inherit",
        localEmbeddings: "inherit",
        externalReranking: "allow",
        localReranking: "inherit",
        answerSynthesis: "deny",
        rawContentRelease: "inherit",
        evidencePersistence: "inherit",
      },
    };

    expect(resolveKnowledgePodModelUsePolicy(policy)).toMatchObject({
      source: "explicit",
      mode: "custom",
      operations: {
        externalEmbeddings: "deny",
        externalReranking: "allow",
        answerSynthesis: "deny",
        rawContentRelease: "deny",
      },
    });
  });

  it("rejects unsafe extension fields instead of carrying provider material", () => {
    const unsafeFields = [
      "endpoint",
      "apiKey",
      "credentials",
      "baseUrl",
      "rawContent",
      "privatePath",
      "providerConfig",
      "metadata",
    ] as const;

    for (const field of unsafeFields) {
      const result = validateKnowledgePodModelUsePolicy({
        ...standardPodModelUsePolicy(),
        [field]: "https://provider.example.test/v1?api_key=secret",
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid model-use policy");
      expect(result.errors).toContain(`modelUsePolicy must not include ${field}`);
    }
  });

  it("rejects missing operations and non-decision values", () => {
    const result = validateKnowledgePodModelUsePolicy({
      schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
      mode: "sealed-local",
      operations: {
        ...sealedLocalPodModelUsePolicy().operations,
        rawContentRelease: "inherit-unbounded",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid model-use policy");
    expect(result.errors).toContain("modelUsePolicy.operations.rawContentRelease is invalid");
  });
});

import { validateKnowledgePodModelUsePolicy as publicValidatePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
type PolicyAny<T> = 0 extends 1 & T ? true : false;
function consumePublicPolicy(input: unknown): void {
  const result = publicValidatePolicy(input);
  if (result.ok) {
    const schema: "1" = result.value.schemaVersion;
    const mode: "sealed-local" | "standard" | "custom" = result.value.mode;
    const decision: "allow" | "deny" | "inherit" = result.value.operations.rawContentRelease;
    const _concrete: PolicyAny<typeof result.value> = false;
    const _concreteDecision: PolicyAny<typeof result.value.operations.rawContentRelease> = false;
    expect(result.value).toBe(input);
    expect(schema).toBe("1");
    expect(mode).toBe("standard");
    expect(decision).toBe(standardPodModelUsePolicy().operations.rawContentRelease);
  }
}
it("public model policy consumer retains complete operations and references", () => {
  const input = standardPodModelUsePolicy();
  consumePublicPolicy(input);
  const result = publicValidatePolicy(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toBe(input);
  expect(result.value.operations).toBe(input.operations);
  expect(
    publicValidatePolicy({
      ...input,
      operations: { ...input.operations, rawContentRelease: "invalid" },
    }).ok,
  ).toBe(false);
});

describe.each([
  ["source", validateKnowledgePodModelUsePolicy],
  ["public", publicValidatePolicy],
])("%s malformed policy admission", (_surface, validate) => {
  it("refuses a non-record input", () => {
    expect(validate(null)).toEqual({ ok: false, errors: ["modelUsePolicy must be an object"] });
  });
  it("retains schema and mode diagnostics before malformed operations", () => {
    expect(validate({ schemaVersion: "2", mode: "unbounded", operations: null })).toEqual({
      ok: false,
      errors: [
        "modelUsePolicy.schemaVersion is invalid",
        "modelUsePolicy.mode is invalid",
        "modelUsePolicy.operations must be an object",
      ],
    });
  });
  it("refuses the first missing operation", () => {
    expect(validate({ ...standardPodModelUsePolicy(), operations: {} })).toEqual({
      ok: false,
      errors: ["modelUsePolicy.operations.externalEmbeddings is invalid"],
    });
  });
  it("refuses an unknown operations key before a bad decision", () => {
    expect(
      validate({
        ...standardPodModelUsePolicy(),
        operations: {
          ...standardPodModelUsePolicy().operations,
          metadata: false,
          externalEmbeddings: "unbounded",
        },
      }),
    ).toEqual({
      ok: false,
      errors: [
        "modelUsePolicy.operations must not include metadata",
        "modelUsePolicy.operations.externalEmbeddings is invalid",
      ],
    });
  });
});
