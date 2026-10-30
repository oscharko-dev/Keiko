// Model provision and cost metering for the review evaluation family (Issue #4132). The replay and
// the seed gate obtain their ModelPort from the package's existing offline-versus-live selector
// (`createEvaluationModelProvider`, ADR-0012 D5): a scripted transcript in CI, the gateway only when
// a live run is authorized. They never build a second provider path. Cost is metered from what the
// model actually returned, not from what the pipeline under test claims it spent.

import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { EnvSource, GatewayDeps, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { createEvaluationModelProvider, type EvaluationConfigLoader } from "../model-provider.js";
import type { EvaluationMode } from "../types.js";
import type { ReviewRunCost } from "./types.js";

export interface ReviewModelOptions {
  readonly mode: EvaluationMode;
  readonly modelId: string;
  /** Offline transcripts keyed by case: a pull request number or a seed case id. */
  readonly transcripts?: ReadonlyMap<string, readonly (NormalizedResponse | Error)[]> | undefined;
  readonly configPath?: string | undefined;
  readonly env?: EnvSource | undefined;
  readonly configLoader?: EvaluationConfigLoader | undefined;
  readonly logSink?: GatewayDeps["log"] | undefined;
  /** Replaces the selector, as `EvalRunnerDeps.modelProviderFactory` does for the core suite. */
  readonly factory?:
    ((key: string, mode: EvaluationMode, modelId: string) => ModelPort) | undefined;
}

/** The ModelPort for one case, from the injected factory or the package's provider selector. */
export function resolveReviewModel(key: string, options: ReviewModelOptions): ModelPort {
  if (options.factory !== undefined) return options.factory(key, options.mode, options.modelId);
  return createEvaluationModelProvider({
    mode: options.mode,
    modelId: options.modelId,
    transcript: options.transcripts?.get(key) ?? [],
    configPath: options.configPath,
    env: options.env,
    configLoader: options.configLoader,
    logSink: options.logSink,
  });
}

export interface MeteredModelPort {
  readonly port: ModelPort;
  readonly usage: () => Pick<ReviewRunCost, "modelCalls" | "inputTokens" | "outputTokens">;
}

/** Wraps a ModelPort so every answered call adds its provider-reported token usage. */
export function meterModelPort(inner: ModelPort): MeteredModelPort {
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    port: {
      call: async (request, signal): Promise<NormalizedResponse> => {
        modelCalls += 1;
        const response = await inner.call(request, signal);
        inputTokens += response.usage.promptTokens;
        outputTokens += response.usage.completionTokens;
        return response;
      },
    },
    usage: () => ({ modelCalls, inputTokens, outputTokens }),
  };
}

/** Runs one case against a metered model and returns its result with the measured cost. */
export async function measureReviewCase<Result>(
  model: ModelPort,
  now: () => number,
  run: (port: ModelPort) => Promise<Result>,
): Promise<{ readonly result: Result; readonly cost: ReviewRunCost }> {
  const metered = meterModelPort(model);
  const startedAt = now();
  const result = await run(metered.port);
  return { result, cost: { ...metered.usage(), wallTimeMs: Math.max(0, now() - startedAt) } };
}
