// The one live reranker probe. Gateway readiness runs it against the configured reranker; gateway
// setup runs the SAME two-document request against a discovered rerank engine before wiring it, so
// "the endpoint ranks" means exactly one thing on both surfaces.

import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "./deps.js";
import { rerankSelection, type RerankSelection } from "./grounded-rerank-facade.js";

/** The document the probe query matches verbatim: a working reranker returns it first. */
const RERANKER_PROBE_TOP_DOCUMENT = "alpha readiness match";
const RERANKER_PROBE_DOCUMENTS: readonly string[] = [RERANKER_PROBE_TOP_DOCUMENT, "unrelated beta"];

interface RerankerProbeInput {
  readonly deps: UiHandlerDeps;
  /** The config generation the probe reports against; `config.reranker` names the endpoint. */
  readonly config: GatewayConfig;
  readonly correlationId: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function requestRerankerProbe(input: RerankerProbeInput): Promise<RerankSelection<string>> {
  return rerankSelection({
    deps: input.deps,
    gatewayConfig: input.config,
    query: RERANKER_PROBE_TOP_DOCUMENT,
    candidates: RERANKER_PROBE_DOCUMENTS,
    documentFor: (document) => document,
    topN: 1,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    correlationId: input.correlationId,
    fallbackMode: "slice-topN",
  });
}

/** True only when the provider answered AND ranked the matching document first. */
export function rerankerProbePassed(selection: RerankSelection<string>): boolean {
  return (
    selection.diagnostics.status === "applied" &&
    selection.selected[0] === RERANKER_PROBE_TOP_DOCUMENT
  );
}
