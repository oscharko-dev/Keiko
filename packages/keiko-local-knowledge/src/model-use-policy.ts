import type {
  KnowledgeCapsule,
  KnowledgePodModelUseOperation,
  KnowledgePodModelUsePolicyMode,
  KnowledgePodModelUsePolicySource,
  KnowledgePodResolvedModelUsePolicy,
  KnowledgePodResolvedModelUsePolicyOperations,
} from "@oscharko-dev/keiko-contracts";
import { resolveKnowledgePodModelUsePolicy } from "@oscharko-dev/keiko-contracts";

export type ScopeModelUsePolicy = KnowledgePodResolvedModelUsePolicy;

export function resolveCapsuleModelUsePolicy(
  capsule: KnowledgeCapsule,
): KnowledgePodResolvedModelUsePolicy {
  return resolveKnowledgePodModelUsePolicy(capsule.modelUsePolicy);
}

export function resolveScopeModelUsePolicy(
  capsules: readonly KnowledgeCapsule[],
): ScopeModelUsePolicy {
  if (capsules.length === 0) return resolveKnowledgePodModelUsePolicy(undefined);
  const policies = capsules.map(resolveCapsuleModelUsePolicy);
  return {
    source: aggregatePolicySource(policies),
    mode: aggregatePolicyMode(policies),
    operations: aggregatePolicyOperations(policies),
  };
}

export function isScopeModelUseOperationAllowed(
  capsules: readonly KnowledgeCapsule[],
  operation: KnowledgePodModelUseOperation,
): boolean {
  return resolveScopeModelUsePolicy(capsules).operations[operation] === "allow";
}

function aggregatePolicySource(
  policies: readonly KnowledgePodResolvedModelUsePolicy[],
): KnowledgePodModelUsePolicySource {
  if (policies.every((policy) => policy.source === "explicit")) return "explicit";
  if (policies.every((policy) => policy.source === "sealed-default")) return "sealed-default";
  return "legacy-default";
}

function aggregatePolicyMode(
  policies: readonly KnowledgePodResolvedModelUsePolicy[],
): KnowledgePodModelUsePolicyMode {
  if (policies.some((policy) => policy.mode === "sealed-local")) return "sealed-local";
  if (policies.every((policy) => policy.mode === "standard")) return "standard";
  return "custom";
}

function aggregatePolicyOperations(
  policies: readonly KnowledgePodResolvedModelUsePolicy[],
): KnowledgePodResolvedModelUsePolicyOperations {
  return {
    externalEmbeddings: aggregatePolicyOperation(policies, "externalEmbeddings"),
    localEmbeddings: aggregatePolicyOperation(policies, "localEmbeddings"),
    externalReranking: aggregatePolicyOperation(policies, "externalReranking"),
    localReranking: aggregatePolicyOperation(policies, "localReranking"),
    answerSynthesis: aggregatePolicyOperation(policies, "answerSynthesis"),
    rawContentRelease: aggregatePolicyOperation(policies, "rawContentRelease"),
    evidencePersistence: aggregatePolicyOperation(policies, "evidencePersistence"),
  };
}

function aggregatePolicyOperation(
  policies: readonly KnowledgePodResolvedModelUsePolicy[],
  operation: keyof KnowledgePodResolvedModelUsePolicyOperations,
): KnowledgePodResolvedModelUsePolicyOperations[typeof operation] {
  return policies.some((policy) => policy.operations[operation] === "deny") ? "deny" : "allow";
}
