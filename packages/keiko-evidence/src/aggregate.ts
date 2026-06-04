// Usage/cost aggregation (ADR-0010 D7). aggregateUsage is a PURE fold over model:call:completed
// events; cost-class resolution lives in `@oscharko-dev/keiko-model-gateway` (issue #163) and is
// supplied to the evidence builder through the `EvidenceDeps.costClassResolver` port — the
// evidence package never imports gateway primitives directly. The harness model:call:completed
// event omits costClass by design and we do NOT add it — no harness edit. One model per run is
// assumed (RunManifest.modelId is single-valued); the multi-model caveat is documented in the ADR
// Consequences, not silently mis-aggregated.

import type { HarnessEvent } from "@oscharko-dev/keiko-contracts";
import type { EvidenceUsageTotals } from "./types.js";

export function aggregateUsage(events: readonly HarnessEvent[]): EvidenceUsageTotals {
  let promptTokens = 0;
  let completionTokens = 0;
  let requestCount = 0;
  let totalLatencyMs = 0;
  for (const event of events) {
    if (event.type !== "model:call:completed") {
      continue;
    }
    promptTokens += event.usage.promptTokens;
    completionTokens += event.usage.completionTokens;
    totalLatencyMs += event.usage.latencyMs;
    requestCount += 1;
  }
  return { promptTokens, completionTokens, requestCount, totalLatencyMs };
}
