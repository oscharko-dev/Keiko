// Production Model Gateway composition for `PrDescriptionServiceOptions.generation` (#3399 mounts
// #3398's `generatePrDescription`, epic #3384 Frozen Product Decision 8).
//
// Reuses the SAME process-wide Gateway instance cache every other server caller reuses
// (`gateway-instance-cache.ts`, also read by `coding-sidecar-gateway.ts` and
// `local-knowledge-handlers.ts` via `currentGateway`) — never a provider SDK here, never a second
// Gateway. `resolveSnapshot` is deliberately excluded: `prDescriptionPreparation.ts` supplies it
// per call from the admitted request's own snapshot service, never a value composed once here.
//
// Fails closed to `undefined` — never a fabricated or partially-wired generation deps object —
// whenever no gateway config is configured for this deployment. `prDescriptionRoutes.ts` treats
// `undefined` as "the PR-description application service is not configured for this deployment"
// (503 `GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE`), the one closed reason that fallback exists for.

import {
  resolvePrDescriptionBrandingFromConfig,
  type PrDescription,
} from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForRuntimeConfig,
  type RuntimeGatewayConfigSource,
} from "../gateway-instance-cache.js";
import { processServerLogSink } from "../process-log-sink.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";

/**
 * Builds the production `PrDescriptionServiceOptions.generation` value from the process-wide
 * gateway config source (the same `RuntimeGatewayConfig` `deps.gatewayConfig` and
 * `defaultModelPortFactory` already read). Returns `undefined` — a closed, deliberate absence,
 * never a throw — when the deployment has no configured model profile at all, or when the cache
 * cannot resolve a live Gateway for it.
 */
export function createProductionPrDescriptionGeneration(
  runtimeConfig: RuntimeGatewayConfigSource | undefined,
): Omit<PrDescription.PrDescriptionDeps, "resolveSnapshot"> | undefined {
  if (runtimeConfig === undefined) return undefined;
  const config = runtimeConfig.current();
  if (config === undefined) return undefined;
  const gateway = gatewayForRuntimeConfig(runtimeConfig);
  if (gateway === undefined) return undefined;
  return {
    gateway,
    config,
    log: processServerLogSink(),
    branding: resolvePrDescriptionBrandingFromConfig(config),
    // ADR-0173 D3 / AGENTS.md §8: dist-anchored, body-free frames and cause chain only — never the
    // error's own message, which is where a provider response body would otherwise leak.
    errorEvidence: (error: unknown) => ({
      frames: keikoStackFrames(error),
      causeChain: causeChain(error),
    }),
  };
}
