// Server-side sliding-window TOKEN ceiling for the editor model tier (Issue #1206; OWASP LLM10:2025
// denial-of-wallet). It complements the per-root request-rate limiter (`inlineCompletionRateLimiter`):
// the rate limiter bounds how OFTEN the model tier may run, while this budget bounds how many TOKENS
// it may consume per workspace root within a sliding window. Together they are the two server-owned
// ceilings the #1206 threat model requires — a maximum requests/window AND a maximum tokens/window.
//
// When the window's accumulated tokens reach the ceiling the route SKIPS the model tier and degrades
// to the deterministic completion gateway (#1199); it never queues, never blocks typing, and never
// returns partial output. The ceiling is shared across the inline and completion model tiers for the
// same root because they draw on one workspace's model spend.
//
// Content-free and deterministic: the budget is keyed by the opaque workspace root and holds only
// (timestamp, token-count) pairs — never a prompt, buffer, or path. The clock is injected by the
// caller so behaviour is fully testable.

import type { UsageMetadata } from "@oscharko-dev/keiko-contracts";

export interface EditorModelTokenBudgetOptions {
  /** Maximum model tokens (prompt + completion) accepted per root within {@link windowMs}. */
  readonly maxTokensPerWindow: number;
  /** Sliding window length in milliseconds. */
  readonly windowMs: number;
}

export interface EditorModelTokenBudget {
  /**
   * Returns true when the tokens already consumed for `root` within the sliding window ending at
   * `nowMs` meet or exceed the ceiling. The route must consult this before invoking the model tier.
   */
  isExhausted(root: string, nowMs: number): boolean;
  /** Records `tokens` consumed by an accepted model call for `root` at `nowMs`. */
  record(root: string, nowMs: number, tokens: number): void;
}

// Generous default: bounds a single root to 1,000,000 model tokens per 60 s. That sits well above
// realistic single-developer as-you-type traffic (the 600 requests/60 s rate cap at a few thousand
// tokens per call) yet is a finite denial-of-wallet backstop. A deployment tightens it via #1206
// policy; this layer invents no business budget.
export const DEFAULT_EDITOR_MODEL_TOKEN_BUDGET: EditorModelTokenBudgetOptions = {
  maxTokensPerWindow: 1_000_000,
  windowMs: 60_000,
};

interface BudgetEntry {
  readonly ms: number;
  readonly tokens: number;
}

/** Create a per-root sliding-window token budget over an injected clock. */
export function createEditorModelTokenBudget(
  options: EditorModelTokenBudgetOptions = DEFAULT_EDITOR_MODEL_TOKEN_BUDGET,
): EditorModelTokenBudget {
  const byRoot = new Map<string, BudgetEntry[]>();
  // Prunes entries that have aged out of `[nowMs - windowMs, nowMs]` and stores the pruned list. The
  // left bound is INCLUSIVE (`>=`) so an entry aged exactly `windowMs` still counts — the
  // conservative choice that never lets extra spend slip through at the exact boundary.
  function windowed(root: string, nowMs: number): BudgetEntry[] {
    const windowStart = nowMs - options.windowMs;
    const recent = (byRoot.get(root) ?? []).filter((entry) => entry.ms >= windowStart);
    byRoot.set(root, recent);
    return recent;
  }
  return {
    isExhausted(root: string, nowMs: number): boolean {
      const recent = windowed(root, nowMs);
      const consumed = recent.reduce((sum, entry) => sum + entry.tokens, 0);
      return consumed >= options.maxTokensPerWindow;
    },
    record(root: string, nowMs: number, tokens: number): void {
      if (tokens <= 0) {
        return;
      }
      const recent = windowed(root, nowMs);
      recent.push({ ms: nowMs, tokens });
      byRoot.set(root, recent);
    },
  };
}

// Process-wide default budget: shared so the token ceiling spans requests — and both the inline and
// completion model tiers — within a server lifetime for a given root.
export const sharedEditorModelTokenBudget: EditorModelTokenBudget = createEditorModelTokenBudget();

/**
 * Records the prompt + completion token cost of an elected model call into the budget. A no-op when
 * usage is absent (a degrade/no-model path), so callers record unconditionally after the call.
 */
export function accountModelUsage(
  budget: EditorModelTokenBudget,
  root: string,
  nowMs: number,
  usage: UsageMetadata | undefined,
): void {
  if (usage !== undefined) {
    budget.record(root, nowMs, usage.promptTokens + usage.completionTokens);
  }
}
