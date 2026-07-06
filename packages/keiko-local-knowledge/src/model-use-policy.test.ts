// Direct unit coverage for the canonical scope-level model-use policy aggregator (#1819,
// child #1917/#1920). The resolver here is the single enforcement path reused by retrieval
// gating, the server BFF, pod summaries, and the UI, so its deny-wins invariant must be
// pinned against mutation rather than only exercised indirectly through summary projection.

import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  type KnowledgeCapsule,
  type KnowledgeCapsuleId,
  type KnowledgePodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";

import { freshStore, sampleCapsuleInput } from "./_support.js";
import { createCapsule, getCapsule } from "./capsule-lifecycle.js";
import {
  isScopeModelUseOperationAllowed,
  resolveCapsuleModelUsePolicy,
  resolveScopeModelUsePolicy,
} from "./model-use-policy.js";

// A deliberately mixed policy: a non-sealed, non-standard posture that still denies one
// external operation. Used to prove custom-mode aggregation and deny-wins compose.
const CUSTOM_POLICY: KnowledgePodModelUsePolicy = {
  schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  mode: "custom",
  operations: {
    externalEmbeddings: "allow",
    localEmbeddings: "allow",
    externalReranking: "deny",
    localReranking: "allow",
    answerSynthesis: "allow",
    rawContentRelease: "allow",
    evidencePersistence: "allow",
  },
};

interface CapsuleSpec {
  readonly id: string;
  readonly policy?: KnowledgePodModelUsePolicy;
}

// Persists each spec through the real capsule lifecycle and hands the loaded capsules to the
// assertion body, so the aggregator is exercised over store-round-tripped policy state (a
// legacy spec omits the policy entirely, mirroring pre-#1819 rows).
function withCapsules(
  specs: readonly CapsuleSpec[],
  run: (capsules: readonly KnowledgeCapsule[]) => void,
): void {
  const env = freshStore();
  try {
    const capsules = specs.map((spec) => {
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: spec.id as KnowledgeCapsuleId,
          ...(spec.policy !== undefined ? { modelUsePolicy: spec.policy } : {}),
        }),
      );
      const capsule = getCapsule(env.store, spec.id as KnowledgeCapsuleId);
      if (capsule === undefined) throw new Error(`capsule ${spec.id} was not created`);
      return capsule;
    });
    run(capsules);
  } finally {
    env.cleanup();
  }
}

function firstOf(capsules: readonly KnowledgeCapsule[]): KnowledgeCapsule {
  const capsule = capsules[0];
  if (capsule === undefined) throw new Error("expected at least one capsule in scope");
  return capsule;
}

describe("resolveCapsuleModelUsePolicy", () => {
  it("resolves an explicit sealed-local capsule to sealed operations", () => {
    withCapsules([{ id: "cap-sealed", policy: sealedLocalPodModelUsePolicy() }], (capsules) => {
      const resolved = resolveCapsuleModelUsePolicy(firstOf(capsules));
      expect(resolved.source).toBe("explicit");
      expect(resolved.mode).toBe("sealed-local");
      expect(resolved.operations.externalEmbeddings).toBe("deny");
      expect(resolved.operations.externalReranking).toBe("deny");
      expect(resolved.operations.answerSynthesis).toBe("deny");
      expect(resolved.operations.rawContentRelease).toBe("deny");
      expect(resolved.operations.localEmbeddings).toBe("allow");
      expect(resolved.operations.localReranking).toBe("allow");
      expect(resolved.operations.evidencePersistence).toBe("allow");
    });
  });

  it("resolves a legacy capsule without a policy to the sealed legacy default", () => {
    withCapsules([{ id: "cap-legacy" }], (capsules) => {
      const resolved = resolveCapsuleModelUsePolicy(firstOf(capsules));
      expect(resolved.source).toBe("legacy-default");
      expect(resolved.mode).toBe("sealed-local");
      expect(resolved.operations.externalEmbeddings).toBe("deny");
      expect(resolved.operations.rawContentRelease).toBe("deny");
    });
  });
});

