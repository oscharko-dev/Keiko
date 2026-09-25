import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  codingWorkbenchProviderTimeoutMs,
  providerRequestBudgetMs,
  streamRequestBudgetMs,
} from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { MAX_TIMER_DELAY_MS } from "./abort-race.js";

// A route's deadline around a gateway call is a backstop BEHIND the gateway's own end-to-end
// budget, never the budget itself. Armed before the gateway starts its clock, a shorter deadline
// aborts the retry the gateway has just scheduled, so a provider timeout surfaces as a cancellation
// nobody asked for (coding run 23, 2026-09-11 on the Coding Workbench route; the commit draft's
// fixed 300 s backstop under the 600 s buffered attempt, PR #3602 review). The grace lets the
// gateway settle its own timeout or exhausted-retry error first. One derivation for every route
// that awaits a coding-workbench-profiled gateway call.
export const GATEWAY_ROUTE_DEADLINE_GRACE_MS = 1_000;

// An unconfigured model is refused before any provider call; this only bounds that refusal.
export const UNCONFIGURED_MODEL_ROUTE_DEADLINE_MS = 30_000;

type RouteProviderBudgetPolicy = Parameters<typeof providerRequestBudgetMs>[0];

// The routes behind this deadline reach the gateway both ways — the coding sidecar buffers a
// `chat()` answer or reads a `chatStream()`, the commit draft buffers — so the backstop sits behind
// the LONGER of the two budgets: the buffered retry budget and the single streamed read's budget.
// With `maxRetries: 0` the buffered budget is the ten-minute floor while a streamed read is held to
// the thirty-minute stream floor, and a deadline derived from the former cancelled a healthy stream
// the gateway was still reading (PR #3602 review).
function gatewayCallBudgetMs(provider: RouteProviderBudgetPolicy): number {
  return Math.max(providerRequestBudgetMs(provider), streamRequestBudgetMs(provider));
}

export function gatewayRouteDeadlineMs(config: GatewayConfig, modelId: string): number {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  const budget =
    provider === undefined
      ? UNCONFIGURED_MODEL_ROUTE_DEADLINE_MS
      : gatewayCallBudgetMs({
          ...provider,
          timeoutMs: codingWorkbenchProviderTimeoutMs(provider.timeoutMs),
        });
  // Armed with AbortSignal.timeout, which fires at once past 2^31 - 1 ms: an absurd budget must not
  // turn the backstop into an immediate abort.
  return Math.min(budget + GATEWAY_ROUTE_DEADLINE_GRACE_MS, MAX_TIMER_DELAY_MS);
}
