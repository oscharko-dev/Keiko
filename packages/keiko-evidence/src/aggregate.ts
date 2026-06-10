// Usage/cost aggregation (ADR-0010 D7). aggregateUsage is a PURE fold over
// model:call:completed events. Cost-class lookup is injected through
// `EvidenceDeps.costClassResolver`, and the harness event intentionally omits
// costClass. One model per run is assumed; the multi-model caveat is documented
// in the ADR consequences rather than hidden here.

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