describe("resolveScopeModelUsePolicy", () => {
  it("returns the sealed legacy default for an empty scope", () => {
    const resolved = resolveScopeModelUsePolicy([]);
    expect(resolved.source).toBe("legacy-default");
    expect(resolved.mode).toBe("sealed-local");
    expect(resolved.operations.externalEmbeddings).toBe("deny");
    expect(resolved.operations.answerSynthesis).toBe("deny");
  });

  it("keeps every operation allowed for an all-standard scope", () => {
    withCapsules(
      [
        { id: "cap-std-a", policy: standardPodModelUsePolicy() },
        { id: "cap-std-b", policy: standardPodModelUsePolicy() },
      ],
      (capsules) => {
        const resolved = resolveScopeModelUsePolicy(capsules);
        expect(resolved.source).toBe("explicit");
        expect(resolved.mode).toBe("standard");
        expect(resolved.operations.externalEmbeddings).toBe("allow");
        expect(resolved.operations.externalReranking).toBe("allow");
        expect(resolved.operations.answerSynthesis).toBe("allow");
        expect(resolved.operations.rawContentRelease).toBe("allow");
      },
    );
  });

  it("denies an operation for the whole scope when any member denies it (deny-wins)", () => {
    // Regression guard: mutating the deny-wins aggregator to require EVERY member to deny would
    // flip these expectations. The sealed member must veto external operations for the whole
    // scope while local-only operations survive.
    withCapsules(
      [
        { id: "cap-sealed", policy: sealedLocalPodModelUsePolicy() },
        { id: "cap-standard", policy: standardPodModelUsePolicy() },
      ],
      (capsules) => {
        const resolved = resolveScopeModelUsePolicy(capsules);
        expect(resolved.mode).toBe("sealed-local");
        expect(resolved.operations.externalEmbeddings).toBe("deny");
        expect(resolved.operations.externalReranking).toBe("deny");
        expect(resolved.operations.answerSynthesis).toBe("deny");
        expect(resolved.operations.rawContentRelease).toBe("deny");
        expect(resolved.operations.localEmbeddings).toBe("allow");
        expect(resolved.operations.localReranking).toBe("allow");
        expect(resolved.operations.evidencePersistence).toBe("allow");
      },
    );
  });

  it("aggregates to custom mode and still applies deny-wins for a standard+custom scope", () => {
    withCapsules(
      [
        { id: "cap-custom", policy: CUSTOM_POLICY },
        { id: "cap-standard", policy: standardPodModelUsePolicy() },
      ],
      (capsules) => {
        const resolved = resolveScopeModelUsePolicy(capsules);
        expect(resolved.mode).toBe("custom");
        expect(resolved.operations.externalReranking).toBe("deny");
        expect(resolved.operations.externalEmbeddings).toBe("allow");
      },
    );
  });

  it("reports legacy-default source and fails closed when any member lacks a policy", () => {
    withCapsules(
      [{ id: "cap-legacy" }, { id: "cap-standard", policy: standardPodModelUsePolicy() }],
      (capsules) => {
        const resolved = resolveScopeModelUsePolicy(capsules);
        expect(resolved.source).toBe("legacy-default");
        expect(resolved.mode).toBe("sealed-local");
        expect(resolved.operations.externalEmbeddings).toBe("deny");
      },
    );
  });
});

describe("isScopeModelUseOperationAllowed", () => {
  it("allows a permitted operation for a standard scope", () => {
    withCapsules([{ id: "cap-standard", policy: standardPodModelUsePolicy() }], (capsules) => {
      expect(isScopeModelUseOperationAllowed(capsules, "externalEmbeddings")).toBe(true);
    });
  });

  it("denies a forbidden operation for a sealed scope", () => {
    withCapsules([{ id: "cap-sealed", policy: sealedLocalPodModelUsePolicy() }], (capsules) => {
      expect(isScopeModelUseOperationAllowed(capsules, "externalEmbeddings")).toBe(false);
    });
  });

  it("allows local operations but denies external ones in a mixed sealed+standard scope", () => {
    withCapsules(
      [
        { id: "cap-sealed", policy: sealedLocalPodModelUsePolicy() },
        { id: "cap-standard", policy: standardPodModelUsePolicy() },
      ],
      (capsules) => {
        expect(isScopeModelUseOperationAllowed(capsules, "localEmbeddings")).toBe(true);
        expect(isScopeModelUseOperationAllowed(capsules, "externalEmbeddings")).toBe(false);
      },
    );
  });
});
