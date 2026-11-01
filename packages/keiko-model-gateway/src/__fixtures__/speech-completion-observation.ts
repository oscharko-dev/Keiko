import type { SpeechToTextRequest } from "../speech-to-text-adapter.js";
import type { ModelGatewayLogSink } from "../observability.js";

type SpeechCompletionRequest = Pick<
  SpeechToTextRequest,
  "endpoint" | "modelId" | "log" | "correlationId"
>;

type SpeechCompletionFields = readonly [
  readonly ["endpoint", SpeechCompletionRequest["endpoint"]],
  readonly ["modelId", SpeechCompletionRequest["modelId"]],
  readonly ["log", SpeechCompletionRequest["log"]],
  readonly ["correlationId", SpeechCompletionRequest["correlationId"]],
];

interface SpeechCompletionObservation {
  readonly active: boolean;
  readonly refusedField: "none" | "endpoint" | "modelId";
  readonly failure: Error;
  readonly trace: string[];
  readonly requestReceivers: unknown[];
}

export function observeSpeechCompletionFields(
  request: SpeechCompletionRequest,
  fields: SpeechCompletionFields,
  state: SpeechCompletionObservation,
  isRateLimited: () => boolean,
  malformedEndpoint: SpeechCompletionRequest["endpoint"],
): () => void {
  const originals = fields.map(([key]) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(request, key),
  }));
  for (const [key, value] of fields) {
    Object.defineProperty(request, key, {
      configurable: true,
      get(this: SpeechCompletionRequest): string | ModelGatewayLogSink | undefined {
        if (!state.active) return value;
        state.trace.push(key);
        state.requestReceivers.push(this);
        if (state.refusedField === key) throw state.failure;
        return key === "endpoint" && isRateLimited() ? malformedEndpoint : value;
      },
    });
  }
  return (): void => {
    for (const { key, descriptor } of originals) {
      if (descriptor === undefined) Reflect.deleteProperty(request, key);
      else Object.defineProperty(request, key, descriptor);
    }
  };
}
