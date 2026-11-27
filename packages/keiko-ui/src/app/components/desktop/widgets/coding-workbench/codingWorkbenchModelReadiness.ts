import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  electConversationDefault,
  isCodingWorkbenchReadinessCandidate,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";

import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import type { ModelActivationState } from "@/lib/useModelActivation";

// What the Workbench says about a model the server reports as "conversation-not-ready". The server
// uses that one reason for two different facts (ADR-0171 D2, amended 2026-11-16): the model was never
// activated in this process (the normal state after every start), or its readiness check failed.
// `conversationReady` on the catalog tells them apart: absent is "not activated", false is a check
// that did not pass.

export type WorkbenchModelReadiness =
  | { readonly kind: "not-activated"; readonly modelId: string }
  | {
      readonly kind: "check-failed" | "request-failed";
      readonly modelId: string;
    };

/** The model the notice is about: the selected one, else the last used, else Chat's election. */
function noticeModel(
  models: readonly ModelCapability[],
  selectedModelId: string | null,
  savedModelId: string | null,
): ModelCapability | undefined {
  const chat = models.filter(isCodingWorkbenchReadinessCandidate);
  return (
    chat.find((model) => model.id === selectedModelId) ??
    chat.find((model) => model.id === savedModelId) ??
    electConversationDefault(
      chat.filter((model) => model.conversationReady !== true),
      (model) => model.conversationReady,
    )
  );
}

/**
 * The readiness notice for the Workbench's model, or null when the source's reason is not the
 * activation one or the model is in fact activated. A failure of this window's own activation
 * request outranks the catalog, which may not have re-read the verdict yet.
 */
export function workbenchModelReadiness(input: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly models: readonly ModelCapability[];
  readonly savedModelId: string | null;
  readonly activation: ModelActivationState;
}): WorkbenchModelReadiness | null {
  const { state, activation } = input;
  if (state.runtimePreference !== "managed-gateway") return null;
  if (state.source.value?.unavailableReason !== "conversation-not-ready") return null;
  const model = noticeModel(input.models, state.selectedModelId, input.savedModelId);
  if (model === undefined || model.conversationReady === true) return null;
  if (activation.status === "failed" && activation.modelId === model.id) {
    return { kind: activation.failure, modelId: model.id };
  }
  return model.conversationReady === false
    ? { kind: "check-failed", modelId: model.id }
    : { kind: "not-activated", modelId: model.id };
}
