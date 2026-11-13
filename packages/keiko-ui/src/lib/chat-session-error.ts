export const DRAFT_ATTACHMENTS_UNSAVED_ERROR = "DRAFT_ATTACHMENTS_UNSAVED";
export const ATTACHMENT_CLEANUP_DEFERRED_ERROR = "ATTACHMENT_CLEANUP_DEFERRED";
export const SKILL_SELECTION_UNAVAILABLE_ERROR = "SKILL_SELECTION_UNAVAILABLE";
// The first use of a model nobody had checked ended with the gateway's refusal (#4351).
export const MODEL_NOT_READY_ERROR = "MODEL_NOT_READY";
// The model did not answer a moment ago, and the not-ready cooldown has not passed yet.
export const MODEL_CHECK_COOLDOWN_ERROR = "MODEL_CHECK_COOLDOWN";
// A Send arrived while the first-use check of the same model is still running.
export const MODEL_CHECKING_ERROR = "MODEL_CHECKING";

export type ChatSessionErrorPresentation =
  | { readonly kind: "none" }
  | { readonly kind: "draft-attachments-unsaved" }
  | { readonly kind: "attachment-cleanup-deferred" }
  | { readonly kind: "skill-selection-unavailable" }
  | { readonly kind: "model-not-ready" }
  | { readonly kind: "model-check-cooldown" }
  | { readonly kind: "model-checking" }
  | { readonly kind: "message"; readonly message: string };

// The session owns content-free machine signals; dynamically loaded presentation surfaces decide
// how to localize them. Unknown errors remain messages so existing opaque/redacted failures keep
// their current rendering behavior.
export function chatSessionErrorPresentation(
  error: string | undefined,
): ChatSessionErrorPresentation {
  if (error === DRAFT_ATTACHMENTS_UNSAVED_ERROR) return { kind: "draft-attachments-unsaved" };
  if (error === undefined) return { kind: "none" };
  if (error === ATTACHMENT_CLEANUP_DEFERRED_ERROR) {
    return { kind: "attachment-cleanup-deferred" };
  }
  if (error === SKILL_SELECTION_UNAVAILABLE_ERROR) return { kind: "skill-selection-unavailable" };
  if (error === MODEL_NOT_READY_ERROR) return { kind: "model-not-ready" };
  if (error === MODEL_CHECK_COOLDOWN_ERROR) return { kind: "model-check-cooldown" };
  if (error === MODEL_CHECKING_ERROR) return { kind: "model-checking" };
  return { kind: "message", message: error };
}
