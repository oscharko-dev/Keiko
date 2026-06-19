// Server-side sliding-window TOKEN ceiling for the editor model tier (Issue #1206; OWASP LLM10:2025
// denial-of-wallet). It complements the per-root request-rate limiter (`inlineCompletionRateLimiter`):
// the rate limiter bounds how OFTEN the model tier may run, while this budget bounds how many TOKENS
// it may consume per workspace root within a sliding window. Together they are the two server-owned
// ceilings the #1206 threat model requires - a maximum requests/window AND a maximum tokens/window.
//
// Routes reserve a conservative prompt+completion estimate before invoking the provider. Pending
// reservations count immediately, so concurrent requests cannot all pass a check-then-record race.
// When usage metadata arrives it settles the reservation to actual prompt+completion tokens; absent
// usage keeps the conservative reservation. On exceed, the route SKIPS the model tier and degrades to
// the deterministic completion gateway (#1199); it never queues, never blocks typing, and never
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
   * `nowMs` meet or exceed the ceiling.
   */
  isExhausted(root: string, nowMs: number): boolean;
  /** Records `tokens` consumed by an accepted model call for `root` at `nowMs`. */
  record(root: string, nowMs: number, tokens: number): void;
  /**
   * Attempts to reserve `tokens` before a provider call. Returns undefined when adding the
   * reservation would exceed the sliding-window ceiling.
   */
  tryReserve(
    root: string,
    nowMs: number,
    tokens: number,
  ): EditorModelTokenReservation | undefined;
}

export interface EditorModelTokenReservation {
  /** The conservative token estimate that counted before the provider call started. */
  readonly reservedTokens: number;
  /** Replaces the reservation with actual usage when the provider reports it. */
  settle(usage: UsageMetadata | undefined): void;
  /** Removes the reservation when the provider was never invoked. */
  cancel(): void;
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
  tokens: number;
}

const APPROX_CHARS_PER_TOKEN = 4;
type BudgetStore = Map<string, BudgetEntry[]>;

interface PromptForEstimation {
  readonly system: string;
  readonly user: string;
}

function normalizedTokenCount(tokens: number): number {
  if (!Number.isFinite(tokens)) {
    return 0;
  }
  return Math.max(0, Math.ceil(tokens));
}

function usageTokenCount(usage: UsageMetadata): number {
  return normalizedTokenCount(usage.promptTokens + usage.completionTokens);
}

function windowedEntries(
  byRoot: BudgetStore,
  root: string,
  nowMs: number,
  windowMs: number,
): BudgetEntry[] {
  const windowStart = nowMs - windowMs;
  const recent = (byRoot.get(root) ?? []).filter((entry) => entry.ms >= windowStart);
  byRoot.set(root, recent);
  return recent;
}

function entryTokenSum(entries: readonly BudgetEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.tokens, 0);
}

function removeEntry(byRoot: BudgetStore, root: string, entry: BudgetEntry): void {
  const current = byRoot.get(root) ?? [];
  const index = current.indexOf(entry);
  if (index >= 0) {
    current.splice(index, 1);
    byRoot.set(root, current);
  }
}

function createReservation(
  byRoot: BudgetStore,
  root: string,
  entry: BudgetEntry,
  reservedTokens: number,
): EditorModelTokenReservation {
  let active = true;
  return {
    reservedTokens,
    settle(usage: UsageMetadata | undefined): void {
      if (!active || usage === undefined) {
        return;
      }
      entry.tokens = usageTokenCount(usage);
    },
    cancel(): void {
      if (!active) {
        return;
      }
      active = false;
      removeEntry(byRoot, root, entry);
    },
  };
}

/** Create a per-root sliding-window token budget over an injected clock. */
export function createEditorModelTokenBudget(
  options: EditorModelTokenBudgetOptions = DEFAULT_EDITOR_MODEL_TOKEN_BUDGET,
): EditorModelTokenBudget {
  const byRoot: BudgetStore = new Map();
  function consumed(root: string, nowMs: number): number {
    return entryTokenSum(windowedEntries(byRoot, root, nowMs, options.windowMs));
  }
  return {
    isExhausted(root: string, nowMs: number): boolean {
      return consumed(root, nowMs) >= options.maxTokensPerWindow;
    },
    record(root: string, nowMs: number, tokens: number): void {
      const normalized = normalizedTokenCount(tokens);
      if (normalized <= 0) {
        return;
      }
      const recent = windowedEntries(byRoot, root, nowMs, options.windowMs);
      recent.push({ ms: nowMs, tokens: normalized });
      byRoot.set(root, recent);
    },
    tryReserve(root: string, nowMs: number, tokens: number): EditorModelTokenReservation | undefined {
      const normalized = normalizedTokenCount(tokens);
      if (normalized <= 0) {
        return undefined;
      }
      const recent = windowedEntries(byRoot, root, nowMs, options.windowMs);
      if (entryTokenSum(recent) + normalized > options.maxTokensPerWindow) {
        return undefined;
      }
      const entry: BudgetEntry = { ms: nowMs, tokens: normalized };
      recent.push(entry);
      byRoot.set(root, recent);
      return createReservation(byRoot, root, entry, normalized);
    },
  };
}

// Process-wide default budget: shared so the token ceiling spans requests — and both the inline and
// completion model tiers — within a server lifetime for a given root.
export const sharedEditorModelTokenBudget: EditorModelTokenBudget = createEditorModelTokenBudget();

/**
 * Conservative content-free token estimate for reserving capacity before a provider call. The budget
 * stores only the numeric estimate, never prompt text.
 */
export function estimateEditorModelReservationTokens(
  prompt: PromptForEstimation,
  maxOutputTokens: number,
): number {
  const promptTokens = Math.ceil((prompt.system.length + prompt.user.length) / APPROX_CHARS_PER_TOKEN);
  return Math.max(1, promptTokens + normalizedTokenCount(maxOutputTokens));
}

/** Settles a pre-call reservation to actual provider usage when available. */
export function settleModelUsage(
  reservation: EditorModelTokenReservation,
  usage: UsageMetadata | undefined,
): void {
  reservation.settle(usage);
}
