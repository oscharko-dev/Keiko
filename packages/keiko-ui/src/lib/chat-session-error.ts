export const ATTACHMENT_CLEANUP_DEFERRED_ERROR = "ATTACHMENT_CLEANUP_DEFERRED";
export const SKILL_SELECTION_UNAVAILABLE_ERROR = "SKILL_SELECTION_UNAVAILABLE";

export type ChatSessionErrorPresentation =
  | { readonly kind: "none" }
  | { readonly kind: "attachment-cleanup-deferred" }
  | { readonly kind: "skill-selection-unavailable" }
  | { readonly kind: "message"; readonly message: string };

// The session owns content-free machine signals; dynamically loaded presentation surfaces decide
// how to localize them. Unknown errors remain messages so existing opaque/redacted failures keep
// their current rendering behavior.
export function chatSessionErrorPresentation(
  error: string | undefined,
): ChatSessionErrorPresentation {
  if (error === undefined) return { kind: "none" };
  if (error === ATTACHMENT_CLEANUP_DEFERRED_ERROR) {
    return { kind: "attachment-cleanup-deferred" };
  }
  if (error === SKILL_SELECTION_UNAVAILABLE_ERROR) return { kind: "skill-selection-unavailable" };
  return { kind: "message", message: error };
}
