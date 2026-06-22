// Server-side rate limiter for the gated model tier of inline completion (Issue #1200; ADR-0042 D5;
// OWASP LLM10:2025 cost control). Inline ghost text is the most frequent model-call surface in the
// editor, so the route bounds how often the model tier may run per workspace root with a per-root
// minimum interval (cooldown) plus a sliding-window cap. When the limit is hit the route SKIPS the
// model tier and returns no ghost text — it never queues, never blocks typing, and degrades to the
// deterministic completion gateway (#1199). This is the request-pacing counterpart to the per-call
// cost ceiling (#1206) enforced by `selectCompletionModel`.
//
// Content-free and deterministic: the limiter is keyed by the (opaque) workspace root and holds only
// timestamps; the clock is injected by the caller so behaviour is fully testable. It is the
// browser-uncontrollable, server-owned half of pacing — the client also debounces (#1200 editor
// bridge) and Monaco cancels superseded requests, but neither is trusted to bound server cost.

export interface InlineCompletionRateLimiterOptions {
  /** Minimum milliseconds between two accepted model invocations for the same root (burst guard). */
  readonly minIntervalMs: number;
  /** Maximum accepted model invocations per root within {@link windowMs}. */
  readonly maxPerWindow: number;
  /** Sliding window length in milliseconds. */
  readonly windowMs: number;
}

export interface InlineCompletionRateLimiter {
  /**
   * Returns true and records the invocation when a model-tier call is allowed for `root` at `nowMs`;
   * returns false (no state change) when the cooldown or window cap is exceeded.
   */
  tryAcquire(root: string, nowMs: number): boolean;
}

// Generous defaults: a 60 ms burst guard sits just below the ~75 ms client debounce so legitimate
// as-you-type traffic is never throttled, while 600 calls/60 s bounds a runaway or abusive client.
// A deployment tunes these via #1206 policy; this layer invents no business budget.
export const DEFAULT_INLINE_RATE_LIMIT: InlineCompletionRateLimiterOptions = {
  minIntervalMs: 60,
  maxPerWindow: 600,
  windowMs: 60_000,
};

interface RootState {
  lastMs: number;
  timestamps: number[];
}

/** Create a per-root inline-completion rate limiter over an injected clock. */
export function createInlineCompletionRateLimiter(
  options: InlineCompletionRateLimiterOptions = DEFAULT_INLINE_RATE_LIMIT,
): InlineCompletionRateLimiter {
  const byRoot = new Map<string, RootState>();
  return {
    tryAcquire(root: string, nowMs: number): boolean {
      const state = byRoot.get(root) ?? { lastMs: Number.NEGATIVE_INFINITY, timestamps: [] };
      // Keep timestamps still inside the sliding window `[nowMs - windowMs, nowMs]`. The left bound
      // is INCLUSIVE (`>=`) so an entry aged exactly `windowMs` still counts against the cap — the
      // conservative choice that never lets one extra call slip through at the exact boundary.
      const windowStart = nowMs - options.windowMs;
      const recent = state.timestamps.filter((ts) => ts >= windowStart);
      if (nowMs - state.lastMs < options.minIntervalMs) {
        // Persist the pruned window without recording a new invocation.
        byRoot.set(root, { lastMs: state.lastMs, timestamps: recent });
        return false;
      }
      if (recent.length >= options.maxPerWindow) {
        byRoot.set(root, { lastMs: state.lastMs, timestamps: recent });
        return false;
      }
      recent.push(nowMs);
      byRoot.set(root, { lastMs: nowMs, timestamps: recent });
      return true;
    },
  };
}
