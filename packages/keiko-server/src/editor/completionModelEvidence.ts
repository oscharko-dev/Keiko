// Content-free audit linkage for governed editor completion model calls (Issue #1199). The record
// carries only model ids, policy/version ids, prompt hash, item counts, and Gateway usage metadata.
// It never persists prompts, overlay text, retrieved context, or generated insert text.

import { createHash } from "node:crypto";
import type { CompletionInteractionMode, UsageMetadata } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";

export const EDITOR_COMPLETION_MODEL_EVIDENCE_SCHEMA_VERSION = "1" as const;

export interface EditorCompletionModelEvidenceInput {
  readonly modelId: string;
  readonly modelMode: CompletionInteractionMode;
  readonly latencyClass: string | undefined;
  readonly gatewayPolicyVersion: string;
  readonly promptHash: string;
  readonly itemCount: number;
  readonly truncated: boolean;
  readonly usage: UsageMetadata | undefined;
}

function completionModelEvidenceRunId(
  input: EditorCompletionModelEvidenceInput,
  emittedAtMs: number,
): string {
  const material = [
    input.modelId,
    input.modelMode,
    input.gatewayPolicyVersion,
    input.promptHash,
    String(emittedAtMs),
    input.usage?.requestId ?? "no-gateway-request",
  ].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `editor-completion-model-${digest}`;
}

export function recordEditorCompletionModelEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  input: EditorCompletionModelEvidenceInput,
  emittedAtMs: number,
): string {
  const runId = completionModelEvidenceRunId(input, emittedAtMs);
  const manifest = {
    editorCompletionModelSchemaVersion: EDITOR_COMPLETION_MODEL_EVIDENCE_SCHEMA_VERSION,
    runId,
    emittedAtMs,
    modelId: input.modelId,
    modelMode: input.modelMode,
    latencyClass: input.latencyClass,
    gatewayPolicyVersion: input.gatewayPolicyVersion,
    promptHash: input.promptHash,
    itemCount: input.itemCount,
    truncated: input.truncated,
    ...(input.usage === undefined
      ? {}
      : {
          usage: {
            requestId: input.usage.requestId,
            promptTokens: input.usage.promptTokens,
            completionTokens: input.usage.completionTokens,
            latencyMs: input.usage.latencyMs,
            costClass: input.usage.costClass,
          },
        }),
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Evidence persistence is best-effort; a write failure must not break editing.
  }
  return runId;
}
