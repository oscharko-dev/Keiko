import type {
  GroundedAnswer,
  LocalKnowledgeGroundedAnswerContextSummary,
  LocalKnowledgeIndexLifecycleSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { KnowledgeCapsule, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { getCapsule, type KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";

export function buildLocalKnowledgeIndexLifecycle(
  capsules: readonly KnowledgeCapsule[],
  capturedAt = Date.now(),
): LocalKnowledgeIndexLifecycleSummary {
  return {
    schemaVersion: "local-knowledge-index-lifecycle-v1",
    capturedAt,
    capsules: capsules
      .map((capsule) => ({ capsuleId: capsule.id, updatedAt: capsule.updatedAt }))
      .sort((a, b) => (String(a.capsuleId) < String(b.capsuleId) ? -1 : 1)),
    stale: false,
  };
}

function staleCapsuleIds(
  store: KnowledgeStore,
  lifecycle: LocalKnowledgeIndexLifecycleSummary,
): readonly KnowledgeCapsuleId[] {
  return lifecycle.capsules
    .filter((stamp) => getCapsule(store, stamp.capsuleId)?.updatedAt !== stamp.updatedAt)
    .map((stamp) => stamp.capsuleId);
}

export function refreshLocalKnowledgeIndexLifecycle(
  store: KnowledgeStore,
  lifecycle: LocalKnowledgeIndexLifecycleSummary | undefined,
): LocalKnowledgeIndexLifecycleSummary | undefined {
  if (lifecycle === undefined) return undefined;
  const stale = staleCapsuleIds(store, lifecycle);
  return {
    ...lifecycle,
    stale: stale.length > 0,
    ...(stale.length > 0 ? { staleCapsuleIds: stale } : {}),
  };
}

function refreshContextSummary(
  store: KnowledgeStore,
  summary: LocalKnowledgeGroundedAnswerContextSummary,
): LocalKnowledgeGroundedAnswerContextSummary {
  const indexLifecycle = refreshLocalKnowledgeIndexLifecycle(store, summary.indexLifecycle);
  return indexLifecycle === undefined ? summary : { ...summary, indexLifecycle };
}

export function refreshGroundedAnswerIndexLifecycle(
  store: KnowledgeStore,
  answer: GroundedAnswer,
): GroundedAnswer {
  if (answer.groundingKind === "local-knowledge") {
    return { ...answer, contextPack: refreshContextSummary(store, answer.contextPack) };
  }
  if (answer.groundingKind === "hybrid") {
    return {
      ...answer,
      contextPack: {
        ...answer.contextPack,
        knowledge: refreshContextSummary(store, answer.contextPack.knowledge),
      },
    };
  }
  return answer;
}
