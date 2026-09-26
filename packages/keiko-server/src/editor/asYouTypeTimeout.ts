// Shared p95 latency budget for editor as-you-type model calls (ADR-0042 D5).
//
// Both the classic completion route (completionRoutes.ts) and the inline-completion route
// (inlineCompletionRoutes.ts) enforce the same 750 ms deadline: a fast FIM/completion call must
// self-cancel past it so the editor never blocks the user's keystroke stream on a slow model. The
// value MUST stay in step across both routes; before KEIKO-0667 it was duplicated as a bare
// literal in two places, and a change to one without the other would have silently split the
// budget for the two entry points.
//
// The value itself is intentionally NOT the subject of KEIKO-0667 (which is about duplication).
// Any change to the number belongs in the separate live-perf smoke gate that owns the budget
// decision (GEN-PERF-LIVE-PERF-SMOKE-002).
export const MODEL_AS_YOU_TYPE_TIMEOUT_MS = 750;
