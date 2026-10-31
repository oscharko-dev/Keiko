// Test-only helpers. Not part of the published surface. The filename underscore +
// the trust-8 dep-cruise rule keep production source from importing this module.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/documentation-manual-proposal";
import {
  htmlManualSourceFingerprintTag,
  htmlManualSourceKindTag,
} from "@oscharko-dev/keiko-contracts/runtime/html-manual-source";
import { persistHtmlManualSourceMetadata } from "./manual-source-metadata.js";
import { addSourceToCapsule } from "./source-lifecycle.js";

import type {
  CapsuleAnswerGroundingPolicy,
  CapsuleContextualRetrievalSettings,
  CapsuleLifecycleState,
  CapsuleOutputMode,
  CapsuleRetrievalEffort,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgePodModelUsePolicy,
  KnowledgeSourceId,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";

import { openKnowledgeStore, type KnowledgeStore } from "./store.js";

export function freshStore(): { readonly store: KnowledgeStore; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "keiko-lk-"));
  const store = openKnowledgeStore({ dbPath: join(dir, "capsules.db") });
  return {
    store,
    cleanup: (): void => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const DEFAULT_EMBEDDING: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:3ff5f7fb35874f7a6b414af6",
};

export interface SampleCapsuleOverrides {
  readonly id?: KnowledgeCapsuleId;
  readonly displayName?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly sourceRoutingInstructions?: string;
  readonly alwaysQuery?: boolean;
  readonly retrievalEffort?: CapsuleRetrievalEffort;
  readonly outputMode?: CapsuleOutputMode;
  readonly answerGroundingPolicy?: CapsuleAnswerGroundingPolicy;
  readonly contextualRetrieval?: CapsuleContextualRetrievalSettings;
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy;
  readonly embeddingModelIdentity?: EmbeddingModelIdentity;
  readonly lifecycleState?: CapsuleLifecycleState;
  readonly storageReference?: string;
}

interface OptionalCapsuleFields {
  readonly description?: string;
  readonly sourceRoutingInstructions?: string;
  readonly alwaysQuery?: boolean;
  readonly contextualRetrieval?: CapsuleContextualRetrievalSettings;
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy;
}

function optionalCapsuleFields(overrides: SampleCapsuleOverrides): OptionalCapsuleFields {
  return {
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.sourceRoutingInstructions !== undefined
      ? { sourceRoutingInstructions: overrides.sourceRoutingInstructions }
      : {}),
    ...(overrides.alwaysQuery !== undefined ? { alwaysQuery: overrides.alwaysQuery } : {}),
    ...(overrides.contextualRetrieval !== undefined
      ? { contextualRetrieval: overrides.contextualRetrieval }
      : {}),
    ...(overrides.modelUsePolicy !== undefined ? { modelUsePolicy: overrides.modelUsePolicy } : {}),
  };
}

interface RequiredCapsuleFields {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly tags: readonly string[];
  readonly retrievalEffort: CapsuleRetrievalEffort;
  readonly outputMode: CapsuleOutputMode;
  readonly answerGroundingPolicy: CapsuleAnswerGroundingPolicy;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly lifecycleState: CapsuleLifecycleState;
  readonly storageReference: string;
}

function requiredCapsuleFields(overrides: SampleCapsuleOverrides): RequiredCapsuleFields {
  return {
    id: (overrides.id ?? ("cap-1" as string)) as KnowledgeCapsuleId,
    displayName: overrides.displayName ?? "Engineering Capsule",
    tags: overrides.tags ?? ["alpha", "beta"],
    retrievalEffort: overrides.retrievalEffort ?? "default",
    outputMode: overrides.outputMode ?? "answers",
    answerGroundingPolicy: overrides.answerGroundingPolicy ?? "require-citations",
    embeddingModelIdentity: overrides.embeddingModelIdentity ?? DEFAULT_EMBEDDING,
    lifecycleState: overrides.lifecycleState ?? "draft",
    storageReference: overrides.storageReference ?? "engineering/capsule-1",
  };
}

export function sampleCapsuleInput(
  overrides: SampleCapsuleOverrides = {},
): RequiredCapsuleFields & OptionalCapsuleFields {
  return { ...requiredCapsuleFields(overrides), ...optionalCapsuleFields(overrides) };
}

export function sampleSourceInput(id: string): {
  readonly id: KnowledgeSourceId;
  readonly displayName: string;
  readonly tags: readonly string[];
  readonly scope: KnowledgeSourceScope;
} {
  return {
    id: id as KnowledgeSourceId,
    displayName: `Source ${id}`,
    tags: [],
    scope: {
      kind: "folder",
      rootPath: "/srv/docs",
      recursive: true,
    },
  };
}

/**
 * Adds an HTML manual source over a folder scope to `capsuleId`, then corrupts its stored change
 * summary as a historical row would be after a healthy public source write.
 */
export function seedCorruptMixedManualSource(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): void {
  const sourceId = "mixed-manual-summary" as KnowledgeSourceId;
  addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "Fixture manual",
    tags: [htmlManualSourceKindTag("html-manual-http"), htmlManualSourceFingerprintTag("fp-mixed")],
    scope: { kind: "folder", rootPath: "/fixture/manual", recursive: true },
  });
  persistHtmlManualSourceMetadata(store, capsuleId, sourceId, {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://manual.example.invalid", pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-mixed",
    proposedPodName: "Fixture manual",
  });
  store._internal.db
    .prepare("UPDATE html_manual_sources SET last_change_summary_json = :bytes")
    .run({ bytes: "{fixture-corrupt" });
}
