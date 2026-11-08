import { createHash } from "node:crypto";
import type {
  GroundedAnswer,
  LocalKnowledgeGroundedAnswerContextSummary,
  LocalKnowledgeIndexLifecycleSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { KnowledgeCapsule, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { isKnowledgePodRetrievalActivitySafeText } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-retrieval-activity";

/** Reads the current `updatedAt` of a capsule, or `undefined` when it no longer exists. */
export type CapsuleUpdatedAtLookup = (capsuleId: KnowledgeCapsuleId) => number | undefined;

function safeLifecycleCapsuleId(capsuleId: KnowledgeCapsuleId): KnowledgeCapsuleId {
  const value = String(capsuleId);
  if (isKnowledgePodRetrievalActivitySafeText(value)) return capsuleId;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `capsule-${digest}` as KnowledgeCapsuleId;
}

export function buildLocalKnowledgeIndexLifecycle(
  capsules: readonly KnowledgeCapsule[],
  capturedAt = Date.now(),
): LocalKnowledgeIndexLifecycleSummary {
  return {
    schemaVersion: "local-knowledge-index-lifecycle-v1",
    capturedAt,
    capsules: capsules
      .map((capsule) => ({
        capsuleId: safeLifecycleCapsuleId(capsule.id),
        updatedAt: capsule.updatedAt,
      }))
      .sort((a, b) => (String(a.capsuleId) < String(b.capsuleId) ? -1 : 1)),
    stale: false,
  };
}

function staleCapsuleIds(
  currentUpdatedAt: CapsuleUpdatedAtLookup,
  lifecycle: LocalKnowledgeIndexLifecycleSummary,
): readonly KnowledgeCapsuleId[] {
  return lifecycle.capsules
    .filter((stamp) => currentUpdatedAt(stamp.capsuleId) !== stamp.updatedAt)
    .map((stamp) => stamp.capsuleId);
}

export function refreshLocalKnowledgeIndexLifecycle(
  currentUpdatedAt: CapsuleUpdatedAtLookup,
  lifecycle: LocalKnowledgeIndexLifecycleSummary | undefined,
): LocalKnowledgeIndexLifecycleSummary | undefined {
  if (lifecycle === undefined) return undefined;
  const stale = staleCapsuleIds(currentUpdatedAt, lifecycle);
  return {
    ...lifecycle,
    stale: stale.length > 0,
    ...(stale.length > 0 ? { staleCapsuleIds: stale } : {}),
  };
}

function refreshContextSummary(
  currentUpdatedAt: CapsuleUpdatedAtLookup,
  summary: LocalKnowledgeGroundedAnswerContextSummary,
): LocalKnowledgeGroundedAnswerContextSummary {
  const indexLifecycle = refreshLocalKnowledgeIndexLifecycle(
    currentUpdatedAt,
    summary.indexLifecycle,
  );
  return indexLifecycle === undefined ? summary : { ...summary, indexLifecycle };
}

export function refreshGroundedAnswerIndexLifecycle(
  currentUpdatedAt: CapsuleUpdatedAtLookup,
  answer: GroundedAnswer,
): GroundedAnswer {
  if (answer.groundingKind === "local-knowledge") {
    return { ...answer, contextPack: refreshContextSummary(currentUpdatedAt, answer.contextPack) };
  }
  if (answer.groundingKind === "hybrid") {
    return {
      ...answer,
      contextPack: {
        ...answer.contextPack,
        knowledge: refreshContextSummary(currentUpdatedAt, answer.contextPack.knowledge),
      },
    };
  }
  return answer;
}
