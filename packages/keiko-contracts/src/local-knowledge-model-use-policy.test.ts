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
